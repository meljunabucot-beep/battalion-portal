from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import require_user
from ..limiter import limiter
from ..models import DirectMessage, User

router = APIRouter(prefix="/api/messages")

MAX_LEN = 2000


class MessageIn(BaseModel):
    content: str = Field(..., min_length=1, max_length=MAX_LEN)


def _out(m: DirectMessage) -> dict:
    return {
        "id": m.id,
        "sender": m.sender,
        "recipient": m.recipient,
        "content": m.content,
        "created_at": m.created_at.isoformat() + "Z",
        "edited_at": m.edited_at.isoformat() + "Z" if m.edited_at else None,
        "read_at": m.read_at.isoformat() + "Z" if m.read_at else None,
    }


@router.get("/conversations")
def list_conversations(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    me = user.username

    others = (
        db.query(User.username, User.role, User.offices)
        .filter(User.status == "active")
        .filter(User.username != me)
        .order_by(User.username.asc())
        .all()
    )

    rows = (
        db.query(DirectMessage)
        .filter(or_(
            DirectMessage.sender == me,
            DirectMessage.recipient == me,
        ))
        .order_by(DirectMessage.created_at.desc())
        .limit(5000)
        .all()
    )

    last_by_user = {}
    unread_by_user = {}
    for m in rows:
        other = m.recipient if m.sender == me else m.sender
        if other not in last_by_user:
            last_by_user[other] = m
        if m.recipient == me and m.read_at is None:
            unread_by_user[other] = unread_by_user.get(other, 0) + 1

    conversations = []
    for u in others:
        last = last_by_user.get(u.username)
        conversations.append({
            "with": u.username,
            "role": u.role,
            "offices": u.offices or [],
            "unread": unread_by_user.get(u.username, 0),
            "last": last.content if last else None,
            "last_at": last.created_at.isoformat() + "Z" if last else None,
            "last_from": last.sender if last else None,
        })

    with_convo = [c for c in conversations if c["last_at"]]
    without    = [c for c in conversations if not c["last_at"]]
    with_convo.sort(key=lambda c: c["last_at"], reverse=True)
    without.sort(key=lambda c: c["with"].lower())

    return {"conversations": with_convo + without}


@router.get("/unread")
def unread_count(
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    count = (
        db.query(func.count(DirectMessage.id))
        .filter(DirectMessage.recipient == user.username)
        .filter(DirectMessage.read_at == None)  # noqa: E711
        .scalar()
    )
    return {"count": int(count or 0)}


@router.get("/thread/{other}")
def get_thread(
    other: str,
    limit: int = 200,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    me = user.username
    if other == me:
        raise HTTPException(400, "Cannot message yourself")

    limit = max(1, min(limit, 500))
    rows = (
        db.query(DirectMessage)
        .filter(or_(
            and_(DirectMessage.sender == me, DirectMessage.recipient == other),
            and_(DirectMessage.sender == other, DirectMessage.recipient == me),
        ))
        .order_by(DirectMessage.created_at.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    return [_out(m) for m in rows]


@router.post("/thread/{other}")
@limiter.limit("60/minute")
def send_message(
    request: Request,
    other: str,
    payload: MessageIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    me = user.username
    if other == me:
        raise HTTPException(400, "Cannot message yourself")

    recipient = db.query(User).filter(User.username == other).first()
    if not recipient or recipient.status != "active":
        raise HTTPException(404, "Recipient not found")

    content = payload.content.strip()
    if not content:
        raise HTTPException(400, "Message is empty")

    m = DirectMessage(sender=me, recipient=other, content=content)
    db.add(m)
    db.commit()
    db.refresh(m)
    return _out(m)


@router.post("/thread/{other}/read")
def mark_read(
    other: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    me = user.username
    now = datetime.utcnow()
    rows = (
        db.query(DirectMessage)
        .filter(DirectMessage.sender == other)
        .filter(DirectMessage.recipient == me)
        .filter(DirectMessage.read_at == None)  # noqa: E711
        .all()
    )
    for m in rows:
        m.read_at = now
    db.commit()
    return {"marked": len(rows)}


@router.patch("/{msg_id}")
def edit_message(
    msg_id: str,
    payload: MessageIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    m = db.query(DirectMessage).filter(DirectMessage.id == msg_id).first()
    if not m:
        raise HTTPException(404, "Message not found")
    if m.sender != user.username:
        raise HTTPException(403, "You can only edit your own messages")

    content = payload.content.strip()
    if not content:
        raise HTTPException(400, "Message is empty")
    if content == m.content:
        return _out(m)

    m.content = content
    m.edited_at = datetime.utcnow()
    db.commit()
    db.refresh(m)
    return _out(m)


@router.delete("/{msg_id}")
def unsend_message(
    msg_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    m = db.query(DirectMessage).filter(DirectMessage.id == msg_id).first()
    if not m:
        raise HTTPException(404, "Message not found")
    if m.sender != user.username:
        raise HTTPException(403, "You can only unsend your own messages")

    db.delete(m)
    db.commit()
    return {"ok": True}


@router.delete("/thread/{other}")
def delete_thread(
    other: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
):
    me = user.username
    if other == me:
        raise HTTPException(400, "Cannot delete a thread with yourself")

    deleted = (
        db.query(DirectMessage)
        .filter(or_(
            and_(DirectMessage.sender == me, DirectMessage.recipient == other),
            and_(DirectMessage.sender == other, DirectMessage.recipient == me),
        ))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"ok": True, "deleted": deleted}