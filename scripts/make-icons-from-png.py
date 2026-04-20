#!/usr/bin/env python3
"""
Convert an arbitrary PNG into the three Chrome-extension icon sizes
(16/48/128) with transparent background. Writes into extension/icons/.

Usage:
    python3 scripts/make-icons-from-png.py <source.png> [crop-bottom-pixels]

The optional second arg trims N pixels from the bottom of the source
(handy for removing watermarks or attribution strips). Default 0.
"""

import sys
from pathlib import Path
from PIL import Image

if len(sys.argv) < 2:
    print(__doc__, file=sys.stderr)
    sys.exit(1)

src_path = Path(sys.argv[1]).expanduser()
crop_bottom = int(sys.argv[2]) if len(sys.argv) > 2 else 0

if not src_path.exists():
    print(f"Source not found: {src_path}", file=sys.stderr)
    sys.exit(1)

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT_DIR.mkdir(parents=True, exist_ok=True)

src = Image.open(src_path).convert("RGBA")
w, h = src.size
print(f"source: {w}x{h}")

# Optional bottom crop (to cut watermark strips)
if crop_bottom > 0:
    src = src.crop((0, 0, w, max(1, h - crop_bottom)))
    w, h = src.size
    print(f"after bottom-crop {crop_bottom}: {w}x{h}")

# Pad to square canvas so aspect stays correct at small icon sizes
side = max(w, h)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(src, ((side - w) // 2, (side - h) // 2))

for size in (16, 48, 128):
    out = canvas.resize((size, size), Image.LANCZOS)
    path = OUT_DIR / f"icon{size}.png"
    out.save(path, "PNG", optimize=True)
    print(f"wrote {path}")
