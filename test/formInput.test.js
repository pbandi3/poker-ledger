import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLedger } from '../src/engine.js';
import { buildLedgerInput, countRegulars, describeFee, parseAmount, sameFee } from '../src/formInput.js';

test('describeFee reads like the form and sameFee compares meaning, not strings', () => {
  assert.equal(describeFee({ feeType: 'perHead', feeValue: '20', feeScope: 'all' }), '$20 per player');
  assert.equal(describeFee({ feeType: 'flat', feeValue: '30', feeScope: 'winners' }), '$30 flat, winners only');
  assert.equal(describeFee({ feeType: 'percent', feeValue: '10', feeScope: 'all' }), '10% of pool');
  assert.equal(describeFee({ feeType: 'none', feeValue: '5', feeScope: 'all' }), 'no fee');
  assert.equal(describeFee({ feeType: 'perHead', feeValue: '0', feeScope: 'all' }), 'no fee');
  assert.ok(sameFee({ feeType: 'perHead', feeValue: '5.0', feeScope: 'all' }, { feeType: 'perHead', feeValue: 5, feeScope: 'all' }));
  assert.ok(!sameFee({ feeType: 'perHead', feeValue: '5', feeScope: 'all' }, { feeType: 'perHead', feeValue: '20', feeScope: 'all' }));
  // a "none" fee with a leftover value is still no fee
  assert.ok(sameFee({ feeType: 'none', feeValue: '9', feeScope: 'all' }, { feeType: 'perHead', feeValue: '0', feeScope: 'all' }));
});

const settings = (over = {}) => ({
  date: '2026-11-01',
  buyIn: '100',
  host: '',
  feeType: 'perHead',
  feeValue: '5',
  feeScope: 'all',
  foodRecipient: '',
  foodType: 'perHead',
  foodValue: '0',
  foodScope: 'all',
  ...over,
});
const row = (name, chips, buyIn = '') => ({ name, chips, buyIn });

test('parseAmount: blank is null, sums rebuys, rejects junk', () => {
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('  '), null);
  assert.equal(parseAmount('60+10'), 70);
  assert.equal(parseAmount('-25'), -25);
  assert.equal(parseAmount('12.5'), 12.5);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.ok(Number.isNaN(parseAmount('10*2')));
});

test('buildLedgerInput: rejects missing names, bad numbers and empty tables', () => {
  assert.equal(buildLedgerInput([row('', '5')], settings()).error, 'Every row needs a name.');
  assert.equal(buildLedgerInput([row('Ann', 'x')], settings()).error, 'Bad chip value for Ann.');
  assert.equal(buildLedgerInput([row('Ann', '5', 'y')], settings()).error, 'Bad buy-in for Ann.');
  assert.equal(buildLedgerInput([], settings()).error, 'Add at least one player.');
});

test('buildLedgerInput: host fee needs a host, food needs a payer', () => {
  const rows = [row('Ann', '100'), row('Bob', '100')];
  assert.match(buildLedgerInput(rows, settings()).error, /Select who received the host fee/);
  assert.ok(buildLedgerInput(rows, settings({ feeType: 'none' })).input);
  assert.ok(buildLedgerInput(rows, settings({ feeValue: '0' })).input);
  assert.match(buildLedgerInput(rows, settings({ host: 'Ann', foodValue: '4' })).error, /Select who paid for food/);
  assert.equal(buildLedgerInput(rows, settings({ host: 'Ann', foodValue: 'q' })).error, 'Bad food amount.');
  assert.equal(buildLedgerInput(rows, settings({ host: 'Ann', feeValue: 'q' })).error, 'Bad host fee amount.');
});

test('buildLedgerInput: blank chips count as zero, blank buy-in uses the default, food is optional', () => {
  const { input } = buildLedgerInput(
    [row('Ann', '60+10', '200'), row('Bob', ''), row('Cy', '30')],
    settings({ host: 'Ann', buyIn: '50', foodRecipient: 'Bob', foodValue: '3' })
  );
  assert.equal(input.defaultBuyIn, 50);
  assert.deepEqual(input.players[0], { name: 'Ann', chips: 70, buyIn: 200 });
  assert.deepEqual(input.players[1], { name: 'Bob', chips: 0 });
  assert.deepEqual(input.food, { recipient: 'Bob', type: 'perHead', value: 3, scope: 'all' });
  assert.equal(input.host, 'Ann');
  const ledger = computeLedger(input);
  assert.equal(ledger.standings.length, 3);
});

test('buildLedgerInput output feeds computeLedger end to end', () => {
  const { input } = buildLedgerInput(
    [row('Ann', '150'), row('Bob', '50')],
    settings({ host: 'Ann' })
  );
  const l = computeLedger(input);
  assert.equal(l.balanced, true);
  assert.equal(l.transactions.length, 1);
  assert.equal(l.feeTotalCents, 1000);
});

test('countRegulars: counts each game once, skips guests, orders by games played', () => {
  const g = (...names) => ({ ledger: { standings: names.map((name) => ({ name })) } });
  const games = [
    g('Ann', 'Bob', 'Cy (guest)'),
    g('Ann', 'Bob', 'Cy (guest)', 'Cy (guest)'),
    g('Ann', 'Cy (guest)', 'Dee'),
    g('Ann', 'Bob'),
  ];
  const { allNames, regulars } = countRegulars(games, 3);
  assert.deepEqual(regulars, ['Ann', 'Bob']);
  assert.deepEqual(allNames, ['Ann', 'Bob', 'Cy (guest)', 'Dee']);
  assert.deepEqual(countRegulars(null, 3), { allNames: [], regulars: [] });
});
