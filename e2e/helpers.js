import { computeLedger } from '../src/engine.js';

/** Build a saved-game row (as the app stores it) from simple inputs. */
export function savedGame(id, date, players, { host = null, fee = 5 } = {}) {
  const ledger = computeLedger({
    date,
    host,
    fee: host ? { type: 'perHead', value: fee, scope: 'all' } : { type: 'none', value: 0 },
    players: players.map(([name, chips]) => ({ name, chips })),
  });
  const snapshot = {
    date: ledger.date,
    host: ledger.host,
    standings: ledger.standings,
    transactions: ledger.transactions,
    netSumCents: ledger.netSumCents,
  };
  return { id, date, host, ledger: snapshot, created_at: date, updated_at: date };
}

export const key = (t) => `${t.from}>${t.to}:${t.amountCents}`;

/** Type players into the calculator: [[name, chips], ...] */
export async function enterPlayers(page, players) {
  for (let i = 0; i < players.length; i++) {
    const row = page.locator('#playersBody tr').nth(i);
    await row.locator('.j-name').fill(players[i][0]);
    await row.locator('.j-chips').fill(String(players[i][1]));
  }
}

export async function setChips(page, name, chips) {
  const rows = page.locator('#playersBody tr');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    if ((await rows.nth(i).locator('.j-name').inputValue()) === name) {
      await rows.nth(i).locator('.j-chips').fill(String(chips));
      return;
    }
  }
  throw new Error(`no row for ${name}`);
}

export const names = (page) =>
  page.$$eval('#playersBody .j-name', (els) => els.map((e) => e.value).filter(Boolean));
