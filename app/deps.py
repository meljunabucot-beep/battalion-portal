from datetime import datetime, timedelta
from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.orm import Session
from .database import get_db
from .models import User
from .auth import read_session
from .models import User, AppConfig

# Only update last_seen if it hasn't been touched in this many seconds.
# Prevents a DB write on every single request.
TOUCH_INTERVAL_SECONDS = 60


def current_user(
    session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> User | None:
    if not session:
        return None

    parsed = read_session(session)
    if not parsed:
        return None

    uid, sess_ver = parsed

    user = db.query(User).filter(User.id == uid).first()
    if not user:
        return None

    # Reject sessions issued before the last password change.
    # An admin resetting a password bumps session_version, which
    # invalidates every previously-issued cookie for that user.
    if (user.session_version or 0) != sess_ver:
        return None

    # Throttled last_seen update
    now = datetime.utcnow()
    should_touch = (
        user.last_seen is None
        or (now - user.last_seen).total_seconds() > TOUCH_INTERVAL_SECONDS
    )
    if should_touch:
        try:
            user.last_seen = now
            db.commit()
        except Exception:
            db.rollback()

    return user


from .models import User, AppConfig # <-- Import AppConfig

def require_user(user: User | None = Depends(current_user), db: Session = Depends(get_db)) -> User:
    if not user or user.status != "active":
        raise HTTPException(status.HTTP_303_SEE_OTHER, headers={"Location": "/login"})
    
    # Check if uploaders are locked
    if user.role == "uploader":
        config = db.query(AppConfig).first()
        if config and getattr(config, 'lock_uploaders', False):
            raise HTTPException(
                status.HTTP_303_SEE_OTHER, 
                headers={"Location": "/login?err=uploader_locked"}
            )
            
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin only")
    return user