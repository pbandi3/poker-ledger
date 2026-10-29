// Pure helpers for the live shared game: merging two phones' copies of the same
// in-progress game. No DOM, no network, so it is unit-tested like the engine.
//
// Draft state:
//   {
//     settings:  { date, buyIn, host, feeType, feeValue, feeScope,
//                  foodRecipient, foodType, foodValue, foodScope },
//     settingsT: ms timestamp of the last settings edit,
//     rows:      [{ id, name, buyIn, chips, t }]   // t = ms timestamp of last edit
//     removed:   { [rowId]: ms timestamp it was removed }
//   }
//
// Rules: for each player row the most recently edited copy wins; a removal wins
// over any copy edited before it, and a later edit brings the row back; the
// settings as a whole follow whichever phone edited them last. Timestamps come
// from each phone's own clock, which is fine for people taking turns and for
// edits more than a moment apart.

export function emptyDraftState() {
  return { settings: {}, settingsT: 0, rows: [], removed: {} };
}

/** JSON with sorted keys, so two states can be compared whatever order keys arrive in. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Merge two copies of a draft. `a` is the local copy and wins exact ties.
 * Row order follows `a`, then any rows only `b` has, in `b`'s order.
 */
export function mergeDraftStates(a, b) {
  a = { ...emptyDraftState(), ...a };
  b = { ...emptyDraftState(), ...b };

  const removed = { ...a.removed };
  for (const [id, t] of Object.entries(b.removed)) removed[id] = Math.max(removed[id] ?? 0, t);

  const best = new Map();
  const order = [];
  for (const row of [...a.rows, ...b.rows]) {
    const current = best.get(row.id);
    if (!current) order.push(row.id);
    if (!current || (row.t ?? 0) > (current.t ?? 0)) best.set(row.id, row);
  }
  const rows = order
    .map((id) => best.get(id))
    .filter((row) => !(has(removed, row.id) && removed[row.id] >= (row.t ?? 0)))
    .map((row) => ({ ...row }));

  const bWins = (b.settingsT ?? 0) > (a.settingsT ?? 0);
  return {
    settings: { ...(bWins ? b.settings : a.settings) },
    settingsT: bWins ? b.settingsT : a.settingsT,
    rows,
    removed,
  };
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
