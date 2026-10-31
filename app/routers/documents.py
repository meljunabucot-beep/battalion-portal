import io
import zipfile
from fastapi.responses import StreamingResponse
import json
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import and_, or_, cast, String

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import require_user
from ..models import Document, User, Office
from ..permissions import user_can_sign, user_can_view
from ..storage import storage
from ..pdfconvert import can_convert, convert_to_pdf, overlay_signatures

router = APIRouter(prefix="/api/documents")

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg"}


# ---------------- payload models ----------------
class ArchiveRequest(BaseModel):
    doc_ids: list[str]


class SignatureIn(BaseModel):
    step: str
    officer: str
    url: str
    x: float = 0
    y: float = 0
    width: float | None = None
    height: float | None = None
    page: int = 0
    page_width: float | None = None
    page_height: float | None = None
    timestamp: str


class SignPayload(BaseModel):
    signatures: list[SignatureIn]


class MarkedPageIn(BaseModel):
    page: int
    url: str
    path: str


class ReturnPayload(BaseModel):
    reason: str
    marked_pages: list[MarkedPageIn] = []
    # Legacy single-canvas fields, kept so old returns still work
    marked_png_url: str | None = None
    marked_png_path: str | None = None
    canvas_width: int | None = None
    canvas_height: int | None = None


def _doc_out(d: Document) -> dict:
    preview_url = (
        storage.public_url(d.preview_pdf_path)
        if d.preview_pdf_path else None
    )
    return {
        "id": d.id, "title": d.title, "type": d.type,
        "origin_office": d.origin_office,
        "route_chain": d.route_chain,
        "current_step_index": d.current_step_index,
        "active_recipient": d.active_recipient,
        "remarks": d.remarks,
        "file_name": d.file_name, "file_type": d.file_type,
        "file_url": d.file_url,
        "preview_url": preview_url,
        "status": d.status,
        "signatures": d.signatures or [],
        "history_logs": d.history_logs or [],
        "returns": d.returns or [],
        "created_at": d.created_at.isoformat(),
    }


def _generate_preview(db: Session, d: Document) -> None:
    """Convert d's source file to PDF and store the result. Commits on success."""
    if not settings.enable_pdf_preview:
        return
    if d.preview_pdf_path:
        return
    if not d.file_path:
        return

    ext = Path(d.file_name).suffix.lower()
    if not can_convert(ext):
        return

    src = Path(settings.storage_dir) / d.file_path
    if not src.exists():
        return

    with tempfile.TemporaryDirectory() as tmp:
        pdf_result = convert_to_pdf(src, Path(tmp))
        if not pdf_result or not pdf_result.exists():
            return
        pdf_bytes = pdf_result.read_bytes()

    d.preview_pdf_path = storage.save("previews", "preview.pdf", pdf_bytes)
    d.attached_files = (d.attached_files or []) + [d.preview_pdf_path]
    db.commit()


# ---------------- list ----------------
@router.get("")
def list_docs(
    origin_office: str | None = None,
    origin_offices: str | None = None,
    active_recipient: str | None = None,
    active_recipients: str | None = None,
    status: str | None = None,
    q: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    query = db.query(Document).order_by(Document.created_at.desc())

    # ---- STEP 1: role-based visibility scope ----
    if user.role == "admin":
        pass

    elif user.role == "co":
        query = query.filter(
            or_(
                Document.active_recipient == "co",
                Document.status == "APPROVED",
            )
        )

    elif user.role == "officer":
        if not user.offices:
            return []
        # Officers see:
        #   - documents currently at their section (queue)
        #   - approved documents that originated from their section
        #   - approved documents that they personally signed
        query = query.filter(
            or_(
                Document.active_recipient.in_(user.offices),
                and_(
                    Document.status == "APPROVED",
                    or_(
                        Document.origin_office.in_(user.offices),
                        cast(Document.signatures, String).like(f'%{user.username}%')
                    ),
                ),
            )
        )

    elif user.role == "uploader":
        if not user.offices:
            return []
        query = query.filter(Document.origin_office.in_(user.offices))

    else:
        return []

    # ---- STEP 2: additional filters WITHIN the scope ----

    if origin_offices:
        requested = [o.strip().lower() for o in origin_offices.split(",") if o.strip()]
        if requested:
            if user.role == "uploader":
                allowed = [o for o in requested if o in (user.offices or [])]
                if allowed:
                    query = query.filter(Document.origin_office.in_(allowed))
                else:
                    return []
            else:
                query = query.filter(Document.origin_office.in_(requested))
    elif origin_office:
        oc = origin_office.lower()
        if user.role == "uploader":
            if oc in (user.offices or []):
                query = query.filter(Document.origin_office == oc)
            else:
                return []
        else:
            query = query.filter(Document.origin_office == oc)

    if active_recipients:
        requested = [r.strip().lower() for r in active_recipients.split(",") if r.strip()]
        if requested:
            if user.role == "officer":
                allowed = [r for r in requested if r in (user.offices or [])]
                if allowed:
                    query = query.filter(Document.active_recipient.in_(allowed))
                else:
                    return []
            else:
                query = query.filter(Document.active_recipient.in_(requested))
    elif active_recipient:
        ar = active_recipient.lower()
        if user.role == "officer":
            if ar in (user.offices or []):
                query = query.filter(Document.active_recipient == ar)
            else:
                return []
        else:
            query = query.filter(Document.active_recipient == ar)

    if status:
        query = query.filter(Document.status == status)

    if q:
        like = f"%{q}%"
        query = query.filter(
            Document.title.ilike(like)
            | Document.file_name.ilike(like)
            | Document.origin_office.ilike(like)
            | Document.type.ilike(like)
        )

    return [_doc_out(d) for d in query.all()]


# ---------------- get one ----------------
@router.get("/{doc_id}")
def get_doc(doc_id: str, db: Session = Depends(get_db), user: User = Depends(require_user)):
    d = db.query(Document).filter(Document.id == doc_id).first()
    if not d:
        raise HTTPException(404, "Document not found")
    if not user_can_view(d, user):
        raise HTTPException(403, "Not authorized to view this document")

    # Lazy conversion: first view of a convertible doc generates the PDF.
    _generate_preview(db, d)

    return _doc_out(d)

# ---------------- create ----------------
@router.post("")
async def create_doc(
    title: str = Form(...),
    type: str = Form("General Document"),
    remarks: str = Form(""),
    route_chain: str = Form(...),
    origin_office: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    if user.role not in ("uploader", "admin"):
        raise HTTPException(403, "Only uploaders may create documents")

    office = origin_office.strip().lower()
    if user.role == "uploader":
        if not user.offices or office not in user.offices:
            raise HTTPException(403, "You can only submit for your assigned office(s)")

    try:
        chain = json.loads(route_chain)
    except Exception:
        raise HTTPException(400, "Invalid route_chain")

    if not isinstance(chain, list) or not chain:
        raise HTTPException(400, "Select at least one recipient")

    active_codes = {
        o.code for o in db.query(Office).filter(Office.active == True).all()
    }
    chain = [str(x).strip().lower() for x in chain]

    # De-duplicate while preserving order
    seen: set[str] = set()
    chain = [x for x in chain if not (x in seen or seen.add(x))]

    # CO, if selected, must be the last step
    if "co" in chain and chain[-1] != "co":
        raise HTTPException(400, "Commanding Officer must be the last step in the chain")

    # Validate: every non-CO step must be a real, active office
    for step in chain:
        if step == "co":
            continue
        if step not in active_codes:
            raise HTTPException(400, f"Unknown or inactive office: {step}")

    # NOTE: We no longer auto-append "co". The uploader decides.

    filename = file.filename or "upload.bin"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, f"File type {ext} not allowed")

    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, "File too large")

    key = storage.save("uploads", f"file{ext}", data)

    pretty_chain = " ➔ ".join([s.upper() for s in chain])

    doc = Document(
        title=title,
        type=type,
        origin_office=office,
        route_chain=chain,
        current_step_index=0,
        active_recipient=chain[0],
        remarks=remarks,
        file_name=filename,
        file_type=file.content_type or "application/octet-stream",
        file_path=key,
        file_url=storage.public_url(key),
        status="PENDING",
        signatures=[],
        returns=[],
        attached_files=[key],
        history_logs=[f"Uploaded by {user.username} ({office.upper()}) ➔ Routed: {pretty_chain}"],
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    return _doc_out(doc)


# ---------------- sign ----------------
@router.post("/{doc_id}/sign")
def sign_doc(
    doc_id: str,
    payload: SignPayload,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    d = db.query(Document).filter(Document.id == doc_id).first()
    if not d:
        raise HTTPException(404)
    if not user_can_sign(d, user):
        raise HTTPException(403, "Not your turn")
    if not payload.signatures:
        raise HTTPException(400, "At least one signature is required")

    current_step = d.active_recipient
    is_final = d.current_step_index == len(d.route_chain) - 1
    next_index = d.current_step_index + 1

    d.signatures = (d.signatures or []) + [
        {**s.model_dump(), "step": current_step.upper(), "officer": user.username}
        for s in payload.signatures
    ]

    if not is_final:
        next_recipient = d.route_chain[next_index]
        d.current_step_index = next_index
        d.active_recipient = next_recipient
        d.history_logs = (d.history_logs or []) + [
            f"✒️ Signed by {current_step.upper()} ({user.username}) "
            f"with {len(payload.signatures)} signature(s). Advanced to {next_recipient.upper()}."
        ]
    else:
        d.current_step_index = next_index
        d.status = "APPROVED"

        # If CO was the last step, keep the "co" recipient label.
        # Otherwise the last section is the final approver.
        if current_step == "co":
            d.active_recipient = "co"

        # Server-side overlay: stamp every recorded signature onto the
        # preview PDF and save the result as the archive copy.
            # Server-side overlay: stamp every recorded signature onto the
    # preview PDF (or the original uploaded PDF) and save the result as the archive copy.
    overlay_ok = False
    base_pdf_path = None

    # 1. Determine which PDF to draw on
    if d.preview_pdf_path:
        base_pdf_path = Path(settings.storage_dir) / d.preview_pdf_path
    elif d.file_path and (d.file_name.lower().endswith(".pdf") or d.file_type == "application/pdf"):
        base_pdf_path = Path(settings.storage_dir) / d.file_path

    # 2. Perform the overlay
    if settings.enable_pdf_preview and base_pdf_path and base_pdf_path.exists():
        signed_dir = Path(settings.storage_dir) / "signed"
        signed_dir.mkdir(parents=True, exist_ok=True)
        signed_name = f"{uuid.uuid4()}.pdf"
        signed_path = signed_dir / signed_name

        overlay_ok = overlay_signatures(
            pdf_path=base_pdf_path,
            signatures=d.signatures,
            storage_root=Path(settings.storage_dir),
            storage_public_url=settings.storage_public_url,
            out_path=signed_path,
        )

        if overlay_ok:
            d.file_path = f"signed/{signed_name}"
            d.file_url = storage.public_url(d.file_path)
            d.file_type = "application/pdf"
            stem = Path(d.file_name).stem
            d.file_name = f"{stem}_signed.pdf"
            d.preview_pdf_path = d.file_path
            d.attached_files = (d.attached_files or []) + [d.file_path]

    db.commit()
    db.refresh(d)
    return _doc_out(d)


# ---------------- return ----------------
@router.post("/{doc_id}/return")
def return_doc(
    doc_id: str,
    payload: ReturnPayload,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    d = db.query(Document).filter(Document.id == doc_id).first()
    if not d:
        raise HTTPException(404)
    if not user_can_sign(d, user):
        raise HTTPException(403, "Not your turn")

    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(400, "Reason is required")

    entry = {
        "officer": user.username,
        "step": d.active_recipient.upper(),
        "reason": reason,
        # New: list of { page, url, path } — one per marked page
        "marked_pages": [m.model_dump() for m in payload.marked_pages],
        # Legacy: kept so old returns that only have marked_url still work
        "marked_url": payload.marked_png_url,
        "marked_path": payload.marked_png_path,
        "canvas_width": payload.canvas_width,
        "canvas_height": payload.canvas_height,
        "timestamp": datetime.utcnow().isoformat(),
    }
    d.returns = (d.returns or []) + [entry]
    d.status = "RETURNED"
    d.history_logs = (d.history_logs or []) + [
        f"↩️ Returned by {d.active_recipient.upper()} ({user.username}). Reason: {reason}"
    ]
    db.commit()
    db.refresh(d)
    return _doc_out(d)


# ---------------- resubmit ----------------
@router.post("/{doc_id}/resubmit")
async def resubmit_doc(
    doc_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    d = db.query(Document).filter(Document.id == doc_id).first()
    if not d:
        raise HTTPException(404)

    if user.role == "uploader":
        if not user.offices or d.origin_office not in user.offices:
            raise HTTPException(403, "Not your office's document")
    elif user.role != "admin":
        raise HTTPException(403, "Not permitted")

    if d.status != "RETURNED":
        raise HTTPException(400, "Document is not in RETURNED state")

    filename = file.filename or "upload.bin"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, f"File type {ext} not allowed")

    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, "File too large")

    key = storage.save("uploads", f"file{ext}", data)

    first_step = d.route_chain[0] if d.route_chain else "co"

    d.file_name = filename
    d.file_type = file.content_type or "application/octet-stream"
    d.file_path = key
    d.file_url = storage.public_url(key)
    d.preview_pdf_path = None   # invalidate the old preview
    d.attached_files = (d.attached_files or []) + [key]
    d.status = "PENDING"
    d.current_step_index = 0
    d.active_recipient = first_step
    d.signatures = []
    d.history_logs = (d.history_logs or []) + [
        f"📤 Corrected file resubmitted by {user.username} ({d.origin_office.upper()}). "
        f"Workflow restarted from {first_step.upper()}."
    ]

    db.commit()
    db.refresh(d)

    return _doc_out(d)


# ---------------- delete ----------------
def _delete_storage_file(key: str | None) -> None:
    """Best-effort delete of a single storage key. Silent on failure."""
    if not key:
        return
    try:
        p = Path(settings.storage_dir) / key
        p.unlink(missing_ok=True)
    except Exception as e:
        print(f"[delete] could not remove {key}: {e}")


def _collect_storage_keys(d: Document) -> set[str]:
    """
    Every storage key this document owns — current and historical:
      - attached_files[]     — every file path this doc has ever owned
      - file_path            — current file (defensive)
      - preview_pdf_path     — current preview (defensive)
      - signatures[].url     — every placed signature PNG
      - returns[].marked_url — legacy single-canvas return mark
      - returns[].marked_pages[].url — new per-page return marks
    """
    keys: set[str] = set()

    for k in (d.attached_files or []):
        if k:
            keys.add(k)

    if d.file_path:
        keys.add(d.file_path)
    if d.preview_pdf_path:
        keys.add(d.preview_pdf_path)

    prefix = settings.storage_public_url + "/"

    def from_url(u: str | None) -> None:
        if not u:
            return
        if u.startswith(prefix):
            keys.add(u[len(prefix):])

    for sig in (d.signatures or []):
        from_url(sig.get("url"))
    for ret in (d.returns or []):
        from_url(ret.get("marked_url"))
        for mp in (ret.get("marked_pages") or []):
            from_url(mp.get("url"))

    return keys


@router.delete("/{doc_id}")
def delete_doc(
    doc_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    d = db.query(Document).filter(Document.id == doc_id).first()
    if not d:
        raise HTTPException(404)

    if user.role != "admin":
        if not user.offices or d.origin_office not in user.offices:
            raise HTTPException(403)

    # Snapshot the storage keys BEFORE we delete the row
    keys = _collect_storage_keys(d)

    db.delete(d)
    db.commit()

    for k in keys:
        _delete_storage_file(k)

    return {"ok": True, "deleted_files": len(keys)}


# ---------------- file uploads ----------------
@router.post("/upload-signature")
async def upload_signature(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
):
    data = await file.read()
    key = storage.save("signatures", file.filename or "sig.png", data)
    return {"url": storage.public_url(key), "path": key}


@router.post("/upload-signed-pdf")
async def upload_signed_pdf(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
):
    data = await file.read()
    key = storage.save("signed", file.filename or "signed.pdf", data)
    return {"url": storage.public_url(key), "path": key}


@router.post("/upload-return-mark")
async def upload_return_mark(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
):
    data = await file.read()
    key = storage.save("returns", file.filename or "mark.png", data)
    return {"url": storage.public_url(key), "path": key}


# ---------------- download archive ----------------
@router.post("/download-archive")
def download_archive(
    payload: ArchiveRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    if not payload.doc_ids:
        raise HTTPException(400, "No documents selected")

    # Fetch documents and verify permissions
    docs = db.query(Document).filter(Document.id.in_(payload.doc_ids)).all()
    authorized_docs = [d for d in docs if user_can_view(d, user)]

    if not authorized_docs:
        raise HTTPException(403, "Not authorized to download these documents")

    # Create ZIP in memory
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for d in authorized_docs:
            file_path = Path(settings.storage_dir) / d.file_path
            if file_path.exists():
                # Create a clean, unique filename for the ZIP
                safe_title = "".join(c for c in d.title if c.isalnum() or c in " -_")[:40].strip()
                safe_filename = f"{safe_title}_{d.file_name}"
                
                # Handle duplicate names
                if safe_filename in zf.namelist():
                    safe_filename = f"{safe_title}_{d.id[:6]}_{d.file_name}"
                    
                zf.write(file_path, safe_filename)

    zip_buffer.seek(0)
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    
    return StreamingResponse(
        iter([zip_buffer.getvalue()]), 
        media_type="application/zip", 
        headers={"Content-Disposition": f'attachment; filename="Signed_Archive_{timestamp}.zip"'}
    )