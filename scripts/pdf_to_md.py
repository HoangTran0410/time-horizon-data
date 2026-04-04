#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies    = ["pymupdf", "pillow"]
# ///
"""
pdf_to_md.py — Standalone PDF → Markdown converter.

Usage:
    uv run pdf_to_md.py input.pdf                  # → input_muc_luc.md + input_noi_dung.md
    uv run pdf_to_md.py input.pdf out/             # → out/input_muc_luc.md + out/input_noi_dung.md
    uv run pdf_to_md.py input.pdf --lang=eng       # English OCR
    uv run pdf_to_md.py --batch dir/               # Convert all .pdf in dir/

    # Or run directly (dependencies auto-installed on first run via uv):
    python3 pdf_to_md.py input.pdf

Requirements:
    - Python 3.10+
    - uv: https://astral.sh/uv
    - tesseract + Vietnamese language data:
          brew install tesseract tesseract-lang
"""

import sys, os, time, re, subprocess, io
from pathlib import Path

# ── Version guard ──────────────────────────────────────────────────────────────
if sys.version_info < (3, 10):
    sys.exit("Python 3.10+ required")

# ── Imports ────────────────────────────────────────────────────────────────────
import fitz
from PIL import Image, ImageEnhance

# ── Constants ──────────────────────────────────────────────────────────────────
# Note: /tmp has a Leptonica bug with files starting with underscore on some
# macOS builds, so we use a homedir subdirectory for temp files.
_TMP_DIR  = Path.home() / ".cache" / "pdf2md"
_TMP_DIR.mkdir(parents=True, exist_ok=True)
TMP_IN  = str(_TMP_DIR / "ocr_in.png")
TMP_OUT = str(_TMP_DIR / "ocr_out")

# ── Rendering & OCR ────────────────────────────────────────────────────────────

def render_page(page, scale=3.0, contrast=2.2):
    """Render PDF page → contrast-enhanced PNG on disk."""
    mat  = fitz.Matrix(scale, scale)
    pix  = page.get_pixmap(matrix=mat)
    data = pix.tobytes("png")
    img  = Image.open(io.BytesIO(data)).convert("L")
    img  = ImageEnhance.Contrast(img).enhance(contrast)
    img.save(TMP_IN)


def run_tesseract(lang="vie", psm=3):
    """
    Run tesseract on TMP_IN.

    stderr may contain raw binary bytes (PNG magic, etc.).
    We never decode it as text — only read the output .txt file directly.
    """
    subprocess.run(
        ["tesseract", TMP_IN, TMP_OUT,
         "-l", lang, "--oem", "1", "--psm", str(psm)],
        capture_output=True    # keep stderr as bytes — never decode
    )
    txt_file = f"{TMP_OUT}.txt"
    if os.path.exists(txt_file):
        # errors="replace" guards against any stray non-UTF-8 bytes
        with open(txt_file, encoding="utf-8", errors="replace") as f:
            return f.read()
    return ""


def ocr_page(page, scale=3.0, contrast=2.2, psm=3, lang="vie"):
    """OCR one PDF page; auto-retries at higher res on weak output."""
    render_page(page, scale=scale, contrast=contrast)
    text = run_tesseract(lang=lang, psm=psm)
    if not text or len(text.strip()) < 15:
        render_page(page, scale=4.0, contrast=2.5)
        text = run_tesseract(lang=lang, psm=psm)
    return text.strip()


# ── Text cleanup ───────────────────────────────────────────────────────────────

def clean_text(text):
    """Drop obvious OCR noise lines."""
    out = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        # Skip lines that are 1-3 chars containing no word characters
        if re.match(r'^[^\wÀ-ỹ]{1,3}$', line):
            continue
        out.append(line)
    return "\n".join(out)


# ── Heuristics ────────────────────────────────────────────────────────────────

def looks_like_toc(text):
    """Score a page by TOC-like patterns. Returns True if score >= 3."""
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if not lines:
        return False
    score = 0
    for line in lines:
        if re.match(r'^(Bài|Chương|Phần)\s+\d+', line, re.I):
            score += 2
        elif re.match(r'^[IVXLCDM]+\.\s+\S', line):         # Roman numeral
            score += 2
        elif re.match(r'^\d+[\.\)]\s+\S', line):            # 1. Something
            score += 1
        elif re.match(r'^\d+\s+\S', line) and len(line) < 80:
            score += 0.5
    return score >= 3


def looks_like_cover(text):
    """Cover pages have very few lines of real content."""
    meaningful = [l for l in text.split("\n") if len(l.strip()) > 2]
    return len(meaningful) < 4


def looks_like_copyright(text):
    """Copyright / bản quyền page."""
    tl = text.lower()
    return any(kw in tl for kw in [
        "bản quyền", "mã số", "cxb", "tái bản",
        "nhà xuất bản giáo dục", "copyright",
    ])


# ── Core extraction ────────────────────────────────────────────────────────────

def extract_pdf(pdf_path, lang="vie", show_progress=True):
    """
    Extract text from a PDF.

    Strategy:
      1. Native fitz text extraction  (fast, works for text-based PDFs)
      2. OCR fallback                (for scanned/image-based PDFs)

    Returns:
      toc_md, content_md, page_count, toc_start, toc_end
    """
    doc   = fitz.open(pdf_path)
    total = doc.page_count

    all_pages      = []     # (page_number, cleaned_text)
    toc_candidates = []

    for i in range(total):
        page = doc[i]
        pg   = i + 1

        # 1. Native text extraction
        native = page.get_text().strip()
        text   = native if (native and len(native) > 40) else ""

        # 2. OCR fallback
        if not text:
            try:
                text = ocr_page(page, lang=lang)
            except Exception as e:
                if show_progress:
                    print(f"       [!] OCR error p{pg}: {e}")
                text = ""

        cleaned = clean_text(text)

        # Always max-quality-OCR the first 5 pages (cover + TOC)
        if pg <= 5 and len(cleaned) < 100:
            try:
                text2 = ocr_page(page, scale=4.0, contrast=2.5, lang=lang)
                if len(text2) > len(cleaned):
                    cleaned = clean_text(text2)
            except Exception:
                pass

        all_pages.append((pg, cleaned))
        if looks_like_toc(cleaned):
            toc_candidates.append(pg)

        if show_progress and pg % 25 == 0:
            print(f"       ... {pg}/{total} pages")

    doc.close()

    # ── Determine TOC range ───────────────────────────────────────────────
    if toc_candidates:
        toc_start = min(toc_candidates)
        toc_end   = toc_start
        seen      = set(toc_candidates)
        consec    = 0
        for pg in range(toc_start, min(total + 1, 35)):
            in_seen = pg in seen
            is_toc  = in_seen or (pg <= len(all_pages)
                                  and looks_like_toc(all_pages[pg - 1][1]))
            if is_toc:
                toc_end = pg
                consec  = 0
            else:
                consec += 1
                if consec >= 3:
                    break
        if len(toc_candidates) == 1:
            toc_end = min(toc_start + 4, total)
    else:
        toc_start = toc_end = 0   # signal: no TOC found

    # ── Build markdown outputs ─────────────────────────────────────────────
    toc_lines     = []
    content_lines = []

    for pg_num, pg_text in all_pages:
        header   = f"## Trang {pg_num}\n\n"
        is_toc   = toc_start <= pg_num <= toc_end
        is_cover = looks_like_cover(pg_text)
        is_copy  = looks_like_copyright(pg_text)

        if is_toc and not is_cover:
            toc_lines.append(header + pg_text)
        if not is_cover and not is_copy:
            content_lines.append(header + pg_text)

    def join_pages(pages_list):
        return ("\n\n---\n\n".join(pages_list)
                if pages_list
                else "")

    toc_md     = "# MỤC LỤC\n\n"     + join_pages(toc_lines)
    content_md = "# NỘI DUNG ĐẦY ĐỦ\n\n" + join_pages(content_lines)

    return toc_md, content_md, total, toc_start, toc_end


# ── CLI ───────────────────────────────────────────────────────────────────────

def process_one(pdf_path, out_dir=None, lang="vie"):
    name    = pdf_path.stem
    out_dir = Path(out_dir) if out_dir else pdf_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'═' * 60}")
    print(f"  📄 {name}")
    print(f"{'═' * 60}")

    t0 = time.time()
    toc, content, pages, ts, te = extract_pdf(str(pdf_path), lang=lang)

    toc_path     = out_dir / f"{name}_muc_luc.md"
    content_path = out_dir / f"{name}_noi_dung.md"

    toc_path.write_text(toc,          encoding="utf-8")
    content_path.write_text(content,   encoding="utf-8")

    elapsed = time.time() - t0
    toc_len  = len(toc.encode("utf-8"))
    con_len  = len(content.encode("utf-8"))
    print(f"  ✓ {pages}p  |  {elapsed:.0f}s")
    print(f"    TOC:      {toc_path}  ({toc_len:,} bytes)")
    print(f"    Content:  {content_path}  ({con_len:,} bytes)")
    if ts and te:
        print(f"    TOC pages: {ts}–{te}")


def main():
    lang  = "vie"
    batch = False

    # ── Parse args ──────────────────────────────────────────────────────────
    positional = []
    for arg in sys.argv[1:]:
        if arg == "--batch":
            batch = True
        elif arg.startswith("--lang="):
            lang = arg.split("=", 1)[1]
        elif arg in ("-h", "--help"):
            print(__doc__)
            return
        else:
            positional.append(arg)

    if not positional:
        print(__doc__)
        return

    # ── Batch mode ──────────────────────────────────────────────────────────
    if batch:
        input_dir = Path(positional[0])
        if not input_dir.is_dir():
            print(f"Error: --batch expects a directory, got: {input_dir}")
            return
        pdfs = sorted(input_dir.glob("*.pdf"))
        if not pdfs:
            print(f"No .pdf files found in: {input_dir}")
            return
        print(f"Batch mode: {len(pdfs)} PDF(s)\n")
        for pdf_path in pdfs:
            try:
                process_one(pdf_path, lang=lang)
            except Exception as e:
                print(f"  ✗ FAILED: {e}")
                import traceback; traceback.print_exc()
        return

    # ── Single-file mode ───────────────────────────────────────────────────
    pdf_path = Path(positional[0])
    if not pdf_path.is_file():
        print(f"Error: file not found: {pdf_path}")
        return

    out_dir = Path(positional[1]) if len(positional) > 1 else None
    process_one(pdf_path, out_dir=out_dir, lang=lang)


if __name__ == "__main__":
    main()
