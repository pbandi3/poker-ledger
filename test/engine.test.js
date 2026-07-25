// Unit tests for the ledger engine. Run with:  node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLedger,
  settle,
  maxZeroSumPartition,
  largestRemainderSplit,
  formatCents,
  toCents,
  FeeType,
  FeeScope,
} from '../src/engine.js';

const netMapToObj = (m) => Object.fromEntries(m);

test('largestRemainderSplit sums exactly to total', () => {
  const shares = largestRemainderSplit(4500, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(
    shares.reduce((a, b) => a + b, 0),
    4500
  );
  assert.deepEqual(shares, [500, 500, 500, 500, 500, 500, 500, 500, 500]);
});

test('largestRemainderSplit handles indivisible cents', () => {
  const shares = largestRemainderSplit(100, [1, 1, 1]); // $1.00 across 3
  assert.equal(shares.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(shares.sort((a, b) => a - b), [33, 33, 34]);
});

test('maxZeroSumPartition finds 3 groups in the poker night', () => {
  // Nets in dollars: Balaji+90, Siva+70, Sudhakar+50, Pradeep+15, Sharath+5,
  //                  Prudvi-15, Aditya-35, Chandra-75, Bala-105
  const bal = [90, 70, 50, 15, 5, -15, -35, -75, -105].map((d) => d * 100);
  const groups = maxZeroSumPartition(bal);
  assert.equal(groups.length, 3);
  // Every index covered exactly once, each group sums to zero.
  const covered = new Set();
  for (const g of groups) {
    let s = 0;
    for (const i of g) {
      assert.ok(!covered.has(i));
      covered.add(i);
      s += bal[i];
    }
    assert.equal(s, 0);
  }
  assert.equal(covered.size, bal.length);
});

const POKER_NIGHT = {
  defaultBuyIn: 100,
  host: 'Sudhakar',
  fee: { type: FeeType.PER_HEAD, value: 5, scope: FeeScope.ALL },
  players: [
    { name: 'Prudvi', chips: 90 },
    { name: 'Aditya', chips: 70 }, // 60 + 10
    { name: 'Pradeep', chips: 120 },
    { name: 'Chandra', chips: 30 },
    { name: 'Bala', chips: 0 },
    { name: 'Balaji', chips: 195 },
    { name: 'Sudhakar', chips: 110 },
    { name: 'Siva', chips: 175 },
    { name: 'Sharath', chips: 110 },
  ],
};

test('poker night: pool + integrity', () => {
  const l = computeLedger(POKER_NIGHT);
  assert.equal(l.poolCents, toCents(900));
  assert.equal(l.chipsCents, toCents(900));
  assert.equal(l.chipDiscrepancyCents, 0);
  assert.equal(l.balanced, true);
  assert.equal(l.feeTotalCents, toCents(45));
});

test('poker night: net standings match hand calc', () => {
  const l = computeLedger(POKER_NIGHT);
  const net = Object.fromEntries(l.standings.map((r) => [r.name, r.netCents]));
  const expected = {
    Balaji: 90,
    Siva: 70,
    Sudhakar: 50,
    Pradeep: 15,
    Sharath: 5,
    Prudvi: -15,
    Aditya: -35,
    Chandra: -75,
    Bala: -105,
  };
  for (const [name, dollars] of Object.entries(expected)) {
    assert.equal(net[name], toCents(dollars), `${name} net`);
  }
  // Zero-sum invariant.
  assert.equal(
    l.standings.reduce((a, r) => a + r.netCents, 0),
    0
  );
});

test('poker night: host fee applied correctly (Sudhakar +$40 net fee)', () => {
  const l = computeLedger(POKER_NIGHT);
  const sud = l.standings.find((r) => r.name === 'Sudhakar');
  assert.equal(sud.feeCents, toCents(40)); // +45 collected - 5 own share
  const bala = l.standings.find((r) => r.name === 'Bala');
  assert.equal(bala.feeCents, toCents(-5));
});

test('poker night: settlement is minimal (6 transactions) and consistent', () => {
  const l = computeLedger(POKER_NIGHT);
  assert.equal(l.transactions.length, 6);

  // Each player's settlement flow must equal their net.
  const flow = new Map();
  for (const r of l.standings) flow.set(r.name, 0);
  for (const t of l.transactions) {
    assert.ok(t.amountCents > 0);
    flow.set(t.from, flow.get(t.from) - t.amountCents);
    flow.set(t.to, flow.get(t.to) + t.amountCents);
  }
  for (const r of l.standings) {
    assert.equal(flow.get(r.name), r.netCents, `${r.name} flow ties to net`);
  }
});

test('settle produces n-1 or fewer transactions and balances', () => {
  const net = new Map([
    ['A', 5000],
    ['B', -2000],
    ['C', -3000],
  ]);
  const txns = settle(net);
  assert.ok(txns.length <= 2);
  const flow = new Map();
  for (const t of txns) {
    flow.set(t.from, (flow.get(t.from) || 0) - t.amountCents);
    flow.set(t.to, (flow.get(t.to) || 0) + t.amountCents);
  }
  assert.equal(flow.get('A'), 5000);
  assert.equal(flow.get('B'), -2000);
  assert.equal(flow.get('C'), -3000);
});

test('percent fee scope=winners only charges winners', () => {
  const l = computeLedger({
    defaultBuyIn: 100,
    host: 'Alice',
    fee: { type: FeeType.PERCENT, value: 10, scope: FeeScope.WINNERS },
    players: [
      { name: 'Alice', chips: 150 }, // +50 winner + host
      { name: 'Bob', chips: 50 }, // -50 loser
    ],
  });
  // Pool 200, fee 10% = 20. Only Alice (winner) pays, and she's host.
  assert.equal(l.feeTotalCents, toCents(20));
  const alice = l.standings.find((r) => r.name === 'Alice');
  const bob = l.standings.find((r) => r.name === 'Bob');
  assert.equal(bob.feeCents, 0); // loser pays no fee
  // Alice: collects 20, pays 20 share => net fee 0; poker +50 => net +50
  assert.equal(alice.feeCents, 0);
  assert.equal(alice.netCents, toCents(50));
  assert.equal(bob.netCents, toCents(-50));
});

test('detects chip discrepancy and disables settlement', () => {
  const l = computeLedger({
    defaultBuyIn: 100,
    players: [
      { name: 'A', chips: 120 },
      { name: 'B', chips: 100 }, // total 220 vs pool 200
    ],
  });
  assert.equal(l.balanced, false);
  assert.equal(l.transactions.length, 0);
  assert.equal(l.chipDiscrepancyCents, toCents(20));
  assert.ok(l.warnings.length >= 1);
});

test('rebuy via higher buyIn is handled', () => {
  const l = computeLedger({
    defaultBuyIn: 100,
    players: [
      { name: 'A', buyIn: 200, chips: 250 }, // rebought once
      { name: 'B', chips: 50 },
    ],
  });
  assert.equal(l.poolCents, toCents(300));
  const a = l.standings.find((r) => r.name === 'A');
  assert.equal(a.pokerPnlCents, toCents(50));
});

test('formatCents renders signs correctly', () => {
  assert.equal(formatCents(-7000), '-$70.00');
  assert.equal(formatCents(9500, { sign: true }), '+$95.00');
  assert.equal(formatCents(0, { sign: true }), '+$0.00');
});
