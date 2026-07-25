# Poker Night Ledger

A free, installable **PWA** that turns a poker night into a balanced, zero-sum
standings table and a **transaction-minimized** settlement plan — then exports a
plain-text WhatsApp blast.

Everything runs **on-device**. No backend, no accounts, no data leaves the phone.
Hosted for free on **GitHub Pages**.

## Features

- Flat buy-in (default **$100**) with per-player overrides for rebuys.
- Dynamic **host fee**: per-player, flat total, or % of pool; paid by everyone or winners only.
- **Zero-sum integrity check** — flags chip/money discrepancies instead of producing a wrong-but-balanced ledger.
- **Minimum-transaction settlement** via exact zero-sum subset partitioning (info-theoretic minimum).
- **WhatsApp export**, offline support, add-to-home-screen install.
- Chip expressions like `60+10` for rebuys.

## Architecture

Three cleanly separated layers:

| Layer | File(s) | Notes |
| --- | --- | --- |
| Deterministic engine | `src/engine.js` | Pure, integer-cents, no DOM. Unit-tested. |
| UI / capture | `index.html`, `styles.css`, `app.js` | Manual/confirm entry + photo reference. |
| PWA shell | `manifest.webmanifest`, `sw.js`, `icons/` | Installable + offline. |

> The engine never trusts the LLM/OCR for math. Extraction (future) only fills the
> entry form; all arithmetic is deterministic and tested.

## Develop

```bash
npm install            # only needed for icon generation
npm test               # run the engine unit tests (node --test)
npm run icons          # rasterize icons/icon.svg -> PNGs (needs sharp)
npm run serve          # http://localhost:8080  (service worker needs http, not file://)
```

## Deploy to GitHub Pages

1. Create a repo (e.g. `poker-ledger`) under your account and push:

   ```bash
   git init && git add . && git commit -m "Poker Night Ledger PWA"
   git branch -M main
   git remote add origin https://github.com/pbandi3/poker-ledger.git
   git push -u origin main
   ```

2. In the repo: **Settings → Pages → Build and deployment → Source = GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) runs the tests and publishes.
   Your app will be live at:

   ```
   https://pbandi3.github.io/poker-ledger/
   ```

4. Open that URL on your iPhone in Safari → **Share → Add to Home Screen**.

## Roadmap

- Optional cloud OCR (photo → prefilled form) behind a serverless key proxy.
- CSV/print export of the final ledger.
