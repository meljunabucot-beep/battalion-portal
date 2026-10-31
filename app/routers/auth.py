import logging
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse, HTMLResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import User, Office, REQUESTABLE_ROLES, get_active_offices
from ..auth import verify_password, hash_password, make_session, cookie_settings
from ..deps import current_user
from ..limiter import limiter
from ..templates_setup import templates

router = APIRouter()


# ---------------- security log ----------------
# A dedicated log for authentication failures. fail2ban tails this file
# and bans offending IPs at Cloudflare's edge. Kept separate from the
# general app log so the fail2ban filter can be simple and precise.

_LOG_DIR = Path(__file__).resolve().parent.parent.parent / "logs"
_LOG_DIR.mkdir(exist_ok=True)

_security_logger = logging.getLogger("battalion.security")
_security_logger.setLevel(logging.INFO)
if not _security_logger.handlers:
    _handler = RotatingFileHandler(
        _LOG_DIR / "security.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
    )
    _handler.setFormatter(logging.Formatter("%(asctime)s|%(message)s"))
    _security_logger.addHandler(_handler)
    _security_logger.propagate = False


def _client_ip(request: Request) -> str:
    """Extract the real client IP when behind Cloudflare Tunnel."""
    return (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown")
    )


# ---------------- login ----------------

@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request, user=Depends(current_user)):
    if user and user.status == "active":
        return RedirectResponse("/", status_code=303)

    left_raw = request.query_params.get("left")
    secs_raw = request.query_params.get("secs")

    return templates.TemplateResponse(request, "login.html", {
        "user": None,
        "err":  request.query_params.get("err"),
        "left": int(left_raw) if left_raw and left_raw.isdigit() else None,
        "secs": int(secs_raw) if secs_raw and secs_raw.isdigit()
                else settings.login_lockout_seconds,
    })


@router.post("/login")
@limiter.limit("10/minute")
def do_login(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    u = db.query(User).filter(User.username == username).first()

    # ---- 1. Account lockout check (before password verification) ----
    if u and u.locked_until and u.locked_until > datetime.utcnow():
        secs = int((u.locked_until - datetime.utcnow()).total_seconds())
        _security_logger.info(f"LOGIN_LOCKED|ip={_client_ip(request)}|user={username}")
        return RedirectResponse(f"/login?err=locked&secs={secs}", status_code=303)

    # ---- 2. Verify credentials ----
    ok = bool(u) and verify_password(password, u.password_hash)

    if not ok:
        # ... (keep your existing failed login logic) ...
        return RedirectResponse("/login?err=bad", status_code=303)

    # ---- 3. Credentials valid — check account status ----
    if u.status == "pending":
        return RedirectResponse("/login?err=pending", status_code=303)
    if u.status == "rejected":
        return RedirectResponse("/login?err=rejected", status_code=303)

    # ---- 4. CHECK UPLOADER LOCK ----
    if u.role == "uploader":
        config = db.query(AppConfig).first()
        if config and getattr(config, 'lock_uploaders', False):
            _security_logger.info(f"LOGIN_BLOCKED_UPLOADER_LOCK|ip={_client_ip(request)}|user={username}")
            return RedirectResponse("/login?err=uploader_locked", status_code=303)

    # ---- 5. Success — clear any stale lockout state ----
    # ... (keep the rest of your login success code)
    # ---- 4. Success — clear any stale lockout state ----
    if u.failed_attempts or u.locked_until:
        u.failed_attempts = 0
        u.locked_until = None
        db.commit()

    cs = cookie_settings()
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(
        cs["key"], make_session(u.id, u.session_version or 0),
        httponly=cs["httponly"],
        samesite=cs["samesite"],
        secure=cs["secure"],
        max_age=cs["max_age"],
        path=cs["path"],
    )
    return resp


@router.post("/logout")
def do_logout():
    cs = cookie_settings()
    resp = RedirectResponse("/", status_code=303)
    resp.delete_cookie(cs["key"], path=cs["path"])
    return resp


# ---------------- register ----------------

@router.get("/register", response_class=HTMLResponse)
def register_page(request: Request, user=Depends(current_user), db: Session = Depends(get_db)):
    if user and user.status == "active":
        return RedirectResponse("/", status_code=303)
    offices = get_active_offices(db)
    return templates.TemplateResponse(request, "register.html", {
        "user": None,
        "roles": REQUESTABLE_ROLES,
        "offices": offices,
        "err": request.query_params.get("err"),
    })


@router.post("/register")
@limiter.limit("3/hour")
def register(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    confirm: str = Form(...),
    requested_role: str = Form(...),
    offices: list[str] = Form(default=[]),
    db: Session = Depends(get_db),
):
    username = username.strip()

    if not username or len(username) < 3:
        return RedirectResponse("/register?err=user", status_code=303)
    if password != confirm:
        return RedirectResponse("/register?err=pw", status_code=303)
    if len(password) < 6:
        return RedirectResponse("/register?err=weak", status_code=303)
    if requested_role not in REQUESTABLE_ROLES:
        return RedirectResponse("/register?err=role", status_code=303)
    if db.query(User).filter(User.username == username).first():
        return RedirectResponse("/register?err=exists", status_code=303)

    active_codes = {
        o.code for o in db.query(Office).filter(Office.active == True).all()
    }
    resolved = [o.lower() for o in offices if o.lower() in active_codes]
    if not resolved:
        return RedirectResponse("/register?err=office", status_code=303)

    user = User(
        username=username,
        password_hash=hash_password(password),
        role="pending",
        requested_role=requested_role,
        status="pending",
        offices=resolved,
    )
    db.add(user)
    db.commit()
    return RedirectResponse("/login?err=registered", status_code=303)