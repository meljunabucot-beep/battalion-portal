import uuid
from pathlib import Path
from .config import settings

class LocalStorage:
    def __init__(self):
        Path(settings.storage_dir).mkdir(parents=True, exist_ok=True)

    def save(self, subdir: str, filename: str, data: bytes) -> str:
        ext = Path(filename).suffix.lower() or ".bin"
        key = f"{subdir}/{uuid.uuid4()}{ext}"
        dest = Path(settings.storage_dir) / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return key

    def public_url(self, key: str) -> str:
        return f"{settings.storage_public_url}/{key}"

storage = LocalStorage()