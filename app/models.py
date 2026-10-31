import uuid
from datetime import datetime, timedelta
from sqlalchemy import String, Integer, DateTime, Text, JSON, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base

def _uuid() -> str:
    return str(uuid.uuid4())


# Online window — a user is "online" if seen within this many seconds
ONLINE_WINDOW_SECONDS = 120


DEFAULT_OFFICES = [
    {"code": "s1",       "name": "S1 — Personnel",            "sort_order": 10},
    {"code": "s2",       "name": "S2 — Intelligence",         "sort_order": 20},
    {"code": "s3",       "name": "S3 — Operations",           "sort_order": 30},
    {"code": "s4",       "name": "S4 — Logistics",            "sort_order": 40},
    {"code": "s6",       "name": "S6 — Signal",               "sort_order": 50},
    {"code": "s7",       "name": "S7 — Civil Affairs",        "sort_order": 60},
    {"code": "hhc",      "name": "HHC — Headquarters",        "sort_order": 70},
    {"code": "motorpol", "name": "Motorpol",                  "sort_order": 80},
    {"code": "atr",      "name": "ATR",                       "sort_order": 90},
    {"code": "finance",  "name": "Finance",                   "sort_order": 100},
    {"code": "exo",      "name": "EXO — Executive Officer",   "sort_order": 110},
]

ALL_ROLES         = ["uploader", "officer", "co", "admin"]
REQUESTABLE_ROLES = ["uploader", "officer"]


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    requested_role: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    offices: Mapped[list] = mapped_column(JSON, default=list)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # --- Login lockout state ---
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    session_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    @property
    def office_label(self) -> str:
        if not self.offices:
            return "—"
        return ", ".join(o.upper() for o in self.offices)

    @property
    def is_online(self) -> bool:
        """True if this user made an authenticated request recently."""
        if not self.last_seen:
            return False
        return (datetime.utcnow() - self.last_seen) < timedelta(seconds=ONLINE_WINDOW_SECONDS)

    @property
    def last_seen_label(self) -> str:
        """Human-readable last-seen string for tooltips."""
        if not self.last_seen:
            return "Never"
        delta = datetime.utcnow() - self.last_seen
        secs = int(delta.total_seconds())
        if secs < 60:
            return "Just now"
        if secs < 3600:
            return f"{secs // 60}m ago"
        if secs < 86400:
            return f"{secs // 3600}h ago"
        return f"{secs // 86400}d ago"

    @property
    def is_locked(self) -> bool:
        return bool(self.locked_until and self.locked_until > datetime.utcnow())

    @property
    def lockout_seconds_remaining(self) -> int:
        if not self.locked_until:
            return 0
        delta = (self.locked_until - datetime.utcnow()).total_seconds()
        return max(0, int(delta))


class Office(Base):
    __tablename__ = "offices"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    @property
    def label(self) -> str:
        return self.code.upper()


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(255))
    type: Mapped[str] = mapped_column(String(64))
    origin_office: Mapped[str] = mapped_column(String(32))
    route_chain: Mapped[list] = mapped_column(JSON)
    current_step_index: Mapped[int] = mapped_column(Integer, default=0)
    active_recipient: Mapped[str] = mapped_column(String(64))
    remarks: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_name: Mapped[str] = mapped_column(String(255))
    file_type: Mapped[str] = mapped_column(String(128))
    file_path: Mapped[str] = mapped_column(String(512))
    file_url: Mapped[str] = mapped_column(String(1024))
    preview_pdf_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    attached_files: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    signatures: Mapped[list] = mapped_column(JSON, default=list)
    history_logs: Mapped[list] = mapped_column(JSON, default=list)
    returns: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Activity(Base):
    __tablename__ = "activities"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    activity_date: Mapped[str] = mapped_column(String(10), index=True)
    activity_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    office: Mapped[str | None] = mapped_column(String(32), nullable=True)  # <-- ADD THIS
    created_by: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    
class Announcement(Base):
    __tablename__ = "announcements"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(255))
    content: Mapped[str] = mapped_column(Text)
    priority: Mapped[str] = mapped_column(String(32), default="General")
    author: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DirectMessage(Base):
    __tablename__ = "direct_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    sender: Mapped[str] = mapped_column(String(64), index=True)
    recipient: Mapped[str] = mapped_column(String(64), index=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


# ---------------- helpers ----------------

def seed_offices(db) -> bool:
    if db.query(Office).count() == 0:
        for o in DEFAULT_OFFICES:
            db.add(Office(**o))
        db.commit()
        return True
    return False


def get_active_offices(db):
    return (
        db.query(Office)
        .filter(Office.active == True)
        .order_by(Office.sort_order.asc(), Office.code.asc())
        .all()
    )


def get_all_offices(db):
    return (
        db.query(Office)
        .order_by(Office.sort_order.asc(), Office.code.asc())
        .all()
    )

class AppConfig(Base):
    __tablename__ = "app_config"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    maintenance_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    lock_uploaders: Mapped[bool] = mapped_column(Boolean, default=False)