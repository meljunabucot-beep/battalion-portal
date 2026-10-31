import os
import shutil
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import require_admin
from ..limiter import limiter
from ..models import Document, User, Office

try:
    import psutil
    _HAS_PSUTIL = True
except ImportError:
    _HAS_PSUTIL = False

router = APIRouter(prefix="/api/system")


def _cpu_percent(interval: float = 0.15) -> float:
    if _HAS_PSUTIL:
        try:
            return psutil.cpu_percent(interval=interval)
        except Exception:
            return 0.0
    # Linux fallback
    try:
        def read_stat():
            with open("/proc/stat", "r") as f:
                first = f.readline().split()
            if first[0] != "cpu":
                return 0, 0
            values = [int(x) for x in first[1:]]
            idle = values[3] + values[4]
            total = sum(values)
            return idle, total
        i1, t1 = read_stat()
        time.sleep(interval)
        i2, t2 = read_stat()
        di = i2 - i1
        dt = t2 - t1
        if dt <= 0:
            return 0.0
        return max(0.0, min(100.0, 100.0 * (1.0 - di / dt)))
    except Exception:
        return 0.0


def _mem_info() -> dict:
    if _HAS_PSUTIL:
        try:
            mem = psutil.virtual_memory()
            swap = psutil.swap_memory()
            return {
                "total": mem.total,
                "used": mem.used,
                "available": mem.available,
                "percent": round(mem.percent, 1),
                "swap_total": swap.total,
                "swap_used": swap.used,
                "swap_percent": round(swap.percent, 1) if swap.total else 0.0,
            }
        except Exception:
            pass

    try:
        info = {}
        with open("/proc/meminfo", "r") as f:
            for line in f:
                k, _, v = line.partition(":")
                v = v.strip().split()[0]
                try:
                    info[k] = int(v) * 1024
                except ValueError:
                    pass
        total = info.get("MemTotal", 0)
        available = info.get("MemAvailable", info.get("MemFree", 0))
        used = max(0, total - available)
        swap_total = info.get("SwapTotal", 0)
        swap_free = info.get("SwapFree", 0)
        swap_used = max(0, swap_total - swap_free)
        return {
            "total": total, "used": used, "available": available,
            "percent": round(100.0 * used / total, 1) if total else 0.0,
            "swap_total": swap_total, "swap_used": swap_used,
            "swap_percent": round(100.0 * swap_used / swap_total, 1) if swap_total else 0.0,
        }
    except FileNotFoundError:
        return {
            "total": 0, "used": 0, "available": 0, "percent": 0.0,
            "swap_total": 0, "swap_used": 0, "swap_percent": 0.0,
        }


def _uptime_seconds() -> float:
    if _HAS_PSUTIL:
        try:
            return time.time() - psutil.boot_time()
        except Exception:
            pass
    try:
        with open("/proc/uptime", "r") as f:
            return float(f.read().split()[0])
    except Exception:
        return 0.0

# ... (Keep the _disk_info, _temperature_c, _load_avg, and route functions exactly as they are below this) ...


def _disk_info(path: str = "/") -> dict:
    """Disk usage of the filesystem containing `path`."""
    total, used, free = shutil.disk_usage(path)
    return {
        "total": total,
        "used": used,
        "free": free,
        "percent": round(100.0 * used / total, 1) if total else 0.0,
    }


def _uptime_seconds() -> float:
    try:
        with open("/proc/uptime", "r") as f:
            return float(f.read().split()[0])
    except Exception:
        return 0.0


def _load_avg() -> tuple[float, float, float]:
    try:
        return os.getloadavg()
    except (OSError, AttributeError):
        return (0.0, 0.0, 0.0)


def _temperature_c() -> float | None:
    """
    Best-effort CPU temperature.

    Prefers /sys/class/hwmon/*/temp*_input (real die sensors like coretemp,
    k10temp, zenpower) over /sys/class/thermal/* (often ACPI placeholders
    that never change).

    Returns the highest plausible reading in Celsius, or None if no
    usable sensor is found.
    """
    readings: list[float] = []

    # --- 1. Real hardware monitors via hwmon ---
    # Filenames: temp1_input, temp2_input, ...
    # Skip *_label / *_crit / *_max — we only want current values.
    import glob
    for path in glob.glob("/sys/class/hwmon/hwmon*/temp*_input"):
        try:
            raw = int(open(path).read().strip())
        except (OSError, ValueError):
            continue

        # Most drivers report millidegrees C
        c = raw / 1000.0 if raw > 1000 else float(raw)

        # Sanity window — anything outside is a bad sensor
        if -20.0 <= c <= 150.0:
            readings.append(c)

    # --- 2. Thermal zones (fallback; often ACPI placeholders) ---
    for path in glob.glob("/sys/class/thermal/thermal_zone*/temp"):
        try:
            raw = int(open(path).read().strip())
        except (OSError, ValueError):
            continue

        c = raw / 1000.0 if raw > 1000 else float(raw)
        if -20.0 <= c <= 150.0:
            readings.append(c)

    if not readings:
        return None

    # Highest plausible reading = most relevant (CPU die is always hottest)
    return round(max(readings), 1)


def _cpu_count() -> int:
    try:
        return os.cpu_count() or 1
    except Exception:
        return 1


def _db_size_bytes() -> int:
    url = settings.database_url
    if not url.startswith("sqlite:"):
        return 0
    path = Path(url.replace("sqlite:///", "", 1)).resolve()
    if not path.exists():
        return 0
    return path.stat().st_size


def _storage_size_and_count() -> tuple[int, int]:
    root = Path(settings.storage_dir).resolve()
    if not root.exists():
        return 0, 0
    total = 0
    count = 0
    for p in root.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
                count += 1
            except OSError:
                pass
    return total, count


@router.get("/stats")
@limiter.limit("30/minute")
def system_stats(
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Live system metrics for the admin dashboard."""
    mem = _mem_info()
    disk = _disk_info("/")
    load1, load5, load15 = _load_avg()
    cpu_pct = _cpu_percent()
    temp_c = _temperature_c()

    db_size = _db_size_bytes()
    storage_size, storage_files = _storage_size_and_count()

    counts = {
        "users": db.query(User).count(),
        "documents": db.query(Document).count(),
        "offices": db.query(Office).count(),
    }

    return {
        "timestamp": time.time(),
        "cpu": {
            "percent": round(cpu_pct, 1),
            "cores": _cpu_count(),
        },
        "load": {
            "one": round(load1, 2),
            "five": round(load5, 2),
            "fifteen": round(load15, 2),
        },
        "memory": mem,
        "disk": disk,
        "temperature_c": temp_c,
        "uptime_seconds": _uptime_seconds(),
        "storage": {
            "size": storage_size,
            "files": storage_files,
        },
        "database": {
            "size": db_size,
        },
        "counts": counts,
    }

# ---------------- who's online ----------------

@router.get("/online")
@limiter.limit("60/minute")
def online_users(
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """
    Return the list of usernames currently considered 'online'
    (last_seen within the online window).
    """
    from datetime import datetime, timedelta
    from ..models import ONLINE_WINDOW_SECONDS

    cutoff = datetime.utcnow() - timedelta(seconds=ONLINE_WINDOW_SECONDS)

    rows = (
        db.query(User.id, User.username, User.last_seen)
        .filter(User.status == "active")
        .filter(User.last_seen != None)          # noqa: E711
        .filter(User.last_seen >= cutoff)
        .all()
    )

    return {
        "online": [
            {
                "id": r.id,
                "username": r.username,
                "last_seen": r.last_seen.isoformat() + "Z" if r.last_seen else None,
            }
            for r in rows
        ],
        "window_seconds": ONLINE_WINDOW_SECONDS,
    }