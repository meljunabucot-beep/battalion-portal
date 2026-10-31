import json
import shutil
import sqlite3
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import settings
from ..auth import hash_password
from ..database import get_db, engine
from ..deps import require_admin
from ..limiter import limiter
from ..models import (
    User, Document, Announcement, Office, AppConfig,
    ALL_ROLES, get_all_offices, get_active_offices,
)
from ..storage_utils import collect_storage_keys, delete_storage_file, file_size, doc_size
from ..templates_setup import templates

router = APIRouter(prefix="/admin")


# ---------------- user management ----------------

@router.get("/users", response_class=HTMLResponse)
def users_page(
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    pending = (
        db.query(User).filter(User.status == "pending")
        .order_by(User.created_at.asc()).all()
    )
    active = (
        db.query(User).filter(User.status == "active")
        .order_by(User.username.asc()).all()
    )
    rejected = (
        db.query(User).filter(User.status == "rejected")
        .order_by(User.username.asc()).all()
    )
    offices = get_active_offices(db)
    return templates.TemplateResponse(request, "admin_users.html", {
        "user": admin,
        "pending": pending,
        "active": active,
        "rejected": rejected,
        "roles": ALL_ROLES,
        "offices": offices,
        "pw_changed": request.query_params.get("pw_changed") == "1",
    })


@router.post("/users/{user_id}/approve")
def approve_user(
    user_id: str,
    role: str = Form(...),
    offices: list[str] = Form(default=[]),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if role not in ALL_ROLES:
        raise HTTPException(400, "Invalid role")
    u = db.query(User).filter(User.id == user_id).first()
    if not u or u.status != "pending":
        raise HTTPException(404)

    active_codes = {
        o.code for o in db.query(Office).filter(Office.active == True).all()
    }
    resolved = [o.lower() for o in offices if o.lower() in active_codes]
    if not resolved:
        resolved = u.offices or []

    u.role = role
    u.offices = resolved if role in ("uploader", "officer") else []
    u.status = "active"
    u.approved_by = admin.username
    u.approved_at = datetime.utcnow()
    db.commit()
    return RedirectResponse("/admin/users", status_code=303)


@router.post("/users/{user_id}/reject")
def reject_user(
    user_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    u = db.query(User).filter(User.id == user_id).first()
    if not u or u.status != "pending":
        raise HTTPException(404)
    u.status = "rejected"
    u.approved_by = admin.username
    u.approved_at = datetime.utcnow()
    db.commit()
    return RedirectResponse("/admin/users", status_code=303)


@router.post("/users/{user_id}/unlock")
def unlock_user(
    user_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404)
    u.failed_attempts = 0
    u.locked_until = None
    db.commit()
    return RedirectResponse("/admin/users", status_code=303)


@router.post("/users/{user_id}/change-password")
def change_user_password(
    user_id: str,
    new_password: str = Form(...),
    confirm_password: str = Form(...),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")

    new_password = new_password.strip()
    if len(new_password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    if new_password != confirm_password:
        raise HTTPException(400, "Passwords do not match")

    u.password_hash = hash_password(new_password)
    u.failed_attempts = 0
    u.locked_until = None
    u.session_version = (u.session_version or 0) + 1
    db.commit()

    return RedirectResponse("/admin/users?pw_changed=1", status_code=303)


@router.post("/users/{user_id}/delete")
def delete_user(
    user_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404)
    if u.username == admin.username:
        raise HTTPException(400, "Cannot delete yourself")
    db.delete(u)
    db.commit()
    return RedirectResponse("/admin/users", status_code=303)
@router.post("/toggle-maintenance")
def toggle_maintenance(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    config = db.query(AppConfig).first()
    if not config:
        config = AppConfig(id=1, maintenance_mode=True)
        db.add(config)
    else:
        config.maintenance_mode = not config.maintenance_mode
    db.commit()
    return RedirectResponse("/admin", status_code=303)

# ---------------- office management ----------------

@router.get("/offices", response_class=HTMLResponse)
def offices_page(
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    offices = get_all_offices(db)
    return templates.TemplateResponse(request, "admin_offices.html", {
        "user": admin,
        "offices": offices,
    })


@router.post("/offices/add")
def add_office(
    code: str = Form(...),
    name: str = Form(...),
    sort_order: int = Form(0),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    code = code.strip().lower()
    if not code or not all(c.isalnum() or c in "-_" for c in code):
        raise HTTPException(400, "Code must be alphanumeric (dashes/underscores allowed)")

    if db.query(Office).filter(Office.code == code).first():
        raise HTTPException(400, f"Office code '{code}' already exists")

    o = Office(code=code, name=name.strip(), sort_order=sort_order, active=True)
    db.add(o)
    db.commit()
    return RedirectResponse("/admin/offices", status_code=303)


@router.post("/offices/{office_id}/update")
def update_office(
    office_id: str,
    name: str = Form(...),
    sort_order: int = Form(0),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    o = db.query(Office).filter(Office.id == office_id).first()
    if not o:
        raise HTTPException(404)
    o.name = name.strip()
    o.sort_order = sort_order
    db.commit()
    return RedirectResponse("/admin/offices", status_code=303)


@router.post("/offices/{office_id}/toggle")
def toggle_office(
    office_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    o = db.query(Office).filter(Office.id == office_id).first()
    if not o:
        raise HTTPException(404)
    o.active = not o.active
    db.commit()
    return RedirectResponse("/admin/offices", status_code=303)


@router.post("/offices/{office_id}/delete")
def delete_office(
    office_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    o = db.query(Office).filter(Office.id == office_id).first()
    if not o:
        raise HTTPException(404)

    code = o.code

    users = db.query(User).all()
    users_using = [u.username for u in users if u.offices and code in u.offices]
    if users_using:
        raise HTTPException(
            400,
            f"Cannot delete: {len(users_using)} user(s) still belong to this office "
            f"({', '.join(users_using[:3])}{'...' if len(users_using) > 3 else ''}). "
            "Deactivate it instead."
        )

    origin_docs = db.query(Document).filter(Document.origin_office == code).count()
    all_docs = db.query(Document).all()
    routed_docs = sum(1 for d in all_docs if d.route_chain and code in d.route_chain)

    if origin_docs > 0 or routed_docs > 0:
        raise HTTPException(
            400,
            f"Cannot delete: {origin_docs} document(s) originate from this office "
            f"and {routed_docs} are routed through it. Deactivate it instead."
        )

    db.delete(o)
    db.commit()
    return RedirectResponse("/admin/offices", status_code=303)


# ---------------- FILE MANAGER ----------------

def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _month_label(yyyymm: str) -> str:
    """'2026-10' → 'October 2026'"""
    try:
        y, m = yyyymm.split("-")
        return datetime(int(y), int(m), 1).strftime("%B %Y")
    except Exception:
        return yyyymm


@router.get("/files", response_class=HTMLResponse)
def files_page(
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    selected_month = request.query_params.get("month") or None
    selected_office = (request.query_params.get("office") or "ALL").strip()
    deleted_count = request.query_params.get("deleted")
    freed_human = request.query_params.get("freed")

    # List of months that have documents, newest first
    month_rows = (
        db.query(
            func.strftime("%Y-%m", Document.created_at).label("m"),
            func.count(Document.id).label("c"),
        )
        .group_by("m")
        .order_by(func.strftime("%Y-%m", Document.created_at).desc())
        .all()
    )
    months = [{"value": r.m, "label": _month_label(r.m), "count": r.c}
              for r in month_rows if r.m]

    # Default to the newest month with data
    if not selected_month and months:
        selected_month = months[0]["value"]

    query = db.query(Document)
    if selected_month:
        query = query.filter(
            func.strftime("%Y-%m", Document.created_at) == selected_month
        )
    if selected_office and selected_office != "ALL":
        query = query.filter(Document.origin_office == selected_office)

    docs = query.order_by(Document.created_at.desc()).all()

    # Compute sizes once
    items = []
    total_bytes = 0
    for d in docs:
        sz = doc_size(d)
        total_bytes += sz
        items.append({
            "doc": d,
            "size": sz,
            "size_human": _human_size(sz),
        })

    offices = get_all_offices(db)

    return templates.TemplateResponse(request, "admin_files.html", {
        "user": admin,
        "items": items,
        "months": months,
        "offices": offices,
        "selected_month": selected_month,
        "selected_office": selected_office,
        "total_count": len(items),
        "total_bytes": total_bytes,
        "total_human": _human_size(total_bytes),
        "deleted_count": int(deleted_count) if (deleted_count or "").isdigit() else None,
        "freed_human": freed_human or None,
    })


@router.post("/files/delete")
def delete_files(
    request: Request,
    doc_ids: list[str] = Form(default=[]),
    month: str = Form(""),
    office: str = Form(""),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not doc_ids:
        raise HTTPException(400, "No documents selected")

    docs = db.query(Document).filter(Document.id.in_(doc_ids)).all()

    # Collect every storage key and total size BEFORE deleting rows
    keys_to_delete: set[str] = set()
    total_bytes = 0
    for d in docs:
        ks = collect_storage_keys(d)
        keys_to_delete.update(ks)
        total_bytes += sum(file_size(k) for k in ks)

    # Delete DB rows first, then clean up files
    for d in docs:
        db.delete(d)
    db.commit()

    for k in keys_to_delete:
        delete_storage_file(k)

    print(f"[admin] {admin.username} deleted {len(docs)} document(s), "
          f"freed {total_bytes} bytes")

    # Redirect back to the same filtered view
    parts = []
    if month:
        parts.append(f"month={month}")
    if office and office != "ALL":
        parts.append(f"office={office}")
    parts.append(f"deleted={len(docs)}")
    parts.append(f"freed={_human_size(total_bytes)}")

    return RedirectResponse(f"/admin/files?{'&'.join(parts)}", status_code=303)


@router.post("/files/delete-month")
def delete_month(
    request: Request,
    month: str = Form(...),
    confirm: str = Form(...),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if confirm.strip().upper() != "DELETE":
        raise HTTPException(400, "Confirmation phrase must be exactly: DELETE")

    docs = (
        db.query(Document)
        .filter(func.strftime("%Y-%m", Document.created_at) == month)
        .all()
    )
    if not docs:
        return RedirectResponse(f"/admin/files?month={month}", status_code=303)

    keys_to_delete: set[str] = set()
    total_bytes = 0
    for d in docs:
        ks = collect_storage_keys(d)
        keys_to_delete.update(ks)
        total_bytes += sum(file_size(k) for k in ks)

    for d in docs:
        db.delete(d)
    db.commit()

    for k in keys_to_delete:
        delete_storage_file(k)

    print(f"[admin] {admin.username} deleted ENTIRE MONTH {month}: "
          f"{len(docs)} document(s), freed {total_bytes} bytes")

    return RedirectResponse(
        f"/admin/files?deleted={len(docs)}&freed={_human_size(total_bytes)}",
        status_code=303,
    )


# ---------------- backup helpers ----------------

def _db_path() -> Path:
    url = settings.database_url
    if not url.startswith("sqlite:"):
        raise HTTPException(400, "Backup is only supported for SQLite backends")
    path = url.replace("sqlite:///", "", 1)
    return Path(path).resolve()


def _backup_dir() -> Path:
    p = Path(settings.storage_dir).resolve().parent / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---------------- DB-only backup ----------------

@router.get("/backup/db")
@limiter.limit("10/minute")
def download_db(
    request: Request,
    admin: User = Depends(require_admin),
):
    src = _db_path()
    if not src.exists():
        raise HTTPException(404, "Database file not found")

    tmp = src.parent / f".backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.db"

    try:
        src_conn = sqlite3.connect(str(src))
        dst_conn = sqlite3.connect(str(tmp))
        with dst_conn:
            src_conn.backup(dst_conn)
        dst_conn.close()
        src_conn.close()
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise HTTPException(500, f"Backup failed: {e}")

    size = tmp.stat().st_size
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"battalion_portal_db_{timestamp}.db"

    def iter_file():
        try:
            with open(tmp, "rb") as f:
                while chunk := f.read(64 * 1024):
                    yield chunk
        finally:
            tmp.unlink(missing_ok=True)

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Length": str(size),
        "X-Backup-Size": _human_size(size),
    }
    return StreamingResponse(iter_file(), media_type="application/octet-stream", headers=headers)


# ---------------- storage-only backup ----------------

@router.get("/backup/storage")
@limiter.limit("5/minute")
def download_storage(
    request: Request,
    admin: User = Depends(require_admin),
):
    src = Path(settings.storage_dir).resolve()
    if not src.exists() or not src.is_dir():
        raise HTTPException(404, "Storage directory not found")

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"battalion_portal_storage_{timestamp}.zip"
    tmp = _backup_dir() / f".stream_{timestamp}.zip"

    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for path in src.rglob("*"):
                if not path.is_file():
                    continue
                name = path.name
                if name.startswith(".storage_backup_") or name.startswith(".backup_"):
                    continue
                arcname = path.relative_to(src)
                zf.write(path, arcname)
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise HTTPException(500, f"Archive failed: {e}")

    size = tmp.stat().st_size

    def iter_zip():
        try:
            with open(tmp, "rb") as f:
                while chunk := f.read(256 * 1024):
                    yield chunk
        finally:
            tmp.unlink(missing_ok=True)

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Length": str(size),
        "X-Backup-Size": _human_size(size),
    }
    return StreamingResponse(iter_zip(), media_type="application/zip", headers=headers)


# ---------------- FULL system backup ----------------

@router.get("/backup/full")
@limiter.limit("3/minute")
def download_full_backup(
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"battalion_full_backup_{timestamp}.zip"
    tmp = _backup_dir() / f".stream_full_{timestamp}.zip"

    db_path = _db_path()
    storage_path = Path(settings.storage_dir).resolve()

    if not db_path.exists():
        raise HTTPException(404, "Database file not found")

    snapshot = _backup_dir() / f".snap_{timestamp}.db"
    try:
        src_conn = sqlite3.connect(str(db_path))
        dst_conn = sqlite3.connect(str(snapshot))
        with dst_conn:
            src_conn.backup(dst_conn)
        dst_conn.close()
        src_conn.close()
    except Exception as e:
        snapshot.unlink(missing_ok=True)
        raise HTTPException(500, f"Database snapshot failed: {e}")

    try:
        counts = {
            "users": db.query(User).count(),
            "documents": db.query(Document).count(),
            "announcements": db.query(Announcement).count(),
            "offices": db.query(Office).count(),
        }
    except Exception:
        counts = {}

    storage_file_count = 0
    if storage_path.exists():
        storage_file_count = sum(1 for p in storage_path.rglob("*") if p.is_file())

    manifest = {
        "version": 1,
        "app": "battalion-portal",
        "created_at": datetime.utcnow().isoformat() + "Z",
        "created_by": admin.username,
        "counts": counts,
        "storage_files": storage_file_count,
    }

    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))
            zf.write(snapshot, "portal.db")
            if storage_path.exists():
                for path in storage_path.rglob("*"):
                    if not path.is_file():
                        continue
                    name = path.name
                    if name.startswith(".backup_") or name.startswith(".snap_") or name.startswith(".stream_"):
                        continue
                    arcname = "storage/" + str(path.relative_to(storage_path))
                    zf.write(path, arcname)
    except Exception as e:
        tmp.unlink(missing_ok=True)
        snapshot.unlink(missing_ok=True)
        raise HTTPException(500, f"Backup archive failed: {e}")
    finally:
        snapshot.unlink(missing_ok=True)

    size = tmp.stat().st_size

    def iter_zip():
        try:
            with open(tmp, "rb") as f:
                while chunk := f.read(256 * 1024):
                    yield chunk
        finally:
            tmp.unlink(missing_ok=True)

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Length": str(size),
        "X-Backup-Size": _human_size(size),
    }
    return StreamingResponse(iter_zip(), media_type="application/zip", headers=headers)

@router.post("/toggle-uploaders")
def toggle_uploaders(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    config = db.query(AppConfig).first()
    if not config:
        config = AppConfig(id=1, maintenance_mode=False, lock_uploaders=True)
        db.add(config)
    else:
        config.lock_uploaders = not getattr(config, 'lock_uploaders', False)
    db.commit()
    return RedirectResponse("/admin", status_code=303)
# ---------------- RESTORE ----------------

@router.post("/backup/restore")
@limiter.limit("2/minute")
async def restore_full_backup(
    request: Request,
    file: UploadFile = File(...),
    confirm: str = Form(...),
    admin: User = Depends(require_admin),
):
    if confirm.strip().upper() != "RESTORE":
        raise HTTPException(400, "Confirmation phrase must be exactly: RESTORE")

    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(415, "Backup file must be a .zip")

    max_bytes = settings.max_backup_mb * 1024 * 1024
    file_bytes = await file.read()
    if len(file_bytes) > max_bytes:
        raise HTTPException(413, f"Backup exceeds {settings.max_backup_mb} MB limit")

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    work = _backup_dir() / f".restore_{timestamp}"
    work.mkdir(parents=True, exist_ok=True)

    try:
        zip_path = work / "upload.zip"
        zip_path.write_bytes(file_bytes)

        if not zipfile.is_zipfile(zip_path):
            raise HTTPException(400, "Uploaded file is not a valid ZIP archive")

        extract_dir = work / "extracted"
        extract_dir.mkdir()

        with zipfile.ZipFile(zip_path, "r") as zf:
            names = set(zf.namelist())

            if "manifest.json" not in names:
                raise HTTPException(400, "Backup is missing manifest.json — not a valid Battalion backup")
            if "portal.db" not in names:
                raise HTTPException(400, "Backup is missing portal.db")

            for name in names:
                if name.startswith("/") or ".." in Path(name).parts:
                    raise HTTPException(400, f"Unsafe path in archive: {name}")

            zf.extractall(extract_dir)

        try:
            manifest = json.loads((extract_dir / "manifest.json").read_text(encoding="utf-8"))
            if manifest.get("app") != "battalion-portal":
                raise HTTPException(400, "Backup is not from this application")
        except json.JSONDecodeError:
            raise HTTPException(400, "manifest.json is corrupted")

        new_db = extract_dir / "portal.db"
        new_storage = extract_dir / "storage"

        try:
            test = sqlite3.connect(str(new_db))
            test.execute("SELECT 1 FROM sqlite_master LIMIT 1")
            test.close()
        except Exception as e:
            raise HTTPException(400, f"Backup database is unreadable: {e}")

        safety_name = f"pre_restore_{timestamp}"
        safety_dir = _backup_dir() / safety_name
        safety_dir.mkdir(parents=True, exist_ok=True)

        current_db = _db_path()
        current_storage = Path(settings.storage_dir).resolve()

        if current_db.exists():
            try:
                src_conn = sqlite3.connect(str(current_db))
                dst_conn = sqlite3.connect(str(safety_dir / "portal.db"))
                with dst_conn:
                    src_conn.backup(dst_conn)
                dst_conn.close()
                src_conn.close()
            except Exception as e:
                raise HTTPException(500, f"Failed to snapshot current DB: {e}")

        if current_storage.exists():
            shutil.copytree(current_storage, safety_dir / "storage", dirs_exist_ok=True)

        engine.dispose()

        shutil.copy2(new_db, current_db)

        if current_storage.exists():
            shutil.rmtree(current_storage)
        if new_storage.exists():
            shutil.copytree(new_storage, current_storage)
        else:
            current_storage.mkdir(parents=True, exist_ok=True)

        engine.dispose()

        return {
            "ok": True,
            "restored_at": datetime.utcnow().isoformat() + "Z",
            "backup_created_at": manifest.get("created_at"),
            "manifest_counts": manifest.get("counts", {}),
            "safety_backup": str(safety_dir),
            "message": (
                "Restore complete. Current sessions may be logged out if the "
                "backup did not include this user. Restart the service if you "
                "notice any odd behavior: sudo systemctl restart battalion-portal"
            ),
        }

    finally:
        try:
            shutil.rmtree(work, ignore_errors=True)
        except Exception:
            pass