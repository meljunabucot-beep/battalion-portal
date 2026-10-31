from .models import User, Document


def user_can_sign(d: Document, user: User) -> bool:
    """Is this user currently allowed to sign / return the document?

    Admins are system operators — they can VIEW everything but must never
    sign. Only the officer whose section currently holds the document, or
    the CO when the document is at the CO step, can sign.
    """
    if user.role == "admin":
        return False

    if d.active_recipient == "co":
        return user.role == "co"

    return user.role == "officer" and d.active_recipient in (user.offices or [])


def user_can_view(d: Document, user: User) -> bool:
    """Can this user see the document (metadata + file)?"""
    if user.role == "admin":
        return True

    if user.role == "co":
        if d.active_recipient == "co":
            return True
        if d.status == "APPROVED":
            return True
        return any((s.get("step") == "CO") for s in (d.signatures or []))

    if user.role == "officer":
        if d.active_recipient in (user.offices or []):
            return True
        return any((s.get("officer") == user.username) for s in (d.signatures or []))

    if user.role == "uploader":
        return d.origin_office in (user.offices or [])

    return False