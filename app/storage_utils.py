"""
Shared storage helpers — collect and delete every file a document owns.

Used by both documents.py (single delete) and admin.py (bulk delete).
"""
from pathlib import Path

from .config import settings


def collect_storage_keys(d) -> set[str]:
    """
    Every storage key this document owns:
      • file_path            — current file (original upload or signed PDF)
      • preview_pdf_path     — LibreOffice-generated preview
      • signatures[].url     — every placed signature PNG
      • returns[].marked_url — every return-mark overlay
    """
    keys: set[str] = set()

    if d.file_path:
        keys.add(d.file_path)
    if d.preview_pdf_path:
        keys.add(d.preview_pdf_path)

    prefix = settings.storage_public_url + "/"

    def from_url(u: str | None) -> None:
        if u and u.startswith(prefix):
            keys.add(u[len(prefix):])

    for sig in (d.signatures or []):
        from_url(sig.get("url"))
    for ret in (d.returns or []):
        from_url(ret.get("marked_url"))

    return keys


def delete_storage_file(key: str | None) -> None:
    """Best-effort delete of a single storage key. Silent on failure."""
    if not key:
        return
    try:
        p = Path(settings.storage_dir) / key
        p.unlink(missing_ok=True)
    except Exception as e:
        print(f"[storage] could not remove {key}: {e}")


def file_size(key: str | None) -> int:
    """Byte size of a single storage key, 0 if missing."""
    if not key:
        return 0
    try:
        p = Path(settings.storage_dir) / key
        return p.stat().st_size if p.exists() else 0
    except Exception:
        return 0


def doc_size(d) -> int:
    """Total bytes across every file owned by the document."""
    return sum(file_size(k) for k in collect_storage_keys(d))