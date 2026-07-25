// Poker Night Ledger — pure, dependency-free calculation engine.
//
// Design notes:
//  - Runs unchanged in the browser (ES module) and in Node (unit tests).
//  - All money is handled in INTEGER CENTS internally to avoid floating point
//    drift; dollars are only used at the input/output boundary.
//  - The engine is intentionally free of any DOM / I/O so it is trivially
//    unit-testable and reusable.

export const FeeType = Object.freeze({
  NONE: 'none',
  PER_HEAD: 'perHead',
  FLAT: 'flat',
  PERCENT: 'percent',
});

export const FeeScope = Object.freeze({
  ALL: 'all', // fee split across every player (default)
  WINNERS: 'winners', // fee taken only from players with positive poker P&L
});

const DEFAULT_BUY_IN = 100;

/** Convert a dollar amount to integer cents (bankers-safe rounding). */
export const toCents = (dollars) => Math.round(Number(dollars) * 100);

/** Convert integer cents back to a Number of dollars. */
export const toDollars = (cents) => cents / 100;

/** Format integer cents as a signed currency string, e.g. -$70.00. */
export function formatCents(cents, { sign = false } = {}) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const body = `$${(abs / 100).toFixed(2)}`;
  if (neg) return `-${body}`;
  return sign ? `+${body}` : body;
}

/**
 * Distribute `totalCents` across `weights` using the largest-remainder method
 * so the parts sum EXACTLY to totalCents (no rounding leak).
 * @param {number} totalCents
 * @param {number[]} weights  non-negative weights, one per recipient
 * @returns {number[]} integer-cent shares aligned with `weights`
 */
export function largestRemainderSplit(totalCents, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) {
    // Degenerate: split as evenly as possible.
    const base = Math.floor(totalCents / n);
    const shares = new Array(n).fill(base);
    let rem = totalCents - base * n;
    for (let i = 0; i < n && rem > 0; i++, rem--) shares[i] += 1;
    return shares;
  }
  const exact = weights.map((w) => (totalCents * w) / totalWeight);
  const shares = exact.map((x) => Math.floor(x));
  let allocated = shares.reduce((a, b) => a + b, 0);
  let remainder = totalCents - allocated;
  // Hand out the leftover cents to the largest fractional parts.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    shares[order[k].i] += 1;
  }
  return shares;
}

/**
 * Compute the total host-fee pool in cents for a given config + roster.
 */
function computeFeeTotalCents(fee, playerCount, poolCents) {
  if (!fee || fee.type === FeeType.NONE) return 0;
  const value = Number(fee.value) || 0;
  switch (fee.type) {
    case FeeType.PER_HEAD:
      return toCents(value) * playerCount;
    case FeeType.FLAT:
      return toCents(value);
    case FeeType.PERCENT:
      return Math.round((poolCents * value) / 100);
    default:
      throw new Error(`Unknown fee type: ${fee.type}`);
  }
}

/**
 * Core computation. Produces standings + a validated, transaction-minimized
 * settlement plan.
 *
 * @param {{
 *   players: Array<{name:string, buyIn?:number, chips:number}>,
 *   defaultBuyIn?: number,
 *   host?: string|null,
 *   fee?: { type:string, value:number, scope?:string } | null,
 * }} input
 */
export function computeLedger(input) {
  const defaultBuyIn = input.defaultBuyIn ?? DEFAULT_BUY_IN;
  const feeCfg = input.fee ?? { type: FeeType.NONE, value: 0, scope: FeeScope.ALL };
  const scope = feeCfg.scope ?? FeeScope.ALL;

  // --- Normalize + validate roster -----------------------------------------
  const seen = new Set();
  const players = input.players.map((p, idx) => {
    const name = String(p.name ?? '').trim();
    if (!name) throw new Error(`Player #${idx + 1} is missing a name.`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate player name: "${name}".`);
    seen.add(key);
    const buyIn = p.buyIn == null || p.buyIn === '' ? defaultBuyIn : Number(p.buyIn);
    const chips = Number(p.chips);
    if (!Number.isFinite(buyIn) || buyIn < 0) throw new Error(`Invalid buy-in for ${name}.`);
    if (!Number.isFinite(chips) || chips < 0) throw new Error(`Invalid chip count for ${name}.`);
    return { name, buyInCents: toCents(buyIn), chipsCents: toCents(chips) };
  });

  if (players.length === 0) throw new Error('No players provided.');

  const host = input.host ? String(input.host).trim() : null;
  if (host && !players.some((p) => p.name === host)) {
    throw new Error(`Host "${host}" is not in the player list.`);
  }

  // --- Integrity: chips in must equal money in ------------------------------
  const poolCents = players.reduce((a, p) => a + p.buyInCents, 0);
  const chipsCents = players.reduce((a, p) => a + p.chipsCents, 0);
  const chipDiscrepancyCents = chipsCents - poolCents; // +ve = extra chips on table

  // --- Poker P&L (before host fee) ------------------------------------------
  const pokerPnl = new Map();
  for (const p of players) pokerPnl.set(p.name, p.chipsCents - p.buyInCents);

  // --- Host fee -------------------------------------------------------------
  const feeTotalCents = host ? computeFeeTotalCents(feeCfg, players.length, poolCents) : 0;

  // Who pays the fee, and with what weight.
  let payerWeights;
  if (scope === FeeScope.WINNERS) {
    payerWeights = players.map((p) => Math.max(0, pokerPnl.get(p.name)));
    if (payerWeights.every((w) => w === 0)) {
      // No winners (edge case) -> fall back to splitting across everyone.
      payerWeights = players.map(() => 1);
    }
  } else {
    payerWeights = players.map(() => 1); // equal split across all
  }
  const feeShares = largestRemainderSplit(feeTotalCents, payerWeights);
  const feeShareByName = new Map();
  players.forEach((p, i) => feeShareByName.set(p.name, feeShares[i]));

  // --- Net per player = poker P&L - fee share (+ full pool if host) ---------
  const netByName = new Map();
  for (const p of players) {
    let net = pokerPnl.get(p.name) - feeShareByName.get(p.name);
    if (host && p.name === host) net += feeTotalCents; // host collects the pool
    netByName.set(p.name, net);
  }

  // --- Standings (sorted by net desc, then name) ---------------------------
  const standings = players
    .map((p) => ({
      name: p.name,
      isHost: host === p.name,
      buyInCents: p.buyInCents,
      chipsCents: p.chipsCents,
      pokerPnlCents: pokerPnl.get(p.name),
      feeCents: (host === p.name ? feeTotalCents : 0) - feeShareByName.get(p.name),
      netCents: netByName.get(p.name),
    }))
    .sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));

  let rank = 0;
  let prevNet = null;
  standings.forEach((row, i) => {
    if (row.netCents !== prevNet) {
      rank = i + 1;
      prevNet = row.netCents;
    }
    row.rank = rank;
  });

  // --- Settlement -----------------------------------------------------------
  // Only solvable if the table balances to zero. It always will when chips ==
  // pool; we still guard so a bad photo/typo cannot produce a bogus plan.
  const netSum = [...netByName.values()].reduce((a, b) => a + b, 0);
  const balanced = netSum === 0 && chipDiscrepancyCents === 0;
  const transactions = balanced ? settle(netByName) : [];

  return {
    players,
    host,
    poolCents,
    chipsCents,
    chipDiscrepancyCents,
    feeTotalCents,
    standings,
    transactions,
    balanced,
    netSumCents: netSum,
    warnings: buildWarnings({ chipDiscrepancyCents, netSum }),
  };
}

function buildWarnings({ chipDiscrepancyCents, netSum }) {
  const warnings = [];
  if (chipDiscrepancyCents !== 0) {
    const dir = chipDiscrepancyCents > 0 ? 'more' : 'fewer';
    warnings.push(
      `Chip total is off by ${formatCents(Math.abs(chipDiscrepancyCents))} ` +
        `(${dir} chips than money in). Settlement is disabled until this ties out.`
    );
  }
  if (netSum !== 0 && chipDiscrepancyCents === 0) {
    warnings.push(`Net standings do not sum to zero (off by ${formatCents(netSum)}).`);
  }
  return warnings;
}

/**
 * Produce a transaction-minimized settlement from a name->net(cents) map.
 * Returns [{ from, to, amountCents }].
 *
 * Strategy: partition players into the maximum number of disjoint zero-sum
 * groups (exact, via subset DP for small n), then greedily settle within each
 * group. Total transactions = (#nonzero players) - (#groups), which is the
 * information-theoretic minimum.
 */
export function settle(netByName) {
  const entries = [...netByName.entries()].filter(([, c]) => c !== 0);
  const names = entries.map((e) => e[0]);
  const bal = entries.map((e) => e[1]);
  const n = bal.length;
  if (n === 0) return [];

  // Exact partition is O(3^n); cap it and fall back to a single greedy pass
  // (still correct, just not always minimal) for very large tables.
  const groups = n <= 15 ? maxZeroSumPartition(bal) : [[...Array(n).keys()]];

  const txns = [];
  for (const g of groups) {
    greedySettle(
      g.map((i) => ({ name: names[i], amt: bal[i] })),
      txns
    );
  }
  return txns;
}

/** Greedy max-debtor / max-creditor matching within one zero-sum group. */
function greedySettle(group, out) {
  const debtors = group.filter((p) => p.amt < 0).map((p) => ({ name: p.name, amt: -p.amt }));
  const creditors = group.filter((p) => p.amt > 0).map((p) => ({ name: p.name, amt: p.amt }));
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0) out.push({ from: debtors[i].name, to: creditors[j].name, amountCents: pay });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
}

/**
 * Partition indices [0..n) into the maximum number of disjoint subsets that
 * each sum to zero. Returns an array of index-arrays covering every index.
 * Exact dynamic program over bitmasks (O(3^n)).
 */
export function maxZeroSumPartition(bal) {
  const n = bal.length;
  const full = (1 << n) - 1;

  // Precompute subset sums.
  const sum = new Int32Array(1 << n);
  for (let m = 1; m <= full; m++) {
    const low = m & -m;
    const i = 31 - Math.clz32(low);
    sum[m] = sum[m ^ low] + bal[i];
  }

  const best = new Int32Array(1 << n).fill(-1);
  const choice = new Int32Array(1 << n); // which zero-sum submask was peeled off
  best[0] = 0;

  for (let m = 1; m <= full; m++) {
    const low = m & -m; // pin lowest set bit -> canonical, avoids double counting
    for (let s = m; s > 0; s = (s - 1) & m) {
      if (!(s & low)) continue;
      if (sum[s] !== 0) continue;
      const rest = m ^ s;
      if (best[rest] < 0) continue;
      const cand = best[rest] + 1;
      if (cand > best[m]) {
        best[m] = cand;
        choice[m] = s;
      }
    }
  }

  // Reconstruct groups.
  const groups = [];
  let m = full;
  while (m) {
    const s = choice[m];
    const g = [];
    let t = s;
    while (t) {
      const lb = t & -t;
      g.push(31 - Math.clz32(lb));
      t ^= lb;
    }
    groups.push(g);
    m ^= s;
  }
  return groups;
}

/**
 * Build a plain-text WhatsApp-friendly blast from a computed ledger.
 */
export function formatWhatsApp(ledger, { title = 'Poker Night' } = {}) {
  const lines = [];
  lines.push(`*${title} — Final Standings*`);
  lines.push('');
  for (const r of ledger.standings) {
    const tag = r.isHost ? ' (host)' : '';
    lines.push(`${r.rank}. ${r.name}${tag}: ${formatCents(r.netCents, { sign: true })}`);
  }
  lines.push('');
  if (ledger.balanced) {
    lines.push('*Settle Up* ' + `(${ledger.transactions.length} payments)`);
    lines.push('');
    for (const t of ledger.transactions) {
      lines.push(`${t.from} → ${t.to}: ${formatCents(t.amountCents)}`);
    }
  } else {
    lines.push('⚠️ Ledger not balanced — fix chip counts before settling.');
  }
  return lines.join('\n');
}
