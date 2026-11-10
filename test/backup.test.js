import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, readSupabaseConfig, restorePlan, validateBackup } from '../src/backup.js';

const game = (id) => ({ id, date: '2026-11-01', ledger: { standings: [] } });

test('readSupabaseConfig finds the URL and key, and complains when they are missing', () => {
  const src = `const SUPABASE_URL = 'https://abc123.supabase.co';\nconst K = 'sb_publishable_Ab-1_x';`;
  assert.deepEqual(readSupabaseConfig(src), { url: 'https://abc123.supabase.co', key: 'sb_publishable_Ab-1_x' });
  assert.throws(() => readSupabaseConfig('nothing here'), /Could not find/);
});

test('buildBackup stamps the time and keeps the rows', () => {
  const b = buildBackup([game('a')], [], new Date('2026-11-09T15:00:00Z'));
  assert.equal(b.exportedAt, '2026-11-09T15:00:00.000Z');
  assert.equal(b.games.length, 1);
});

test('validateBackup accepts a good backup and counts it', () => {
  const b = buildBackup([game('a'), game('b')], [{ game_id: 'a', txn_key: 'X>Y:1', paid: true }]);
  assert.deepEqual(validateBackup(b), { games: 2, payments: 1 });
});

test('validateBackup refuses empty, malformed and orphaned backups', () => {
  assert.throws(() => validateBackup(null), /Not a backup/);
  assert.throws(() => validateBackup({ games: 'x', payments: [] }), /Not a backup/);
  assert.throws(() => validateBackup(buildBackup([], [])), /no games/);
  assert.throws(() => validateBackup(buildBackup([{ id: 'a' }], [])), /missing its ledger/);
  assert.throws(
    () => validateBackup(buildBackup([game('a')], [{ game_id: 'zzz', txn_key: 'k', paid: false }])),
    /unknown game zzz/
  );
});

test('restorePlan puts games before payments', () => {
  const plan = restorePlan(buildBackup([game('a')], [{ game_id: 'a', txn_key: 'k', paid: true }]));
  assert.deepEqual(plan.map((p) => p.table), ['games', 'payments']);
});
