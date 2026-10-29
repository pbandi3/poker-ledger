import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDraftState, mergeDraftStates, stableStringify } from '../src/draft.js';

const row = (id, name, chips, t) => ({ id, name, buyIn: '', chips, t });
const state = (rows, extra = {}) => ({ ...emptyDraftState(), rows, ...extra });
const byId = (s) => Object.fromEntries(s.rows.map((r) => [r.id, r]));

test('stableStringify ignores key order and undefined values', () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } }),
    stableStringify({ a: { c: undefined, d: [1, { x: 1, y: 2 }] }, b: 1 })
  );
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('merge keeps rows that only one phone has', () => {
  const m = mergeDraftStates(state([row('a', 'Siva', '10', 5)]), state([row('b', 'Ravi', '20', 6)]));
  assert.deepEqual(m.rows.map((r) => r.id), ['a', 'b']);
});

test('merge takes the most recently edited copy of the same row', () => {
  const local = state([row('a', 'Siva', '10', 5)]);
  const remote = state([row('a', 'Siva', '99', 9)]);
  assert.equal(byId(mergeDraftStates(local, remote)).a.chips, '99');
  assert.equal(byId(mergeDraftStates(remote, local)).a.chips, '99'); // either direction
});

test('two phones editing different players at once keep both edits', () => {
  const base = [row('a', 'Siva', '', 1), row('b', 'Ravi', '', 1)];
  const phone1 = state([row('a', 'Siva', '50', 10), base[1]]);
  const phone2 = state([base[0], row('b', 'Ravi', '-20', 11)]);
  const m = byId(mergeDraftStates(phone1, phone2));
  assert.equal(m.a.chips, '50');
  assert.equal(m.b.chips, '-20');
});

test('a removal beats an older copy of the row, and a later edit revives it', () => {
  const withRow = state([row('a', 'Siva', '10', 5)]);
  const removedLater = state([], { removed: { a: 8 } });
  assert.deepEqual(mergeDraftStates(withRow, removedLater).rows, []);
  assert.deepEqual(mergeDraftStates(removedLater, withRow).rows, []);

  const editedAfter = state([row('a', 'Siva', '30', 12)]);
  assert.equal(byId(mergeDraftStates(editedAfter, removedLater)).a.chips, '30');
});

test('removals from both phones are combined, newest timestamp wins', () => {
  const m = mergeDraftStates(state([], { removed: { a: 3, b: 9 } }), state([], { removed: { a: 7 } }));
  assert.deepEqual(m.removed, { a: 7, b: 9 });
});

test('settings follow whichever phone edited them last', () => {
  const a = state([], { settings: { feeValue: '5', host: 'Siva' }, settingsT: 10 });
  const b = state([], { settings: { feeValue: '8', host: 'Ravi' }, settingsT: 20 });
  assert.deepEqual(mergeDraftStates(a, b).settings, { feeValue: '8', host: 'Ravi' });
  assert.equal(mergeDraftStates(a, b).settingsT, 20);
  assert.deepEqual(mergeDraftStates(b, a).settings, { feeValue: '8', host: 'Ravi' });
});

test('exact ties favour the local copy, and merging is idempotent', () => {
  const local = state([row('a', 'Siva', 'L', 5)], { settings: { host: 'L' }, settingsT: 5 });
  const remote = state([row('a', 'Siva', 'R', 5)], { settings: { host: 'R' }, settingsT: 5 });
  const m = mergeDraftStates(local, remote);
  assert.equal(byId(m).a.chips, 'L');
  assert.equal(m.settings.host, 'L');
  assert.equal(stableStringify(mergeDraftStates(m, m)), stableStringify(m));
});

test('both phones converge on the same rows whichever way they merge', () => {
  const a = state([row('1', 'A', 'x', 5), row('2', 'B', 'y', 9)], { removed: { 3: 4 } });
  const b = state([row('2', 'B', 'z', 7), row('3', 'C', 'w', 3), row('4', 'D', 'v', 6)]);
  const ab = mergeDraftStates(a, b);
  const ba = mergeDraftStates(b, a);
  const norm = (s) => stableStringify({ ...s, rows: [...s.rows].sort((p, q) => p.id.localeCompare(q.id)) });
  assert.equal(norm(ab), norm(ba));
  assert.deepEqual(ab.rows.map((r) => r.id).sort(), ['1', '2', '4']); // row 3 was removed after its last edit
});

test('merge tolerates missing fields from older or partial states', () => {
  const m = mergeDraftStates(undefined, { rows: [row('a', 'Siva', '1', 1)] });
  assert.equal(m.rows.length, 1);
  assert.deepEqual(m.removed, {});
  assert.equal(mergeDraftStates({}, {}).rows.length, 0);
});
