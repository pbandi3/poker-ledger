// In-memory stand-in for supabase-js, served in place of the esm.sh module so the
// app runs against it in a real browser. It implements only the calls the app uses
// and records every write so tests can assert on exactly what would be saved.
// State lives in sessionStorage so it survives page reloads within a test.

const FAKE_SOURCE = `
const KEY = '__fakedb';
const PK = { games: ['id'], payments: ['game_id', 'txn_key'], drafts: ['id'] };
const load = () => {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  const seed = window.__seed ?? {};
  return { db: { games: [], payments: [], drafts: [], ...seed }, writes: [] };
};
const state = load();
const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
save();

const same = (t, a, b) => PK[t].every((k) => a[k] === b[k]);

class Query {
  constructor(table) {
    this.t = table; this.op = 'select'; this.filters = []; this.returning = false;
  }
  select() { if (this.op !== 'select') this.returning = true; return this; }
  insert(p) { this.op = 'insert'; this.p = p; return this; }
  update(p) { this.op = 'update'; this.p = p; return this; }
  upsert(p) { this.op = 'upsert'; this.p = p; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  is(c, v) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  order(c, o) { this.ord = [c, o]; return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = true; return this; }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  run() {
    const rows = state.db[this.t];
    const match = (r) => this.filters.every((f) => f(r));
    const now = new Date().toISOString();
    if (this.op === 'select') {
      let out = rows.filter(match).map((r) => ({ ...r }));
      if (this.ord) {
        const [c, o] = this.ord;
        const dir = o?.ascending === false ? -1 : 1;
        out.sort((a, b) => String(a[c] ?? '').localeCompare(String(b[c] ?? '')) * dir);
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: this.one ? out[0] ?? null : out, error: null };
    }
    const list = Array.isArray(this.p) ? this.p : [this.p];
    state.writes.push({ op: this.op, table: this.t, payload: this.p, filtered: this.filters.length > 0 });
    let touched = [];
    if (this.op === 'insert') {
      for (const r of list) {
        if (rows.some((x) => same(this.t, x, r))) {
          save();
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const row = { created_at: now, updated_at: now, ...(this.t === 'drafts' ? { version: 1 } : {}), ...r };
        rows.push(row); touched.push(row);
      }
    } else if (this.op === 'upsert') {
      for (const r of list) {
        const i = rows.findIndex((x) => same(this.t, x, r));
        if (i >= 0) { rows[i] = { ...rows[i], ...r }; touched.push(rows[i]); }
        else { const row = { created_at: now, updated_at: now, ...r }; rows.push(row); touched.push(row); }
      }
    } else if (this.op === 'update') {
      for (const r of rows) if (match(r)) { Object.assign(r, this.p); touched.push(r); }
    }
    save();
    return { data: this.returning ? touched.map((r) => ({ ...r })) : null, error: null };
  }
}

const client = {
  from: (t) => new Query(t),
  channel() {
    const c = { on: () => c, subscribe: (cb) => { if (cb) setTimeout(() => cb('SUBSCRIBED')); return c; } };
    return c;
  },
  removeChannel() {},
};
window.__fake = { state };
export const createClient = () => client;
`;

/** Route the supabase-js import to the fake and optionally seed {games, payments, drafts}. */
export async function installFakeSupabase(page, seed = {}) {
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('requestfailed', (r) => console.error('[request failed]', r.url(), r.failure()?.errorText));
  await page.addInitScript((s) => {
    window.__seed = s;
  }, seed);
  await page.route(/esm\.sh\/@supabase\/supabase-js/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: FAKE_SOURCE,
    })
  );
}

export const readDb = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('__fakedb')).db);
export const readWrites = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('__fakedb')).writes);
