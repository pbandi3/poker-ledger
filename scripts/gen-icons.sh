#!/usr/bin/env bash
# Generate PNG icons from icons/icon.svg using only built-in macOS tools
# (QuickLook + sips) — no npm dependencies, no supply chain.
#
# Usage:  npm run icons   (or)   bash scripts/gen-icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="icons/icon.svg"
TMP="icons/.render.png"

if ! command -v qlmanage >/dev/null 2>&1; then
  echo "qlmanage not found (macOS only). Icons are optional; the SVG icon still works." >&2
  exit 0
fi

# Rasterize the SVG at high resolution via QuickLook, then downscale with sips.
qlmanage -t -s 1024 -o icons "$SRC" >/dev/null 2>&1
mv "icons/icon.svg.png" "$TMP"

sips -z 512 512 "$TMP" --out icons/icon-512.png >/dev/null
sips -z 192 192 "$TMP" --out icons/icon-192.png >/dev/null
sips -z 180 180 "$TMP" --out icons/apple-touch-icon.png >/dev/null
# Maskable variant (reuses 512; safe-zone is generous in the source art).
cp icons/icon-512.png icons/icon-maskable-512.png

rm -f "$TMP"
echo "Generated PNG icons in icons/ (192, 512, apple-touch 180, maskable 512)."
