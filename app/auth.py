import bcrypt
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from .config import settings

_serializer = URLSafeTimedSerializer(settings.session_secret, salt="session")


def hash_password(p: str) -> str:
    pw = p.encode("utf-8")[:72]
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8")


def verify_password(p: str, h: str) -> bool:
    try:
        pw = p.encode("utf-8")[:72]
        return bcrypt.checkpw(pw, h.encode("utf-8"))
    except Exception:
        return False


def make_session(user_id: str, version: int = 0) -> str:
    """Signed session token containing the user id and session version.

    The version is bumped whenever the password changes, which invalidates
    every previously-issued session for that user.
    """
    return _serializer.dumps({"uid": user_id, "v": version})


def read_session(token: str) -> tuple[str, int] | None:
    """Return (user_id, session_version) or None if the token is invalid/expired."""
    try:
        data = _serializer.loads(token, max_age=settings.session_max_age)
        uid = data.get("uid")
        if not uid:
            return None
        return uid, int(data.get("v", 0))
    except (BadSignature, SignatureExpired, ValueError, TypeError):
        return None


def cookie_settings() -> dict:
    """Cookie flags — differ between dev and production.

    httponly  : JS can't read the cookie (blocks XSS session theft)
    samesite  : "lax" sends the cookie on top-level navigation but not
                cross-site POSTs (blocks most CSRF)
    secure    : HTTPS-only in production (blocks interception over HTTP)
    """
    return {
        "key": "session",
        "httponly": True,
        "samesite": "lax",
        "secure": settings.is_production,
        "max_age": settings.session_max_age,
        "path": "/",
    }