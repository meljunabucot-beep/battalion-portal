from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Announcement, User
from ..deps import require_user, require_admin

router = APIRouter()


class AnnouncementIn(BaseModel):
    title: str
    content: str
    priority: str = "General"


def _out(a: Announcement) -> dict:
    return {
        "id": a.id,
        "title": a.title,
        "content": a.content,
        "priority": a.priority,
        "author": a.author,
        "created_at": a.created_at.isoformat(),
    }


@router.get("")
def list_announcements(db: Session = Depends(get_db), user: User = Depends(require_user)):
    q = db.query(Announcement).order_by(Announcement.created_at.desc()).all()
    return [_out(a) for a in q]


@router.post("")
def create_announcement(
    payload: AnnouncementIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    a = Announcement(
        title=payload.title.strip(),
        content=payload.content.strip(),
        priority=payload.priority if payload.priority in ("General", "Important", "Urgent") else "General",
        author=admin.username,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _out(a)


@router.delete("/{ann_id}")
def delete_announcement(
    ann_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    a = db.query(Announcement).filter(Announcement.id == ann_id).first()
    if not a:
        raise HTTPException(404)
    db.delete(a)
    db.commit()
    return {"ok": True}