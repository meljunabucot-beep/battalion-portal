from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import require_user
from ..limiter import limiter
from ..models import Activity, User

router = APIRouter(prefix="/api/activities")


class ActivityIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    location: str | None = None
    activity_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    activity_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")


def _out(a: Activity) -> dict:
    return {
        "id": a.id,
        "title": a.title,
        "description": a.description,
        "location": a.location,
        "activity_date": a.activity_date,
        "activity_time": a.activity_time,
        "office": a.office,        # <-- ADD THIS
        "created_by": a.created_by,
        "created_at": a.created_at.isoformat() + "Z",
    }


def _validate_date(s: str) -> None:
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Invalid date format (expected YYYY-MM-DD)")


@router.get("")
def list_activities(
    month: str | None = None,
    on: str | None = Query(default=None, alias="date"),
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    q = db.query(Activity)

    if month:
        if len(month) != 7 or month[4] != "-":
            raise HTTPException(400, "Invalid month (expected YYYY-MM)")
        q = q.filter(Activity.activity_date.like(f"{month}-%"))
    elif on:
        _validate_date(on)
        q = q.filter(Activity.activity_date == on)

    q = q.order_by(Activity.activity_date.asc(), Activity.activity_time.asc())

    return [_out(a) for a in q.all()]


@router.post("")
@limiter.limit("30/minute")
def create_activity(
    request: Request,
    payload: ActivityIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    _validate_date(payload.activity_date)

    # Grab the user's first office, or "general" if they don't have one (like admins)
    origin_office = (user.offices[0].lower() if user.offices else "general")

    a = Activity(
        title=payload.title.strip(),
        description=(payload.description or "").strip() or None,
        location=(payload.location or "").strip() or None,
        activity_date=payload.activity_date,
        activity_time=payload.activity_time,
        office=origin_office,      # <-- ADD THIS
        created_by=user.username,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _out(a)


@router.patch("/{activity_id}")
def update_activity(
    activity_id: str,
    payload: ActivityIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    a = db.query(Activity).filter(Activity.id == activity_id).first()
    if not a:
        raise HTTPException(404)
    if a.created_by != user.username and user.role != "admin":
        raise HTTPException(403, "You can only edit your own activities")

    _validate_date(payload.activity_date)

    a.title = payload.title.strip()
    a.description = (payload.description or "").strip() or None
    a.location = (payload.location or "").strip() or None
    a.activity_date = payload.activity_date
    a.activity_time = payload.activity_time
    db.commit()
    db.refresh(a)
    return _out(a)


@router.delete("/{activity_id}")
def delete_activity(
    activity_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    a = db.query(Activity).filter(Activity.id == activity_id).first()
    if not a:
        raise HTTPException(404)
    if a.created_by != user.username and user.role != "admin":
        raise HTTPException(403, "You can only delete your own activities")
    db.delete(a)
    db.commit()
    return {"ok": True}