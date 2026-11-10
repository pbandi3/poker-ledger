// Save every game and payment to a JSON file. Used by the weekly backup workflow.
//   node scripts/backup.mjs backups/poker-ledger-2026-11-09.json
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildBackup, readSupabaseConfig, validateBackup } from '../src/backup.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/backup.mjs <output.json>');
  process.exit(1);
}

const { url, key } = readSupabaseConfig(await readFile(new URL('../src/supabaseClient.js', import.meta.url), 'utf8'));
const PAGE = 1000; // Supabase returns at most 1000 rows per request

async function fetchAll(table, order) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*&order=${order}`, {
      headers: { apikey: key, authorization: `Bearer ${key}`, range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const backup = buildBackup(await fetchAll('games', 'date.asc,id.asc'), await fetchAll('payments', 'game_id.asc,txn_key.asc'));
const counts = validateBackup(backup);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(backup, null, 2));
console.log(`Saved ${counts.games} games and ${counts.payments} payments to ${out}`);
