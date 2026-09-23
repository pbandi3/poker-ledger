import { formatCents, formatDate, txnKey } from './src/engine.js';
import { supabase } from './src/supabaseClient.js';

const $ = (id) => document.getElementById(id);
const els = {
  outstandingTable: $('outstandingTable'),
  outstandingNote: $('outstandingNote'),
  copyReminderBtn: $('copyReminderBtn'),
  leaderboardTable: $('leaderboardTable'),
  leaderboardNote: $('leaderboardNote'),
  gamesTable: $('gamesTable'),
  funFactsTable: $('funFactsTable'),
  toast: $('toast'),
};

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

function reminderText(rows) {
  if (!rows.length) return null;
  const lines = ['*Outstanding Payments*', ''];
  for (const r of rows) {
    const breakdown = r.items.map((i) => `${i.to} ${formatCents(i.amountCents)}`).join(', ');
    lines.push(`${r.name} owes ${formatCents(r.totalCents)} (${breakdown})`);
  }
  const totalCents = rows.reduce((a, r) => a + r.totalCents, 0);
  lines.push('');
  lines.push(`${formatCents(totalCents)} total across ${rows.length} player${rows.length === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

async function copyReminder() {
  const text = reminderText(currentOutstandingRows);
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
      const net = s.netCents ?? 0;
      const row = byName.get(s.name) ?? {
        name: s.name,
        games: 0,
        netCents: 0,
        best: -Infinity,
        worst: Infinity,
        hostCount: 0,
        curWinStreak: 0,
        curLossStreak: 0,
        bestWinStreak: 0,
        bestLossStreak: 0,
      };
      row.games += 1;
      row.netCents += net;
      row.best = Math.max(row.best, net);
      row.worst = Math.min(row.worst, net);
      if (s.isHost) row.hostCount += 1;

      if (net > 0) {
        row.curWinStreak += 1;
        row.curLossStreak = 0;
      } else if (net < 0) {
        row.curLossStreak += 1;
        row.curWinStreak = 0;
      } else {
        row.curWinStreak = 0;
        row.curLossStreak = 0;
      }
      row.bestWinStreak = Math.max(row.bestWinStreak, row.curWinStreak);
      row.bestLossStreak = Math.max(row.bestLossStreak, row.curLossStreak);
      byName.set(s.name, row);

      if (!biggestWin || net > biggestWin.netCents) biggestWin = { name: s.name, netCents: net, date: game.date };
      if (!biggestLoss || net < biggestLoss.netCents) biggestLoss = { name: s.name, netCents: net, date: game.date };
    }
  }

  return { players: [...byName.values()], biggestWin, biggestLoss };
}

function renderLeaderboard(players, gameCount) {
  const rows = [...players].sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));

  els.leaderboardNote.textContent = rows.length ? `${rows.length} players across ${gameCount} games` : '';

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
      `${escapeHtml(biggestWin.name)} — ${formatCents(biggestWin.netCents, { sign: true })}${biggestWin.date ? ` (${escapeHtml(formatDate(biggestWin.date))})` : ''}`,
    ]);
  }
  if (biggestLoss) {
    facts.push([
      'Biggest single-night loss',
      `${escapeHtml(biggestLoss.name)} — ${formatCents(biggestLoss.netCents, { sign: true })}${biggestLoss.date ? ` (${escapeHtml(formatDate(biggestLoss.date))})` : ''}`,
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
    els.funFactsTable.innerHTML = '<tbody><tr><td class="muted">Failed to load.</td></tr></tbody>';
    return;
  }

  const { data: payments } = await supabase.from('payments').select('game_id, txn_key, paid');
  const settledByGame = new Map();
  for (const p of payments ?? []) {
    if (!p.paid) continue;
    settledByGame.set(p.game_id, (settledByGame.get(p.game_id) ?? 0) + 1);
  }

  const stats = computePlayerStats(games ?? []);

  renderLeaderboard(stats.players, (games ?? []).length);
  renderOutstanding(computeOutstanding(games ?? [], payments ?? []));
  renderGames(games ?? [], settledByGame);
  renderFunFacts(stats);
}

els.copyReminderBtn.addEventListener('click', copyReminder);
load();
