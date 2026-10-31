from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Document, Announcement, Activity, User
from ..deps import require_user

router = APIRouter()


def _today_in_unit_timezone():
    try:
        tz = ZoneInfo(settings.timezone)
    except Exception:
        tz = ZoneInfo("UTC")
    return datetime.now(tz).date()


@router.get("")
def list_notifications(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    notifs: list[dict] = []
    week_ago = datetime.utcnow() - timedelta(days=7)

    # ---- Everyone: activities happening in the next 2 days ----
    today = _today_in_unit_timezone()
    tomorrow = (today + timedelta(days=1)).isoformat()
    day_after = (today + timedelta(days=2)).isoformat()

    upcoming_activities = (
        db.query(Activity)
        .filter(Activity.activity_date.in_([tomorrow, day_after]))
        .order_by(Activity.activity_date.asc(), Activity.activity_time.asc())
        .limit(10)
        .all()
    )
    
    for a in upcoming_activities:
        time_str = f" at {a.activity_time}" if a.activity_time else ""
        loc_str = f" ({a.location})" if a.location else ""
        
        # Label it based on whether it's tomorrow or the day after
        if a.activity_date == tomorrow:
            date_prefix = "Tomorrow"
        else:
            date_prefix = "In 2 days"
            
        notifs.append({
            "icon": "📅",
            "text": f"{date_prefix}: {a.title}{time_str}{loc_str}",
            "link": f"/activities?date={a.activity_date}",
            "priority": "info",
        })

    # ---- Officers: pending documents at any of their offices ----
    if user.role == "officer" and user.offices:
        pending = (
            db.query(Document)
            .filter(
                Document.active_recipient.in_(user.offices),
                Document.status == "PENDING",
            )
            .count()
        )
        if pending:
            notifs.append({
                "icon": "📥",
                "text": f"{pending} document{'s' if pending != 1 else ''} awaiting your section's signature",
                "link": "/queue",
                "priority": "high",
            })

    # ---- CO: pending documents awaiting final approval ----
    if user.role == "co":
        pending = (
            db.query(Document)
            .filter(
                Document.active_recipient == "co",
                Document.status == "PENDING",
            )
            .count()
        )
        if pending:
            notifs.append({
                "icon": "🎖️",
                "text": f"{pending} document{'s' if pending != 1 else ''} awaiting final approval",
                "link": "/co",
                "priority": "high",
            })

    # ---- Admin: everything pending ----
    if user.role == "admin":
        pending = (
            db.query(Document)
            .filter(Document.status == "PENDING")
            .count()
        )
        if pending:
            notifs.append({
                "icon": "📥",
                "text": f"{pending} document{'s' if pending != 1 else ''} in the workflow",
                "link": "/admin",
                "priority": "high",
            })

    # ---- Uploaders: returned documents for their offices ----
    if user.role == "uploader" and user.offices:
        returned = (
            db.query(Document)
            .filter(
                Document.origin_office.in_(user.offices),
                Document.status == "RETURNED",
            )
            .count()
        )
        if returned:
            notifs.append({
                "icon": "↩️",
                "text": f"{returned} returned document{'s' if returned != 1 else ''} awaiting correction",
                "link": "/desk",
                "priority": "high",
            })

        approved = (
            db.query(Document)
            .filter(
                Document.origin_office.in_(user.offices),
                Document.status == "APPROVED",
                Document.created_at >= week_ago,
            )
            .count()
        )
        if approved:
            notifs.append({
                "icon": "✅",
                "text": f"{approved} of your office's documents approved this week",
                "link": "/desk",
                "priority": "info",
            })

    # ---- Everyone: recent announcements ----
    recent_anns = (
        db.query(Announcement)
        .filter(Announcement.created_at >= week_ago)
        .order_by(Announcement.created_at.desc())
        .limit(5)
        .all()
    )
    for a in recent_anns:
        notifs.append({
            "icon": "📢",
            "text": a.title,
            "link": "/",
            "priority": "info",
        })

    if not notifs:
        notifs.append({
            "icon": "✨",
            "text": "No new notifications",
            "link": "/",
            "priority": "info",
        })

    return notifs