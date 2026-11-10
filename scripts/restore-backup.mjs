// Put a backup file back into Supabase. Safe by default: it only prints what it
// would do. Add --apply to write. Existing rows with the same id are overwritten;
// nothing is ever deleted.
//   node scripts/restore-backup.mjs backup.json
//   node scripts/restore-backup.mjs backup.json --apply
import { readFile } from 'node:fs/promises';
import { readSupabaseConfig, restorePlan } from '../src/backup.js';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/restore-backup.mjs <backup.json> [--apply]');
  process.exit(1);
}
const apply = flag === '--apply';

const plan = restorePlan(JSON.parse(await readFile(file, 'utf8')));
for (const { table, rows } of plan) console.log(`${apply ? 'Restoring' : 'Would restore'} ${rows.length} ${table}`);
if (!apply) {
  console.log('Dry run only. Re-run with --apply to write.');
  process.exit(0);
}

const { url, key } = readSupabaseConfig(await readFile(new URL('../src/supabaseClient.js', import.meta.url), 'utf8'));
for (const { table, rows } of plan) {
  for (let i = 0; i < rows.length; i += 200) {
    const res = await fetch(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
  }
}
console.log('Done.');
