# Poker Night Ledger

A free, installable **PWA** that turns a poker night into a balanced, zero-sum
standings table and a **transaction-minimized** settlement plan, then shares it to
WhatsApp with a link where everyone can mark themselves paid.

The math runs **on-device**. A game only leaves the phone when you copy or share it
(or start a live game); that data goes to a free Supabase project. Hosted for free on
**GitHub Pages**.

## Features

**Calculating a night**

- Flat buy-in (default **$100**) with per-player overrides for rebuys; chip expressions like `60+10`; negative chip counts.
- Dynamic **host fee** (per player, flat, or % of pool; everyone or winners only) and a separate **food** charge paid to whoever ordered.
- **Zero-sum integrity check**: flags chip/money discrepancies instead of producing a wrong-but-balanced ledger.
- **Minimum-transaction settlement** via exact zero-sum subset partitioning.
- **Autosave** across reloads; **New game** clears it explicitly.
- Name suggestions, **Load regulars**, and a **G** button to mark a player as a guest (`Name (guest)`).

**Sharing and tracking**

- **WhatsApp message**: bold standings and settle-up list plus a pay link (copy or native share).
- **Pay page** (`pay.html`): the shared checklist where anyone can tick payments as paid.
- **History** (`history.html`): lifetime standings (poker-only P&L, sortable, year filter, guests hidden by default), who still owes (with a copyable reminder), past games with an "All settled" badge, and fun facts.
- **Player page**: tap a name in the standings for their night-by-night results, a running-total chart, and who they collect from or pay to.
- **Fix mistakes**: *Edit* on a past game reopens it in the calculator (same pay link, ticked payments kept); *Rename a player everywhere* fixes names and guest tags across all games.
- **Backup**: download every game and payment as JSON, or a CSV for a spreadsheet.
- **Live game**: start a game on one phone and finish it on another; edits sync in real time.
- **Test game** switch: keeps a practice game entirely off the database.
- Offline support and add-to-home-screen install.

## Architecture

| Layer | File(s) | Notes |
| --- | --- | --- |
| Deterministic engine | `src/engine.js` | Pure, integer-cents, no DOM. Unit-tested. |
| Live-game merge | `src/draft.js` | Pure merge of two phones' edits. Unit-tested. |
| Saved-game tools | `src/gameTools.js` | Rename, edit-a-game, player history, CSV. Pure, unit-tested. |
| UI / capture | `index.html`, `styles.css`, `app.js` | Entry form, results, live game. |
| History and payments | `history.html/.js`, `pay.html/.js` | Read and update shared games. |
| Backend | `src/supabaseClient.js`, `supabase/*.sql` | Supabase tables `games`, `payments`, `drafts`. |
| Form and regulars logic | `src/formInput.js` | Form values to ledger input; picks regulars. Pure, unit-tested. |
| Browser tests | `e2e/`, `playwright.config.js` | Real-browser flows against a fake Supabase; run on every pull request. |
| PWA shell | `manifest.webmanifest`, `sw.js`, `icons/` | Installable + offline. |

All arithmetic is deterministic and tested. The Supabase key in `src/supabaseClient.js`
is the publishable (public-by-design) key; access is limited by the row-level security
policies in `supabase/`, and there is no login, so anyone with a game's link can view it
and mark payments.

## Supabase setup

1. Create a free Supabase project and put its URL and publishable key in `src/supabaseClient.js`.
2. In **SQL Editor**, run `supabase/schema.sql`, then `supabase/drafts.sql` (both safe to re-run).
3. Free projects pause after 7 days without activity. `.github/workflows/keep-alive.yml`
   pings the project daily; it can't wake one that is already paused (unpause it from the dashboard).

## Develop

No dependencies — nothing to `npm install`.

```bash
npm test               # run the unit tests (node --test)
npm run test:e2e       # browser tests against a fake Supabase (needs Google Chrome; npm install first)
npm run icons          # rasterize icons/icon.svg -> PNGs (macOS: qlmanage + sips)
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
