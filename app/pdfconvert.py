"""
LibreOffice-driven document → PDF conversion + pypdf signature overlay.
"""
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from pypdf import PdfReader, PdfWriter

CONVERTIBLE_EXTENSIONS = {
    ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
    ".odt", ".ods", ".odp",
}


def find_libreoffice() -> str | None:
    for name in ("libreoffice", "soffice"):
        p = shutil.which(name)
        if p:
            return p
    if sys.platform == "win32":
        candidates = [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ]
    else:
        candidates = ["/usr/bin/libreoffice", "/usr/bin/soffice", "/opt/libreoffice/program/soffice"]
    for c in candidates:
        if Path(c).exists():
            return c
    return None


def can_convert(ext: str) -> bool:
    return ext.lower() in CONVERTIBLE_EXTENSIONS and find_libreoffice() is not None


def _sanitize_docx(src_path: Path, dst_path: Path) -> bool:
    """
    Fixes a known LibreOffice bug where tables with auto-width or 0-width
    cause infinite column rendering (printing thousands of pages of years).
    It forces the table width to 100% (5000 pct) in the XML.
    """
    try:
        with zipfile.ZipFile(src_path, 'r') as zin:
            with zipfile.ZipFile(dst_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    content = zin.read(item.filename)
                    if item.filename == 'word/document.xml':
                        xml_str = content.decode('utf-8', errors='replace')
                        
                        # Replace auto-width and 0-width tables with 100% width
                        xml_str = re.sub(
                            r'<w:tblW\s+w:type="auto"\s*/?>',
                            '<w:tblW w:w="5000" w:type="pct"/>',
                            xml_str
                        )
                        xml_str = re.sub(
                            r'<w:tblW\s+w:w="0"\s+w:type="dxa"\s*/?>',
                            '<w:tblW w:w="5000" w:type="pct"/>',
                            xml_str
                        )
                        content = xml_str.encode('utf-8')
                    zout.writestr(item, content)
        return True
    except Exception as e:
        print(f"[pdfconvert] sanitize failed: {e}")
        return False


def convert_to_pdf(src_path: Path, out_dir: Path) -> Path | None:
    lo = find_libreoffice()
    if not lo:
        return None

    src_path = Path(src_path).resolve()
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not src_path.exists():
        return None

    with tempfile.TemporaryDirectory(prefix="lo-work-") as workdir:
        workdir = Path(workdir)
        profile_dir = workdir / "profile"
        home_dir = workdir / "home"
        cache_dir = home_dir / ".cache"
        config_dir = home_dir / ".config"
        profile_dir.mkdir()
        cache_dir.mkdir(parents=True)
        config_dir.mkdir(parents=True)

        env = os.environ.copy()
        env["HOME"] = str(home_dir)
        env["XDG_CACHE_HOME"] = str(cache_dir)
        env["XDG_CONFIG_HOME"] = str(config_dir)
        env["XDG_RUNTIME_DIR"] = str(workdir / "runtime")
        (workdir / "runtime").mkdir()
        os.chmod(workdir / "runtime", 0o700)

        # --- SANITIZE DOCX BEFORE CONVERSION ---
        target_src = src_path
        if src_path.suffix.lower() == ".docx":
            safe_src = workdir / f"safe_{src_path.name}"
            if _sanitize_docx(src_path, safe_src):
                target_src = safe_src

        cmd = [
            lo,
            f"-env:UserInstallation={profile_dir.as_uri()}",
            "--headless",
            "--norestore",
            "--nologo",
            "--nolockcheck",
            "--nodefault",
            "--convert-to", "pdf",
            "--outdir", str(out_dir),
            str(target_src),
        ]

        try:
            result = subprocess.run(
                cmd, check=True, capture_output=True, timeout=180, env=env, cwd=str(workdir)
            )
        except subprocess.CalledProcessError as e:
            print(f"[pdfconvert] libreoffice failed: {e.stderr.decode(errors='replace')}")
            return None
        except Exception:
            return None

    # LibreOffice names the output by replacing the extension
    stem = src_path.stem
    candidates = [out_dir / f"{stem}.pdf", out_dir / f"{src_path.name}.pdf"]
    
    # If we used the sanitized version, the output might be named safe_file.pdf
    if target_src != src_path:
        candidates.append(out_dir / f"safe_{stem}.pdf")
        candidates.append(out_dir / f"{target_src.name}.pdf")

    for c in candidates:
        if c.exists():
            # Rename to the original filename so the rest of the app doesn't break
            if c.name != f"{stem}.pdf":
                c.rename(out_dir / f"{stem}.pdf")
            return out_dir / f"{stem}.pdf"

    pdfs = sorted(out_dir.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
    return pdfs[0] if pdfs else None


def overlay_signatures(
    pdf_path: Path,
    signatures: list[dict],
    storage_root: Path,
    storage_public_url: str,
    out_path: Path,
) -> bool:
    try:
        from reportlab.pdfgen import canvas as rl_canvas
        from reportlab.lib.utils import ImageReader
    except ImportError:
        return False

    if not pdf_path.exists():
        return False

    by_page: dict[int, list[dict]] = {}
    for s in signatures:
        idx = int(s.get("page") or 0)
        by_page.setdefault(idx, []).append(s)

    reader = PdfReader(str(pdf_path))
    writer = PdfWriter()

    for i, page in enumerate(reader.pages):
        if i in by_page:
            page_w_pts = float(page.mediabox.width)
            page_h_pts = float(page.mediabox.height)

            overlay_buf = io.BytesIO()
            c = rl_canvas.Canvas(overlay_buf, pagesize=(page_w_pts, page_h_pts))

            for sig in by_page[i]:
                url = sig.get("url") or ""
                if not url.startswith(storage_public_url + "/"):
                    continue
                rel = url[len(storage_public_url) + 1:]
                sig_file = storage_root / rel
                if not sig_file.exists():
                    continue

                cw = float(sig.get("page_width") or page_w_pts)
                ch = float(sig.get("page_height") or page_h_pts)
                sig_w_css = float(sig.get("width") or 0)
                sig_h_css = float(sig.get("height") or 0)
                
                if cw <= 0 or ch <= 0 or sig_w_css <= 0 or sig_h_css <= 0:
                    continue

                sx = page_w_pts / cw
                sy = page_h_pts / ch

                x_pts = float(sig.get("x") or 0) * sx
                w_pts = sig_w_css * sx
                h_pts = sig_h_css * sy
                y_top_pts = float(sig.get("y") or 0) * sy
                y_pts = page_h_pts - y_top_pts - h_pts

                try:
                    c.drawImage(ImageReader(str(sig_file)), x_pts, y_pts, width=w_pts, height=h_pts, mask="auto")
                except Exception:
                    pass

            c.save()
            overlay_buf.seek(0)
            overlay_page = PdfReader(overlay_buf).pages[0]
            page.merge_page(overlay_page)

        writer.add_page(page)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        writer.write(f)
    return True