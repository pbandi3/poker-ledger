// Turns what is typed into the form into computeLedger input, and picks regulars
// from saved games. Pure (no DOM, no network) so it is unit-tested.
import { isGuestName } from './engine.js';

/** "60+10" style additive expression. Blank -> null, anything else invalid -> NaN. */
export function parseAmount(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  if (!/^-?[\d+.\s]+$/.test(s)) return NaN;
  return s
    .split('+')
    .map((t) => Number(t.trim()))
    .reduce((a, b) => a + b, 0);
}

/**
 * @param rows  [{ name, buyIn, chips }] as typed
 * @param s     the settings strings: date, buyIn, host, feeType, feeValue, feeScope,
 *              foodRecipient, foodType, foodValue, foodScope
 * @returns {{ input } | { error: string }}
 */
export function buildLedgerInput(rows, s) {
  const players = [];
  for (const r of rows) {
    if (!r.name) return { error: 'Every row needs a name.' };
    const chips = parseAmount(r.chips) ?? 0;
    if (Number.isNaN(chips)) return { error: `Bad chip value for ${r.name}.` };
    const buyIn = r.buyIn === '' ? null : parseAmount(r.buyIn);
    if (buyIn !== null && Number.isNaN(buyIn)) return { error: `Bad buy-in for ${r.name}.` };
    players.push({ name: r.name, chips, ...(buyIn !== null ? { buyIn } : {}) });
  }
  if (players.length === 0) return { error: 'Add at least one player.' };

  // Host fee is active only when someone is set to receive it AND the amount is non-zero.
  const feeValue = parseAmount(s.feeValue) ?? 0;
  if (Number.isNaN(feeValue)) return { error: 'Bad host fee amount.' };
  if (s.feeType !== 'none' && feeValue > 0 && !s.host) {
    return { error: 'Select who received the host fee, or set fee type to No fee.' };
  }

  // Food is active only when someone fronted it AND the amount is non-zero.
  const foodValue = parseAmount(s.foodValue) ?? 0;
  if (Number.isNaN(foodValue)) return { error: 'Bad food amount.' };
  if (foodValue > 0 && !s.foodRecipient) {
    return { error: 'Select who paid for food, or set the food amount to $0.' };
  }
  const food =
    foodValue > 0 && s.foodRecipient
      ? { recipient: s.foodRecipient, type: s.foodType, value: foodValue, scope: s.foodScope }
      : null;

  return {
    input: {
      defaultBuyIn: parseAmount(s.buyIn) ?? 100,
      date: s.date || null,
      host: s.host || null,
      fee: { type: s.feeType, value: feeValue, scope: s.feeScope },
      food,
      players,
    },
  };
}

/**
 * Names for the suggestion list (everyone ever seen) and the "regulars"
 * (played `minGames`+ times, guests never included), most games first.
 */
export function countRegulars(games, minGames) {
  const counts = new Map();
  for (const g of games ?? []) {
    const names = new Set((g.ledger?.standings ?? []).map((s) => s?.name).filter(Boolean));
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const allNames = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const regulars = [...counts.entries()]
    .filter(([name, count]) => count >= minGames && !isGuestName(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  return { allNames, regulars };
}

const money = (v) => `$${Number(v)}`;

/** "$20 per player", "$30 flat", "10% of pool", "no fee" (+ ", winners only"). */
export function describeFee({ feeType, feeValue, feeScope }) {
  const v = Number(feeValue) || 0;
  if (feeType === 'none' || v === 0) return 'no fee';
  const base =
    feeType === 'perHead' ? `${money(v)} per player` : feeType === 'flat' ? `${money(v)} flat` : `${v}% of pool`;
  return feeScope === 'winners' ? `${base}, winners only` : base;
}

/** True when two settings objects mean the same host fee. */
export function sameFee(a, b) {
  return describeFee(a) === describeFee(b);
}
