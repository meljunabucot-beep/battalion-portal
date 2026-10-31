from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import String, cast
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, engine, SessionLocal, get_db
from .deps import current_user
from .limiter import limiter
from .models import User, Document, seed_offices, AppConfig
from .permissions import user_can_view
from .auth import read_session
from .routers import (
    pages, auth, documents, announcements, admin,
    notifications, system, messages, activities,
)


class NoCacheStatic(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response


@asynccontextmanager
async def lifespan(_):
    Base.metadata.create_all(bind=engine)
    Path(settings.storage_dir).mkdir(parents=True, exist_ok=True)

    db = SessionLocal()
    try:
        if seed_offices(db):
            print("Seeded default offices.")
            
        # Ensure AppConfig exists
        if not db.query(AppConfig).first():
            db.add(AppConfig(id=1, maintenance_mode=False))
            db.commit()
            
    finally:
        db.close()

    if settings.is_production and settings.session_secret in ("change-me", "", "changeme"):
        raise RuntimeError(
            "SESSION_SECRET is still the default value. "
            "Generate a strong random string and set it in .env"
        )
    
    try:
        yield
    except Exception:
        pass


app = FastAPI(
    lifespan=lifespan,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None if settings.is_production else "/redoc",
    openapi_url=None if settings.is_production else "/openapi.json",
)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=settings.allowed_hosts,
)


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    # --- MAINTENANCE MODE CHECK ---
    db = SessionLocal()
    try:
        config = db.query(AppConfig).first()
        is_maintenance = config.maintenance_mode if config else False
        
        if is_maintenance:
            path = request.url.path
            # Allow static files, login, and the toggle endpoint so Admin can turn it off
            allowed_paths = ["/login", "/admin/toggle-maintenance", "/favicon.ico"]
            if not (path.startswith("/static") or path in allowed_paths):
                
                # Check if the current user is an Admin
                is_admin = False
                token = request.cookies.get("session")
                if token:
                    parsed = read_session(token)
                    if parsed:
                        uid, _ = parsed
                        u = db.query(User).filter(User.id == uid).first()
                        if u and u.role == "admin":
                            is_admin = True
                            
                if not is_admin:
                    html = """
                    <!DOCTYPE html>
                    <html>
                    <head><title>System Offline</title></head>
                    <body style="font-family:sans-serif; text-align:center; padding:4rem 1rem; background:#0f172a; color:#fff;">
                        <h1 style="color:#FF0000; font-size:2rem;">Alert</h1>
                        <p style="font-size:1.1rem; color:#cbd5e1;">The Warrior Battalion Portal needs repairs</p>
                        <p style="font-size:1.1rem; color:#cbd5e1;">Database Issue</p>
                        <p style="color:#64748b;">cloudflare.com</p>
                    </body>
                    </html>
                    """
                    return HTMLResponse(content=html, status_code=503)
    finally:
        db.close()
    # ------------------------------

    if settings.force_https:
        proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        if not proto:
            cf_visitor = request.headers.get("cf-visitor", "")
            if '"https"' in cf_visitor:
                proto = "https"
        host = request.headers.get("host", "").split(":")[0]
        if proto != "https" and host not in ("localhost", "127.0.0.1"):
            url = request.url.replace(scheme="https")
            return RedirectResponse(url=str(url), status_code=308)

    response = await call_next(request)

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"

    if settings.force_https:
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
    return response


app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Static files
app.mount("/static", NoCacheStatic(directory="static"), name="static")


# ---------------- Authenticated file serving ----------------

def _find_document_for_file(path: str, db: Session) -> Document | None:
    # 1. Direct match on file_path or preview_pdf_path
    d = (
        db.query(Document)
        .filter(
            (Document.file_path == path) |
            (Document.preview_pdf_path == path)
        )
        .first()
    )
    if d:
        return d

    # 2. Search JSON columns for signature / return URLs.
    basename = path.rsplit("/", 1)[-1]
    like = f"%{basename}%"

    candidates = (
        db.query(Document)
        .filter(
            (cast(Document.signatures, String).like(like)) |
            (cast(Document.returns, String).like(like))
        )
        .all()
    )

    def url_matches(u: str | None) -> bool:
        if not u:
            return False
        return u == f"/files/{path}" or u.endswith("/" + path)

    for c in candidates:
        for sig in (c.signatures or []):
            if url_matches(sig.get("url")):
                return c
        for ret in (c.returns or []):
            if url_matches(ret.get("marked_url")):
                return c
            for mp in (ret.get("marked_pages") or []):
                if url_matches(mp.get("url")):
                    return c

    return None


@app.get("/files/{path:path}")
def serve_uploaded_file(
    path: str,
    user: User | None = Depends(current_user),
    db: Session = Depends(get_db),
):
    if not user or user.status != "active":
        raise HTTPException(401, "Authentication required")

    # Path traversal check
    root = Path(settings.storage_dir).resolve()
    target = (root / path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(403, "Forbidden")

    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")

    doc = _find_document_for_file(path, db)

    if doc is None:
        if user.role != "admin":
            raise HTTPException(403, "Not authorized to download this file")
    else:
        if not user_can_view(doc, user):
            raise HTTPException(403, "Not authorized to download this file")

    return FileResponse(target)


# ---------------- Routes ----------------

app.include_router(auth.router)
app.include_router(pages.router)
app.include_router(admin.router)
app.include_router(documents.router)
app.include_router(announcements.router, prefix="/api/announcements")
app.include_router(notifications.router, prefix="/api/notifications")
app.include_router(system.router)
app.include_router(messages.router)
app.include_router(activities.router)