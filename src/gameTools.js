// Pure helpers for working with saved games: renaming players, rebuilding a
// game's settings so it can be edited, per-player history, and exports.
// No DOM and no network, so everything here is unit-tested.
import { computeLedger, standingPokerPnlCents, txnKey } from './engine.js';

export function gameYear(date) {
  const y = String(date ?? '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : null;
}

// ---- Renaming a player everywhere -------------------------------------------

/** Replace every string in the ledger that is exactly `from` (names, host, txns). */
export function renameInLedger(value, from, to) {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) return value.map((v) => renameInLedger(v, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameInLedger(v, from, to)]));
  }
  return value;
}

/** Payment keys look like "From>To:cents". Returns the key after a rename. */
export function renamePaymentKey(key, from, to) {
  const i = key.lastIndexOf(':');
  const [a, b] = key.slice(0, i).split('>');
  return `${a === from ? to : a}>${b === from ? to : b}${key.slice(i)}`;
}

export function playerNames(games) {
  const names = new Set();
  for (const g of games) for (const s of g.ledger?.standings ?? []) if (s?.name) names.add(s.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * What a rename would touch. `clash` lists games where `to` already plays, which
 * would leave two players with the same name in one game, so those must block.
 */
export function renameImpact(games, payments, from, to) {
  const hit = games.filter((g) => (g.ledger?.standings ?? []).some((s) => s.name === from));
  const clash = hit.filter((g) => (g.ledger.standings ?? []).some((s) => s.name === to));
  const hitIds = new Set(hit.map((g) => g.id));
  const paymentRows = payments.filter(
    (p) => hitIds.has(p.game_id) && renamePaymentKey(p.txn_key, from, to) !== p.txn_key
  );
  const existsElsewhere = games.some(
    (g) => !hitIds.has(g.id) && (g.ledger?.standings ?? []).some((s) => s.name === to)
  );
  return { games: hit, clash, paymentRows, existsElsewhere };
}

// ---- Rebuilding a saved game so it can be edited ------------------------------

const money = (cents) => String(cents / 100);

// Try the ways a pot (host fee / food) could have been configured and keep the
// first one that reproduces the saved numbers exactly.
function inferPot(rows, defaultBuyIn, recipient, field) {
  const base = { defaultBuyIn, players: rows, date: null };
  const adj = (s) => s[field] ?? 0;
  const nonRecipient = rows.filter((r) => r.name !== recipient);
  const paid = nonRecipient.map((r) => -adj(r.saved));
  if (!recipient || paid.every((c) => c === 0)) return null;

  const n = rows.length;
  const total = rows.find((r) => r.name === recipient).saved[field] + Math.round(paid.reduce((a, b) => a + b, 0) / (n - 1));
  const candidates = [
    { type: 'perHead', value: paid[0] / 100, scope: 'all' },
    { type: 'flat', value: total / 100, scope: 'all' },
    { type: 'flat', value: total / 100, scope: 'winners' },
  ];
  // Winners-only pots weight shares by winnings, so solve the total from the recipient's side.
  const W = rows.reduce((a, r) => a + Math.max(0, r.chips - r.buyIn), 0);
  const wr = Math.max(0, rows.find((r) => r.name === recipient).chips - rows.find((r) => r.name === recipient).buyIn);
  if (W > wr) {
    const t = Math.round((paid.reduce((a, b) => a + b, 0) * W) / (W - wr));
    candidates.push({ type: 'flat', value: t / 100, scope: 'winners' });
  }

  for (const cfg of candidates) {
    try {
      const probe = computeLedger(
        field === 'feeCents'
          ? { ...base, host: recipient, fee: cfg }
          : { ...base, food: { recipient, ...cfg } }
      );
      const ok = probe.standings.every((s) => {
        const saved = rows.find((r) => r.name === s.name).saved;
        return (s[field] ?? 0) === (saved[field] ?? 0);
      });
      if (ok) return cfg;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Turn a saved ledger back into form values. The host fee and food setup were
 * never stored, only their effect, so they are worked out by trial; anything that
 * can't be reproduced is left at no fee and reported in `notes`.
 */
export function inferEditableGame(ledger) {
  const standings = [...(ledger.standings ?? [])];
  const counts = new Map();
  for (const s of standings) counts.set(s.buyInCents, (counts.get(s.buyInCents) ?? 0) + 1);
  const defaultCents = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 10000;

  const byEntry = [...standings].sort((a, b) => a.name.localeCompare(b.name));
  const rows = byEntry.map((s) => ({
    name: s.name,
    buyIn: s.buyInCents === defaultCents ? '' : money(s.buyInCents),
    chips: money(s.chipsCents ?? s.buyInCents + (s.pokerPnlCents ?? 0)),
  }));

  const calc = byEntry.map((s) => ({
    name: s.name,
    buyIn: s.buyInCents / 100,
    chips: (s.chipsCents ?? s.buyInCents + (s.pokerPnlCents ?? 0)) / 100,
    saved: s,
  }));

  const notes = [];
  const settings = {
    date: ledger.date ?? '',
    host: ledger.host ?? '',
    buyIn: money(defaultCents),
    feeType: 'none',
    feeValue: '0',
    feeScope: 'all',
    foodRecipient: '',
    foodType: 'perHead',
    foodValue: '0',
    foodScope: 'all',
  };

  const hostRow = standings.find((s) => s.isHost) ?? standings.find((s) => s.name === ledger.host);
  if (hostRow && standings.some((s) => s.feeCents)) {
    const cfg = inferPot(calc, defaultCents / 100, hostRow.name, 'feeCents');
    if (cfg) {
      settings.feeType = cfg.type;
      settings.feeValue = String(cfg.value);
      settings.feeScope = cfg.scope;
    } else {
      notes.push("Couldn't work out the host fee from the saved game. Enter it before calculating.");
    }
  }

  const foodRow = standings.find((s) => s.isFoodRecipient) ?? standings.find((s) => (s.foodCents ?? 0) > 0);
  if (foodRow) {
    const cfg = inferPot(calc, defaultCents / 100, foodRow.name, 'foodCents');
    if (cfg) {
      settings.foodRecipient = foodRow.name;
      settings.foodType = cfg.type;
      settings.foodValue = String(cfg.value);
      settings.foodScope = cfg.scope;
    } else {
      notes.push("Couldn't work out the food setup from the saved game. Enter it before calculating.");
    }
  }

  return { settings, rows, notes };
}

/**
 * Who-pays-whom depends on the order players were entered, which a saved game
 * doesn't remember. So when an edited game's standings come out exactly as saved,
 * keep the saved payments; people may already have ticked them. Returns the saved
 * transactions, or null when anything changed and the plan must be recalculated.
 */
export function reuseSavedPayments(ledger, saved) {
  const nets = (l) =>
    (l.standings ?? [])
      .map((s) => `${s.name}:${s.netCents}`)
      .sort()
      .join('|');
  if (!saved?.transactions || nets(ledger) !== nets(saved)) return null;
  return saved.transactions.map((t) => ({ ...t }));
}

// ---- Per-player history --------------------------------------------------------

/** Night-by-night poker P&L for one player, oldest first, with a running total. */
export function playerTimeline(games, name) {
  const nights = [];
  for (const g of games) {
    const s = (g.ledger?.standings ?? []).find((x) => x.name === name);
    if (!s) continue;
    nights.push({ id: g.id, date: g.date ?? '', pnlCents: standingPokerPnlCents(s), isHost: !!s.isHost });
  }
  nights.sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  for (const n of nights) {
    running += n.pnlCents;
    n.totalCents = running;
  }
  return nights;
}

/**
 * Money that changed hands with each opponent across all settlements. Positive
 * means the player collected from them on balance. Settlements are minimised, so
 * this shows who the player's money actually moved to and from, not every hand.
 */
export function headToHead(games, name) {
  const flow = new Map();
  for (const g of games) {
    for (const t of g.ledger?.transactions ?? []) {
      if (t.to === name) flow.set(t.from, (flow.get(t.from) ?? 0) + t.amountCents);
      else if (t.from === name) flow.set(t.to, (flow.get(t.to) ?? 0) - t.amountCents);
    }
  }
  return [...flow.entries()]
    .map(([opponent, cents]) => ({ opponent, cents }))
    .sort((a, b) => b.cents - a.cents || a.opponent.localeCompare(b.opponent));
}

// ---- Settlement status ---------------------------------------------------------

/** Paid payments that still match a transaction in the game (renames/edits can orphan rows). */
export function settledCount(game, payments) {
  const keys = new Set((game.ledger?.transactions ?? []).map(txnKey));
  return payments.filter((p) => p.paid && p.game_id === game.id && keys.has(p.txn_key)).length;
}

// ---- Export --------------------------------------------------------------------

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per player per game, in dollars, ready for a spreadsheet. */
export function gamesToCsv(games) {
  const header = ['date', 'game_id', 'host', 'player', 'is_host', 'buy_in', 'final_chips', 'poker_pnl', 'host_fee', 'food', 'net'];
  const lines = [header.join(',')];
  const sorted = [...games].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  for (const g of sorted) {
    for (const s of g.ledger?.standings ?? []) {
      lines.push(
        [
          g.date,
          g.id,
          g.host,
          s.name,
          s.isHost ? 'yes' : '',
          s.buyInCents / 100,
          (s.chipsCents ?? 0) / 100,
          standingPokerPnlCents(s) / 100,
          (s.feeCents ?? 0) / 100,
          (s.foodCents ?? 0) / 100,
          s.netCents / 100,
        ]
          .map(csvCell)
          .join(',')
      );
    }
  }
  return lines.join('\n') + '\n';
}
