import {
  formatCents,
  formatDate,
  formatReminderWhatsApp,
  isGuestName,
  standingPokerPnlCents,
  txnKey,
} from './src/engine.js';
import { supabase } from './src/supabaseClient.js';
import {
  gameYear,
  gamesToCsv,
  headToHead,
  playerNames,
  playerTimeline,
  renameImpact,
  renameInLedger,
  renamePaymentKey,
  settledCount,
} from './src/gameTools.js';

const $ = (id) => document.getElementById(id);
const els = {
  outstandingTable: $('outstandingTable'),
  outstandingNote: $('outstandingNote'),
  copyReminderBtn: $('copyReminderBtn'),
  leaderboardTable: $('leaderboardTable'),
  leaderboardNote: $('leaderboardNote'),
  guestSwitch: $('guestSwitch'),
  guestSwitchLabel: $('guestSwitchLabel'),
  showGuests: $('showGuests'),
  yearFilter: $('yearFilter'),
  playerDialog: $('playerDialog'),
  playerTitle: $('playerTitle'),
  playerBody: $('playerBody'),
  playerClose: $('playerClose'),
  exportJsonBtn: $('exportJsonBtn'),
  exportCsvBtn: $('exportCsvBtn'),
  renameFrom: $('renameFrom'),
  renameTo: $('renameTo'),
  renameBtn: $('renameBtn'),
  renameNames: $('renameNames'),
  gamesTable: $('gamesTable'),
  funFactsTable: $('funFactsTable'),
  toast: $('toast'),
};

let allGames = [];
let allPayments = [];

// Set by renderOutstanding, read by copyReminder — avoids recomputing on click.
let currentOutstandingRows = [];

let toastTimer;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function pnlCell(cents) {
  const cls = cents > 0 ? 'pos' : cents < 0 ? 'neg' : '';
  return `<td class="num ${cls}">${formatCents(cents, { sign: true })}</td>`;
}

function paymentsUrl(id) {
  const base = new URL('./pay.html', location.href);
  base.searchParams.set('g', id);
  return base.toString();
}

// One row per debtor, aggregating every unpaid transaction across every
// game (not netted against what they're owed elsewhere — just "what do
// they still need to pay out"), sorted by total owed, biggest first.
function computeOutstanding(games, payments) {
  const paidSet = new Set(
    (payments ?? []).filter((p) => p.paid).map((p) => `${p.game_id}::${p.txn_key}`)
  );

  const byDebtor = new Map();
  for (const game of games) {
    for (const t of game.ledger?.transactions ?? []) {
      if (paidSet.has(`${game.id}::${txnKey(t)}`)) continue;
      const row = byDebtor.get(t.from) ?? { name: t.from, totalCents: 0, items: [] };
      row.totalCents += t.amountCents;
      row.items.push({ to: t.to, amountCents: t.amountCents, date: game.date });
      byDebtor.set(t.from, row);
    }
  }

  const rows = [...byDebtor.values()];
  for (const row of rows) {
    row.items.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    row.oldestDate = row.items[0]?.date ?? null;
  }
  return rows.sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name));
}

async function copyReminder() {
  const text = formatReminderWhatsApp(currentOutstandingRows);
  if (!text) return showToast('Nobody owes anything right now.');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied — paste into WhatsApp');
  } catch {
    showToast('Copy failed — try again');
  }
}

function renderOutstanding(rows) {
  currentOutstandingRows = rows;
  if (!rows.length) {
    els.outstandingNote.textContent = '';
    els.outstandingTable.innerHTML =
      '<tbody><tr><td class="muted">Nobody owes anything right now.</td></tr></tbody>';
    return;
  }

  const totalCents = rows.reduce((a, r) => a + r.totalCents, 0);
  els.outstandingNote.textContent = `${rows.length} player${rows.length === 1 ? '' : 's'} · ${formatCents(totalCents)} outstanding`;

  const body = rows
    .map((r) => {
      const breakdown = r.items
        .map(
          (i) =>
            `${escapeHtml(i.to)} ${formatCents(i.amountCents)}${i.date ? ` (${escapeHtml(formatDate(i.date))})` : ''}`
        )
        .join(', ');
      return `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td class="num neg">${formatCents(r.totalCents)}</td>
          <td class="muted small">${breakdown}</td>
          <td class="muted small col-detail">${r.oldestDate ? escapeHtml(formatDate(r.oldestDate)) : '—'}</td>
        </tr>`;
    })
    .join('');

  els.outstandingTable.innerHTML = `
    <thead>
      <tr><th>Player</th><th class="num">Total owed</th><th>To</th><th class="col-detail">Oldest unpaid</th></tr>
    </thead>
    <tbody>${body}</tbody>`;
}

// Names are matched as-is across games — a spelling like "Bala" vs
// "Balaji" won't net together. No normalization is attempted here.
// Everything here is poker P&L (chips minus buy-in) — host fee and food
// reimbursements are real money owed but not poker winnings, so they stay out
// of lifetime totals, best/worst nights and win/loss streaks.
// Streaks are computed over games in date order per player, treating
// consecutive *appearances* as consecutive (a skipped game night doesn't
// break the streak, since there's no way to tell "skipped" from "not
// invited" from the data alone).
function computePlayerStats(games) {
  const sorted = [...games].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  const byName = new Map();
  let biggestWin = null;
  let biggestLoss = null;

  for (const game of sorted) {
    for (const s of game.ledger?.standings ?? []) {
      if (!s?.name) continue;
      const pnl = standingPokerPnlCents(s);
      const row = byName.get(s.name) ?? {
        name: s.name,
        games: 0,
        pnlCents: 0,
        best: -Infinity,
        worst: Infinity,
        hostCount: 0,
        curWinStreak: 0,
        curLossStreak: 0,
        bestWinStreak: 0,
        bestLossStreak: 0,
      };
      row.games += 1;
      row.pnlCents += pnl;
      row.best = Math.max(row.best, pnl);
      row.worst = Math.min(row.worst, pnl);
      if (s.isHost) row.hostCount += 1;

      if (pnl > 0) {
        row.curWinStreak += 1;
        row.curLossStreak = 0;
      } else if (pnl < 0) {
        row.curLossStreak += 1;
        row.curWinStreak = 0;
      } else {
        row.curWinStreak = 0;
        row.curLossStreak = 0;
      }
      row.bestWinStreak = Math.max(row.bestWinStreak, row.curWinStreak);
      row.bestLossStreak = Math.max(row.bestLossStreak, row.curLossStreak);
      byName.set(s.name, row);

      if (!biggestWin || pnl > biggestWin.pnlCents) biggestWin = { name: s.name, pnlCents: pnl, date: game.date };
      if (!biggestLoss || pnl < biggestLoss.pnlCents) biggestLoss = { name: s.name, pnlCents: pnl, date: game.date };
    }
  }

  return { players: [...byName.values()], biggestWin, biggestLoss };
}

// Sortable columns. Text sorts A-Z first; numbers sort biggest-first first.
// `short` is the compact header used on phones so every column fits.
// The # column is always the lifetime-P&L rank, whatever the sort order.
const LEADERBOARD_COLUMNS = [
  { key: 'name', label: 'Player', cls: '', firstDir: 'asc' },
  { key: 'games', label: 'Games', short: 'Gms', cls: 'num col-detail', firstDir: 'desc' },
  { key: 'pnlCents', label: 'Lifetime P&amp;L', short: 'P&amp;L', cls: 'num', firstDir: 'desc' },
  { key: 'best', label: 'Best night', short: 'Best', cls: 'num', firstDir: 'desc' },
  { key: 'worst', label: 'Worst night', short: 'Worst', cls: 'num', firstDir: 'desc' },
];
let leaderboard = { players: [], gameCount: 0 };
let leaderboardSort = { key: 'pnlCents', dir: 'desc' };

function sortedLeaderboardPlayers() {
  const { key, dir } = leaderboardSort;
  const sign = dir === 'asc' ? 1 : -1;
  return [...leaderboard.players].sort((a, b) => {
    const diff = key === 'name' ? a.name.localeCompare(b.name) : a[key] - b[key];
    return diff * sign || a.name.localeCompare(b.name);
  });
}

function sortHeader({ key, label, short, cls }) {
  const active = leaderboardSort.key === key;
  const ariaSort = active ? (leaderboardSort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = active ? (leaderboardSort.dir === 'asc' ? '▲' : '▼') : '↕';
  return `<th class="${cls}" aria-sort="${ariaSort}"><button type="button" class="sort-btn" data-key="${key}">${short ? `<span class="lbl-full">${label}</span><span class="lbl-short" aria-hidden="true">${short}</span>` : label}<span class="sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
}

function visibleLeaderboardPlayers() {
  return els.showGuests.checked
    ? leaderboard.players
    : leaderboard.players.filter((p) => !isGuestName(p.name));
}

function drawLeaderboard() {
  const visible = new Set(visibleLeaderboardPlayers().map((p) => p.name));
  const rows = sortedLeaderboardPlayers().filter((p) => visible.has(p.name));
  const rankByName = new Map(
    [...leaderboard.players]
      .filter((p) => visible.has(p.name))
      .sort((a, b) => b.pnlCents - a.pnlCents || a.name.localeCompare(b.name))
      .map((p, i) => [p.name, i + 1])
  );

  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="num">${rankByName.get(r.name)}</td>
        <td><button type="button" class="player-link" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button></td>
        <td class="num col-detail">${r.games}</td>
        ${pnlCell(r.pnlCents)}
        ${pnlCell(r.best)}
        ${pnlCell(r.worst)}
      </tr>`
    )
    .join('');

  els.leaderboardTable.innerHTML = `
    <thead>
      <tr>
        <th class="num">#</th>
        ${LEADERBOARD_COLUMNS.map(sortHeader).join('')}
      </tr>
    </thead>
    <tbody>${body}</tbody>`;
}

function updateLeaderboardNote() {
  const { players, gameCount } = leaderboard;
  els.leaderboardNote.textContent = players.length
    ? `${visibleLeaderboardPlayers().length} players across ${gameCount} games${els.yearFilter.value === 'all' ? '' : ` in ${els.yearFilter.value}`} · poker winnings only (host fee & food excluded)`
    : '';
}

function renderLeaderboard(players, gameCount) {
  leaderboard = { players, gameCount };

  const guestCount = players.filter((p) => isGuestName(p.name)).length;
  els.guestSwitch.hidden = guestCount === 0;
  els.guestSwitchLabel.textContent = `Show guests (${guestCount})`;
  updateLeaderboardNote();

  if (!players.length) {
    els.leaderboardTable.innerHTML =
      '<tbody><tr><td class="muted">No shared games yet — use "Copy text" or "Share to WhatsApp" after a calculation to start tracking history.</td></tr></tbody>';
    return;
  }
  drawLeaderboard();
}

els.showGuests.addEventListener('change', () => {
  updateLeaderboardNote();
  drawLeaderboard();
});

els.leaderboardTable.addEventListener('click', (e) => {
  const link = e.target.closest('.player-link');
  if (link) return openPlayer(link.dataset.name);
  const btn = e.target.closest('.sort-btn');
  if (!btn) return;
  const col = LEADERBOARD_COLUMNS.find((c) => c.key === btn.dataset.key);
  if (!col) return;
  leaderboardSort =
    leaderboardSort.key === col.key
      ? { key: col.key, dir: leaderboardSort.dir === 'asc' ? 'desc' : 'asc' }
      : { key: col.key, dir: col.firstDir };
  drawLeaderboard();
  // The redraw replaced the button; hand keyboard focus to its successor.
  els.leaderboardTable.querySelector(`.sort-btn[data-key="${col.key}"]`)?.focus();
});

function renderFunFacts({ players, biggestWin, biggestLoss }) {
  if (!players.length) {
    els.funFactsTable.innerHTML = '<tbody><tr><td class="muted">Not enough history yet.</td></tr></tbody>';
    return;
  }

  const mostHosted = players.reduce((a, b) => (b.hostCount > (a?.hostCount ?? 0) ? b : a), null);
  const longestWinStreak = players.reduce((a, b) => (b.bestWinStreak > (a?.bestWinStreak ?? 0) ? b : a), null);
  const longestLossStreak = players.reduce((a, b) => (b.bestLossStreak > (a?.bestLossStreak ?? 0) ? b : a), null);
  // "Steadiest" needs a few games to mean anything — one game is trivially steady.
  const steadyCandidates = players.filter((p) => p.games >= 3);
  const steadiest = steadyCandidates.reduce(
    (a, b) => (a === null || b.best - b.worst < a.best - a.worst ? b : a),
    null
  );

  const facts = [];
  if (mostHosted && mostHosted.hostCount > 0) {
    facts.push(['Most games hosted', `${escapeHtml(mostHosted.name)} — ${mostHosted.hostCount} times`]);
  }
  if (biggestWin) {
    facts.push([
      'Biggest single-night win',
      `${escapeHtml(biggestWin.name)} — ${formatCents(biggestWin.pnlCents, { sign: true })}${biggestWin.date ? ` (${escapeHtml(formatDate(biggestWin.date))})` : ''}`,
    ]);
  }
  if (biggestLoss) {
    facts.push([
      'Biggest single-night loss',
      `${escapeHtml(biggestLoss.name)} — ${formatCents(biggestLoss.pnlCents, { sign: true })}${biggestLoss.date ? ` (${escapeHtml(formatDate(biggestLoss.date))})` : ''}`,
    ]);
  }
  if (longestWinStreak && longestWinStreak.bestWinStreak >= 2) {
    facts.push(['Longest winning streak', `${escapeHtml(longestWinStreak.name)} — ${longestWinStreak.bestWinStreak} games in a row`]);
  }
  if (longestLossStreak && longestLossStreak.bestLossStreak >= 2) {
    facts.push(['Longest losing streak', `${escapeHtml(longestLossStreak.name)} — ${longestLossStreak.bestLossStreak} games in a row`]);
  }
  if (steadiest) {
    facts.push([
      'Steadiest player (3+ games)',
      `${escapeHtml(steadiest.name)} — swings between ${formatCents(steadiest.worst, { sign: true })} and ${formatCents(steadiest.best, { sign: true })}`,
    ]);
  }

  if (!facts.length) {
    els.funFactsTable.innerHTML = '<tbody><tr><td class="muted">Not enough history yet.</td></tr></tbody>';
    return;
  }

  const body = facts.map(([label, value]) => `<tr><td class="muted">${label}</td><td>${value}</td></tr>`).join('');
  els.funFactsTable.innerHTML = `<tbody>${body}</tbody>`;
}

function editUrl(id) {
  const u = new URL('./index.html', location.href);
  u.searchParams.set('edit', id);
  return u.toString();
}

function renderGames(games) {
  if (!games.length) {
    els.gamesTable.innerHTML =
      '<tbody><tr><td class="muted">No shared games yet.</td></tr></tbody>';
    return;
  }

  const rows = games
    .map((game) => {
      const total = game.ledger?.transactions?.length ?? 0;
      const done = settledCount(game, allPayments);
      const players = game.ledger?.standings?.length ?? 0;
      const status = !total ? 'no payments due' : done >= total ? '✓ All settled' : `${done} of ${total} settled`;
      return `
        <tr>
          <td>${game.date ? escapeHtml(formatDate(game.date)) : '—'}</td>
          <td>${escapeHtml(game.host ?? '—')}</td>
          <td class="num col-detail">${players}</td>
          <td class="${total && done >= total ? 'pos' : ''}">${escapeHtml(status)}</td>
          <td class="nowrap"><a href="${escapeHtml(paymentsUrl(game.id))}">Open</a> · <a href="${escapeHtml(editUrl(game.id))}">Edit</a></td>
        </tr>`;
    })
    .join('');

  els.gamesTable.innerHTML = `
    <thead><tr><th>Date</th><th>Host</th><th class="num col-detail">Players</th><th>Settlement</th><th></th></tr></thead>
    <tbody>${rows}</tbody>`;
}

async function load() {
  const { data: games, error: gamesErr } = await supabase
    .from('games')
    .select('id, date, host, ledger')
    .order('date', { ascending: false, nullsFirst: false });

  if (gamesErr) {
    showToast("Couldn't load game history — check your connection");
    els.outstandingTable.innerHTML = '<tbody><tr><td class="muted">Failed to load.</td></tr></tbody>';
    els.leaderboardTable.innerHTML = '<tbody><tr><td class="muted">Failed to load.</td></tr></tbody>';
    els.gamesTable.innerHTML = '<tbody><tr><td class="muted">Failed to load.</td></tr></tbody>';
    els.funFactsTable.innerHTML = '<tbody><tr><td class="muted">Failed to load.</td></tr></tbody>';
    return;
  }

  const { data: payments } = await supabase.from('payments').select('game_id, txn_key, paid');
  allGames = games ?? [];
  allPayments = payments ?? [];
  renderYearOptions();
  renderPlayerPickers();
  renderAll();
}

// Lifetime standings and fun facts follow the year filter; everything else is all-time.
function gamesInYear() {
  const y = els.yearFilter.value;
  return y === 'all' ? allGames : allGames.filter((g) => gameYear(g.date) === y);
}

function renderAll() {
  const inYear = gamesInYear();
  const stats = computePlayerStats(inYear);
  renderLeaderboard(stats.players, inYear.length);
  renderOutstanding(computeOutstanding(allGames, allPayments));
  renderGames(allGames);
  renderFunFacts(stats);
}

function renderYearOptions() {
  const years = [...new Set(allGames.map((g) => gameYear(g.date)).filter(Boolean))].sort().reverse();
  const keep = els.yearFilter.value;
  els.yearFilter.innerHTML =
    '<option value="all">All time</option>' + years.map((y) => `<option value="${y}">${y}</option>`).join('');
  els.yearFilter.value = years.includes(keep) ? keep : 'all';
}

els.yearFilter.addEventListener('change', renderAll);

// ---- Player page --------------------------------------------------------------
function sparkline(nights) {
  if (nights.length < 2) return '';
  const W = 300;
  const H = 80;
  const pad = 6;
  const vals = nights.map((n) => n.totalCents);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (i) => pad + (i * (W - 2 * pad)) / (nights.length - 1);
  const y = (v) => H - pad - ((v - lo) * (H - 2 * pad)) / span;
  const pts = nights.map((n, i) => `${x(i).toFixed(1)},${y(n.totalCents).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  return `<svg class="spark ${last >= 0 ? 'up' : 'down'}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Running poker total by night">
    <line class="zero" x1="${pad}" x2="${W - pad}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>
    <polyline points="${pts}"></polyline>
    <circle cx="${x(nights.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5"></circle>
  </svg>`;
}

function openPlayer(name) {
  const nights = playerTimeline(allGames, name);
  if (!nights.length) return;
  const total = nights.reduce((a, n) => a + n.pnlCents, 0);
  const wins = nights.filter((n) => n.pnlCents > 0).length;
  const flow = headToHead(allGames, name);
  const collects = flow.filter((f) => f.cents > 0).slice(0, 3);
  const pays = flow.filter((f) => f.cents < 0).slice(-3).reverse();
  const flowRows = (list) =>
    list.length
      ? list.map((f) => `<tr><td>${escapeHtml(f.opponent)}</td>${pnlCell(f.cents)}</tr>`).join('')
      : '<tr><td class="muted">Nobody yet</td><td></td></tr>';

  els.playerTitle.textContent = name;
  els.playerBody.innerHTML = `
    <p class="muted small">${nights.length} night${nights.length === 1 ? '' : 's'} · won ${wins} · lifetime poker P&amp;L
      <b class="${total >= 0 ? 'pos' : 'neg'}">${formatCents(total, { sign: true })}</b> (all time, host fee &amp; food excluded)</p>
    ${sparkline(nights)}
    <h3 class="sub-head">Money moved with</h3>
    <div class="h2h">
      <table class="report"><thead><tr><th>Collects from</th><th class="num">Total</th></tr></thead><tbody>${flowRows(collects)}</tbody></table>
      <table class="report"><thead><tr><th>Pays to</th><th class="num">Total</th></tr></thead><tbody>${flowRows(pays)}</tbody></table>
    </div>
    <p class="muted small">From settlement payments, which are minimised, so this shows where the money actually went.</p>
    <h3 class="sub-head">Night by night</h3>
    <table class="report"><thead><tr><th>Date</th><th class="num">Poker P&amp;L</th><th class="num">Running</th></tr></thead><tbody>
      ${[...nights]
        .reverse()
        .map(
          (n) => `<tr><td>${n.date ? escapeHtml(formatDate(n.date)) : '—'}${n.isHost ? ' <span class="muted small">(host)</span>' : ''}</td>${pnlCell(n.pnlCents)}${pnlCell(n.totalCents)}</tr>`
        )
        .join('')}
    </tbody></table>`;
  els.playerDialog.showModal();
  els.playerBody.scrollTop = 0;
}

els.playerClose.addEventListener('click', () => els.playerDialog.close());
els.playerDialog.addEventListener('click', (e) => {
  if (e.target === els.playerDialog) els.playerDialog.close(); // tap on the backdrop
});

// ---- Backup -------------------------------------------------------------------
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

els.exportJsonBtn.addEventListener('click', () => {
  if (!allGames.length) return showToast('Nothing to back up yet.');
  const backup = { exportedAt: new Date().toISOString(), games: allGames, payments: allPayments };
  download(`poker-ledger-backup-${stamp()}.json`, JSON.stringify(backup, null, 2), 'application/json');
  showToast(`Saved ${allGames.length} games`);
});

els.exportCsvBtn.addEventListener('click', () => {
  if (!allGames.length) return showToast('Nothing to export yet.');
  download(`poker-ledger-${stamp()}.csv`, gamesToCsv(allGames), 'text/csv');
  showToast(`Saved ${allGames.length} games`);
});

// ---- Rename a player everywhere ------------------------------------------------
function renderPlayerPickers() {
  const names = playerNames(allGames);
  els.renameFrom.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  els.renameNames.innerHTML = els.renameFrom.innerHTML;
}

async function renameEverywhere() {
  const from = els.renameFrom.value;
  const to = els.renameTo.value.trim().replace(/\s+/g, ' ');
  if (!from) return;
  if (!to) return showToast('Type the new name first.');
  if (to === from) return showToast('That is already the name.');

  const impact = renameImpact(allGames, allPayments, from, to);
  if (impact.clash.length) {
    const dates = impact.clash.map((g) => formatDate(g.date)).join(', ');
    return showToast(`"${to}" already plays in the same game (${dates}). Rename or remove one first.`);
  }
  const merge = impact.existsElsewhere
    ? `\n\n"${to}" already exists in other games, so those results will be combined under one name.`
    : '';
  const ok = confirm(
    `Rename "${from}" to "${to}"?\n\n${impact.games.length} game${impact.games.length === 1 ? '' : 's'} and ` +
      `${impact.paymentRows.length} payment record${impact.paymentRows.length === 1 ? '' : 's'} will change. ` +
      `Anyone with an old pay link will see the new name.${merge}`
  );
  if (!ok) return;

  els.renameBtn.disabled = true;
  try {
    for (const g of impact.games) {
      const { error } = await supabase
        .from('games')
        .update({
          ledger: renameInLedger(g.ledger, from, to),
          host: g.host === from ? to : g.host,
          updated_at: new Date().toISOString(),
        })
        .eq('id', g.id);
      if (error) throw error;
    }
    for (const p of impact.paymentRows) {
      const { error } = await supabase
        .from('payments')
        .update({ txn_key: renamePaymentKey(p.txn_key, from, to) })
        .eq('game_id', p.game_id)
        .eq('txn_key', p.txn_key);
      if (error) throw error;
    }
    showToast(`Renamed in ${impact.games.length} game${impact.games.length === 1 ? '' : 's'}`);
    els.renameTo.value = '';
    await load();
  } catch (err) {
    showToast(`Stopped part-way: ${err.message || 'network error'}. Reload and try again.`);
  } finally {
    els.renameBtn.disabled = false;
  }
}

els.renameBtn.addEventListener('click', renameEverywhere);
els.copyReminderBtn.addEventListener('click', copyReminder);
load();
