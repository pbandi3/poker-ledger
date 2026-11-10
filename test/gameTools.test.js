import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLedger } from '../src/engine.js';
import {
  gameYear,
  gamesToCsv,
  headToHead,
  inferEditableGame,
  playerTimeline,
  renameImpact,
  renameInLedger,
  renamePaymentKey,
  reuseSavedPayments,
  settledCount,
} from '../src/gameTools.js';

const night = (extra = {}) =>
  computeLedger({
    date: '2026-08-01',
    defaultBuyIn: 100,
    host: 'Ann',
    fee: { type: 'perHead', value: 5, scope: 'all' },
    players: [
      { name: 'Ann', chips: 150 },
      { name: 'Bob', chips: 60 },
      { name: 'Cy (guest)', chips: 90 },
    ],
    ...extra,
  });

test('gameYear reads the year or returns null', () => {
  assert.equal(gameYear('2026-08-01'), '2026');
  assert.equal(gameYear(null), null);
  assert.equal(gameYear('x'), null);
});

test('renameInLedger and renamePaymentKey only touch exact name matches', () => {
  const l = night();
  const r = renameInLedger(l, 'Bob', 'Bobby');
  assert.ok(r.standings.some((s) => s.name === 'Bobby'));
  assert.ok(!JSON.stringify(r).includes('"Bob"'));
  assert.equal(r.host, 'Ann');
  assert.equal(renamePaymentKey('Bob>Ann:2500', 'Bob', 'Bobby'), 'Bobby>Ann:2500');
  assert.equal(renamePaymentKey('Bob>Ann:2500', 'Ann', 'Annie'), 'Bob>Annie:2500');
  assert.equal(renamePaymentKey('Bobby>Ann:2500', 'Bob', 'X'), 'Bobby>Ann:2500');
});

test('renameImpact reports payment rows, clashes and merges', () => {
  const g1 = { id: 'a', date: '2026-08-01', ledger: night() };
  const g2 = {
    id: 'b',
    date: '2026-08-08',
    ledger: night({ players: [{ name: 'Ann', chips: 100 }, { name: 'Bobby', chips: 100 }] }),
  };
  const key = `Bob>Ann:${g1.ledger.transactions.find((t) => t.from === 'Bob')?.amountCents}`;
  const payments = [{ game_id: 'a', txn_key: key, paid: true }];
  const merge = renameImpact([g1, g2], payments, 'Bob', 'Bobby');
  assert.equal(merge.games.length, 1);
  assert.equal(merge.clash.length, 0);
  assert.equal(merge.existsElsewhere, true);
  assert.equal(merge.paymentRows.length, 1);
  const clash = renameImpact([g1], payments, 'Bob', 'Ann');
  assert.equal(clash.clash.length, 1);
});

for (const [label, input] of [
  ['per-head fee', {}],
  ['flat fee', { fee: { type: 'flat', value: 20, scope: 'all' } }],
  ['percent fee', { fee: { type: 'percent', value: 10, scope: 'all' } }],
  ['winners-only fee', { fee: { type: 'flat', value: 30, scope: 'winners' } }],
  ['food and fee', { food: { recipient: 'Bob', type: 'perHead', value: 4, scope: 'all' } }],
  ['no fee', { fee: { type: 'none', value: 0 }, host: null }],
]) {
  test(`inferEditableGame reproduces the saved numbers: ${label}`, () => {
    const saved = night(input);
    const { settings, rows, notes } = inferEditableGame(saved);
    assert.deepEqual(notes, []);
    const again = computeLedger({
      date: settings.date,
      defaultBuyIn: Number(settings.buyIn),
      host: settings.host || null,
      fee: { type: settings.feeType, value: Number(settings.feeValue), scope: settings.feeScope },
      food: settings.foodRecipient
        ? { recipient: settings.foodRecipient, type: settings.foodType, value: Number(settings.foodValue), scope: settings.foodScope }
        : null,
      players: rows.map((r) => ({ name: r.name, chips: Number(r.chips), ...(r.buyIn === '' ? {} : { buyIn: Number(r.buyIn) }) })),
    });
    const pick = (l) => Object.fromEntries(l.standings.map((s) => [s.name, s.netCents]));
    assert.deepEqual(pick(again), pick(saved));
  });
}

test('reuseSavedPayments keeps saved payments only when standings are unchanged', () => {
  const players = ['Zed', 'Amy', 'Bo', 'Cal', 'Dee', 'Eve', 'Fay', 'Gus'].map((name, i) => ({
    name,
    chips: [190, 10, 130, 70, 155, 45, 120, 80][i],
  }));
  const saved = computeLedger({ date: '2026-09-01', host: 'Amy', fee: { type: 'perHead', value: 5, scope: 'all' }, players });
  const { settings, rows } = inferEditableGame(saved);
  const build = (chipsFor) =>
    computeLedger({
      host: settings.host,
      fee: { type: settings.feeType, value: Number(settings.feeValue), scope: settings.feeScope },
      players: rows.map((r) => ({ name: r.name, chips: chipsFor(r) })),
    });
  const same = build((r) => Number(r.chips));
  assert.deepEqual(reuseSavedPayments(same, saved), saved.transactions);
  const changed = build((r) => Number(r.chips) + (r.name === 'Zed' ? 5 : r.name === 'Amy' ? -5 : 0));
  assert.equal(reuseSavedPayments(changed, saved), null);
});

test('inferEditableGame keeps per-player buy-ins that differ from the default', () => {
  const saved = night({ players: [{ name: 'Ann', chips: 150, buyIn: 200 }, { name: 'Bob', chips: 50 }, { name: 'Cy', chips: 100 }] });
  const { settings, rows } = inferEditableGame(saved);
  assert.equal(settings.buyIn, '100');
  assert.equal(rows.find((r) => r.name === 'Ann').buyIn, '200');
  assert.equal(rows.find((r) => r.name === 'Bob').buyIn, '');
});

test('playerTimeline builds a running total, oldest first', () => {
  const games = [
    { id: 'b', date: '2026-08-08', ledger: night({ date: '2026-08-08' }) },
    { id: 'a', date: '2026-08-01', ledger: night() },
  ];
  const t = playerTimeline(games, 'Ann');
  assert.deepEqual(t.map((n) => n.date), ['2026-08-01', '2026-08-08']);
  assert.equal(t[1].totalCents, t[0].pnlCents + t[1].pnlCents);
  assert.equal(t[0].isHost, true);
});

test('headToHead nets settlement money per opponent', () => {
  const games = [
    { id: 'a', ledger: { transactions: [{ from: 'Bob', to: 'Ann', amountCents: 3000 }, { from: 'Ann', to: 'Cy', amountCents: 500 }] } },
    { id: 'b', ledger: { transactions: [{ from: 'Bob', to: 'Ann', amountCents: 1000 }] } },
  ];
  assert.deepEqual(headToHead(games, 'Ann'), [
    { opponent: 'Bob', cents: 4000 },
    { opponent: 'Cy', cents: -500 },
  ]);
});

test('settledCount ignores payments that no longer match a transaction', () => {
  const ledger = night();
  const t = ledger.transactions[0];
  const game = { id: 'a', ledger };
  const payments = [
    { game_id: 'a', txn_key: `${t.from}>${t.to}:${t.amountCents}`, paid: true },
    { game_id: 'a', txn_key: 'Old>Name:1', paid: true },
    { game_id: 'a', txn_key: `${t.from}>${t.to}:${t.amountCents}x`, paid: false },
  ];
  assert.equal(settledCount(game, payments), 1);
});

test('gamesToCsv writes one dollar row per player and quotes commas', () => {
  const csv = gamesToCsv([{ id: 'a', date: '2026-08-01', host: 'Ann', ledger: night() }]);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^date,game_id,host,player/);
  assert.match(csv, /Cy \(guest\)/);
  assert.match(csv, /2026-08-01,a,Ann,Ann,yes,100,150,50/);
});
