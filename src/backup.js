// Pure helpers for backing up and restoring the Supabase data. Used by
// scripts/backup.mjs (weekly GitHub Action), scripts/restore-backup.mjs and the
// History page's "Download backup". No network or filesystem in here.

/** Read the project URL and publishable key out of src/supabaseClient.js. */
export function readSupabaseConfig(sourceText) {
  const url = sourceText.match(/https:\/\/[a-z0-9]+\.supabase\.co/)?.[0];
  const key = sourceText.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
  if (!url || !key) throw new Error('Could not find the Supabase URL and key in src/supabaseClient.js');
  return { url, key };
}

export function buildBackup(games, payments, now = new Date()) {
  return { exportedAt: now.toISOString(), games, payments };
}

/** Throws unless this looks like a real, usable backup (never save an empty one over good ones). */
export function validateBackup(backup) {
  if (!backup || !Array.isArray(backup.games) || !Array.isArray(backup.payments)) {
    throw new Error('Not a backup file: expected { games: [], payments: [] }');
  }
  if (backup.games.length === 0) throw new Error('Backup has no games');
  for (const g of backup.games) {
    if (!g.id || !g.ledger?.standings) throw new Error(`Game ${g.id ?? '(no id)'} is missing its ledger`);
  }
  const ids = new Set(backup.games.map((g) => g.id));
  const orphan = backup.payments.find((p) => !ids.has(p.game_id));
  if (orphan) throw new Error(`Payment points at unknown game ${orphan.game_id}`);
  return { games: backup.games.length, payments: backup.payments.length };
}

/** Row sets to upsert when restoring, games first so payments always have a parent. */
export function restorePlan(backup) {
  validateBackup(backup);
  return [
    { table: 'games', rows: backup.games },
    { table: 'payments', rows: backup.payments },
  ];
}
