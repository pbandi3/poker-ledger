import { formatCents, formatDate, txnKey } from './src/engine.js';
import { supabase } from './src/supabaseClient.js';

const $ = (id) => document.getElementById(id);
const els = {
  outstandingTable: $('outstandingTable'),
  outstandingNote: $('outstandingNote'),
  leaderboardTable: $('leaderboardTable'),
  leaderboardNote: $('leaderboardNote'),
  gamesTable: $('gamesTable'),
  toast: $('toast'),
};

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

function renderOutstanding(rows) {
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

function renderLeaderboard(games) {
  // Names are matched as-is across games — a spelling like "Bala" vs
  // "Balaji" won't net together. No normalization is attempted here.
  const byName = new Map();
  for (const game of games) {
    const standings = game.ledger?.standings ?? [];
    for (const s of standings) {
      if (!s?.name) continue;
      const row = byName.get(s.name) ?? { name: s.name, games: 0, netCents: 0, best: -Infinity, worst: Infinity };
      row.games += 1;
      row.netCents += s.netCents ?? 0;
      row.best = Math.max(row.best, s.netCents ?? 0);
      row.worst = Math.min(row.worst, s.netCents ?? 0);
      byName.set(s.name, row);
    }
  }

  const rows = [...byName.values()].sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));

  els.leaderboardNote.textContent = rows.length ? `${rows.length} players across ${games.length} games` : '';

  if (!rows.length) {
    els.leaderboardTable.innerHTML =
      '<tbody><tr><td class="muted">No shared games yet — use "Copy text" or "Share to WhatsApp" after a calculation to start tracking history.</td></tr></tbody>';
    return;
  }

  const body = rows
    .map(
      (r, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>${escapeHtml(r.name)}</td>
        <td class="num col-detail">${r.games}</td>
        ${pnlCell(r.netCents)}
        ${pnlCell(r.best)}
        ${pnlCell(r.worst)}
      </tr>`
    )
    .join('');

  els.leaderboardTable.innerHTML = `
    <thead>
      <tr>
        <th class="num">#</th><th>Player</th>
        <th class="num col-detail">Games</th>
        <th class="num">Lifetime net</th><th class="num">Best night</th><th class="num">Worst night</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>`;
}

function renderGames(games, settledByGame) {
  if (!games.length) {
    els.gamesTable.innerHTML =
      '<tbody><tr><td class="muted">No shared games yet.</td></tr></tbody>';
    return;
  }

  const rows = games
    .map((game) => {
      const total = game.ledger?.transactions?.length ?? 0;
      const done = settledByGame.get(game.id) ?? 0;
      const players = game.ledger?.standings?.length ?? 0;
      const status = total ? `${done} of ${total} settled` : 'no payments due';
      return `
        <tr>
          <td>${game.date ? escapeHtml(formatDate(game.date)) : '—'}</td>
          <td>${escapeHtml(game.host ?? '—')}</td>
          <td class="num col-detail">${players}</td>
          <td>${escapeHtml(status)}</td>
          <td><a href="${escapeHtml(paymentsUrl(game.id))}">Open</a></td>
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
    return;
  }

  const { data: payments } = await supabase.from('payments').select('game_id, txn_key, paid');
  const settledByGame = new Map();
  for (const p of payments ?? []) {
    if (!p.paid) continue;
    settledByGame.set(p.game_id, (settledByGame.get(p.game_id) ?? 0) + 1);
  }

  renderOutstanding(computeOutstanding(games ?? [], payments ?? []));
  renderLeaderboard(games ?? []);
  renderGames(games ?? [], settledByGame);
}

load();
