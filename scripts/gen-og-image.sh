#!/usr/bin/env bash
# Render scripts/og-image.html to og-image.jpg (1200x630), the link-preview card
# WhatsApp shows when a pay link is pasted. Uses headless Chrome + sips on macOS -
# no npm dependencies. Saved as JPEG to stay well under WhatsApp's ~300 KB image
# limit. The image is committed, so this only needs re-running when the design
# changes.
#
# Usage:  bash scripts/gen-og-image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TMP="$(mktemp -t og-image).png"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  echo "Google Chrome not found at: $CHROME" >&2
  exit 1
fi

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --screenshot="$TMP" "file://$PWD/scripts/og-image.html" >/dev/null 2>&1

sips -s format jpeg -s formatOptions 88 "$TMP" --out og-image.jpg >/dev/null
rm -f "$TMP"

sips -g pixelWidth -g pixelHeight og-image.jpg | tail -2
ls -l og-image.jpg | awk '{print $5 " bytes"}'
