from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse, HTMLResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Announcement, get_active_offices
from ..deps import current_user, require_user
from ..templates_setup import templates
from ..models import (
    User, Document, Announcement, Office, AppConfig,
    ALL_ROLES, get_all_offices, get_active_offices,
)
router = APIRouter()


def _ctx(request, user, **extra):
    return {"request": request, "user": user, **extra}


@router.get("/", response_class=HTMLResponse)
def home(request: Request, db: Session = Depends(get_db), user=Depends(current_user)):
    anns = db.query(Announcement).order_by(Announcement.created_at.desc()).all()
    return templates.TemplateResponse(request, "home.html", _ctx(request, user, announcements=anns))


@router.get("/activities", response_class=HTMLResponse)
def activities_page(request: Request, user=Depends(require_user)):
    return templates.TemplateResponse(request, "activities.html", _ctx(request, user))


@router.get("/desk", response_class=HTMLResponse)
def upload_desk(request: Request, user=Depends(require_user), db: Session = Depends(get_db)):
    if user.role != "uploader":
        return RedirectResponse("/", status_code=303)
    offices = get_active_offices(db)
    return templates.TemplateResponse(request, "upload_desk.html", _ctx(request, user, offices=offices))


@router.get("/queue", response_class=HTMLResponse)
def review_queue(request: Request, user=Depends(require_user)):
    if user.role not in ("officer", "co", "admin"):
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(request, "review_queue.html", _ctx(request, user))


@router.get("/co", response_class=HTMLResponse)
def co_desk(request: Request, user=Depends(require_user)):
    if user.role != "co":
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(request, "co_desk.html", _ctx(request, user))


from ..models import Announcement, get_active_offices, AppConfig # <-- Add AppConfig here

# ... (keep the rest of the imports the same) ...

@router.get("/admin", response_class=HTMLResponse)
def admin_desk(request: Request, user=Depends(require_user), db: Session = Depends(get_db)):
    if user.role != "admin":
        return RedirectResponse("/", status_code=303)
    offices = get_active_offices(db)
    
    config = db.query(AppConfig).first()
    is_maintenance = config.maintenance_mode if config else False
    lock_uploaders = getattr(config, 'lock_uploaders', False) if config else False
    
    return templates.TemplateResponse(request, "admin_desk.html", _ctx(request, user, 
        offices=offices, 
        is_maintenance=is_maintenance,
        lock_uploaders=lock_uploaders # <-- Pass this to template
    ))


@router.get("/signed", response_class=HTMLResponse)
def signed_gallery(request: Request, user=Depends(require_user), db: Session = Depends(get_db)):
    if user.role not in ("uploader", "officer", "co", "admin"):
        return RedirectResponse("/", status_code=303)
    offices = get_active_offices(db)
    return templates.TemplateResponse(request, "signed_gallery.html", _ctx(request, user, offices=offices))