import { test, expect } from '@playwright/test';
import { installFakeSupabase, readDb, readWrites } from './fake-supabase.js';
import { enterPlayers, key, names, savedGame, setChips } from './helpers.js';

const trio = [['Ann', 150], ['Bob', 100], ['Cy', 50]];

async function calcAndShare(page) {
  await page.click('#calcBtn');
  await page.click('#waBtn');
}

test.describe('calculator and sharing', () => {
  test('Share creates one game; recalculating updates it instead of adding another', async ({ page }) => {
    await installFakeSupabase(page);
    await page.goto('/');
    await enterPlayers(page, trio);
    await page.selectOption('#host', 'Ann');
    await calcAndShare(page);
    await expect(page.locator('#waOut')).toContainText('pay.html?g=');
    const [game] = (await readDb(page)).games;
    expect(game.host).toBe('Ann');

    await setChips(page, 'Bob', 110);
    await setChips(page, 'Cy', 40);
    await calcAndShare(page);
    await expect.poll(async () => (await readWrites(page)).length).toBe(2);

    const db = await readDb(page);
    expect(db.games).toHaveLength(1);
    expect(db.games[0].id).toBe(game.id);
    const writes = await readWrites(page);
    expect(writes.map((w) => w.op)).toEqual(['insert', 'update']);
    expect(db.games[0].ledger.standings.find((s) => s.name === 'Bob').chipsCents).toBe(11000);
  });

  test('after a reload, sharing again still updates the same game', async ({ page }) => {
    await installFakeSupabase(page);
    await page.goto('/');
    await enterPlayers(page, trio);
    await page.selectOption('#host', 'Ann');
    await calcAndShare(page);
    await expect.poll(async () => (await readDb(page)).games.length).toBe(1);

    await page.reload();
    await expect(page.locator('#sharedNote')).toBeVisible();
    await setChips(page, 'Cy', 40);
    await setChips(page, 'Bob', 110);
    await calcAndShare(page);
    await expect.poll(async () => (await readWrites(page)).length).toBe(2);
    expect((await readDb(page)).games).toHaveLength(1);
  });

  test('New game forgets the saved game, so the next share is a new one', async ({ page }) => {
    await installFakeSupabase(page);
    await page.goto('/');
    await enterPlayers(page, trio);
    await page.selectOption('#host', 'Ann');
    await calcAndShare(page);
    await expect.poll(async () => (await readDb(page)).games.length).toBe(1);

    page.once('dialog', (d) => d.accept());
    await page.click('#newGameBtn');
    await expect(page.locator('#sharedNote')).toBeHidden();
    await enterPlayers(page, trio);
    await page.selectOption('#host', 'Bob');
    await calcAndShare(page);
    await expect.poll(async () => (await readDb(page)).games.length).toBe(2);
  });

  test('a Test game never writes anything', async ({ page }) => {
    await installFakeSupabase(page);
    await page.goto('/');
    await page.check('#testToggle');
    await enterPlayers(page, trio);
    await page.selectOption('#host', 'Ann');
    await calcAndShare(page);
    await expect(page.locator('#waOut')).toContainText('(TEST)');
    await expect(page.locator('#waOut')).not.toContainText('pay.html');
    expect(await readWrites(page)).toEqual([]);
  });

  test('chips that do not balance block the pay link and write nothing', async ({ page }) => {
    await installFakeSupabase(page);
    await page.goto('/');
    await enterPlayers(page, [['Ann', 150], ['Bob', 100], ['Cy', 100]]);
    await page.selectOption('#host', 'Ann');
    await calcAndShare(page);
    await expect(page.locator('#warnings')).toBeVisible();
    await expect(page.locator('#waOut')).not.toContainText('pay.html');
    expect(await readWrites(page)).toEqual([]);
  });

  test('a host fee without a host is refused', async ({ page }) => {
    await installFakeSupabase(page);
    await page.goto('/');
    await enterPlayers(page, trio);
    await page.click('#calcBtn');
    await expect(page.locator('#toast')).toContainText('Select who received the host fee');
    await expect(page.locator('#results')).toBeHidden();
  });
});

test.describe('players', () => {
  test('the G button adds and removes the guest tag', async ({ page }) => {
    await installFakeSupabase(page);
    await page.goto('/');
    const name = page.locator('#playersBody .j-name').first();
    await name.fill('Zed');
    await page.locator('#playersBody .guest-toggle').first().click();
    await expect(name).toHaveValue('Zed (guest)');
    await page.locator('#playersBody .guest-toggle').first().click();
    await expect(name).toHaveValue('Zed');
  });

  test('Load regulars skips guests, even ones who played often', async ({ page }) => {
    const games = ['2026-08-01', '2026-08-08', '2026-08-15'].map((d, i) =>
      savedGame(`g${i}`, d, [['Ann', 150], ['Bob', 100], ['Cy (guest)', 50]])
    );
    await installFakeSupabase(page, { games });
    await page.goto('/');
    await page.click('#regularsBtn');
    await expect.poll(() => names(page)).toEqual(['Ann', 'Bob']);
  });
});

test.describe('editing a past game', () => {
  const game = savedGame('edit1', '2026-10-01', [['Ann', 190], ['Bob', 110], ['Cy', 60], ['Dee', 40]], { host: 'Ann' });
  const paid = { game_id: 'edit1', txn_key: key(game.ledger.transactions[0]), paid: true };

  test('opens the game, works out the fee, and keeps the pay link and ticked payments', async ({ page }) => {
    await installFakeSupabase(page, { games: [game], payments: [paid] });
    await page.goto('/?edit=edit1');
    await expect.poll(() => names(page)).toEqual(['Ann', 'Bob', 'Cy', 'Dee']);
    await expect(page.locator('#host')).toHaveValue('Ann');
    await expect(page.locator('#feeValue')).toHaveValue('5');
    await expect(page.locator('#sharedNote')).toBeVisible();

    await page.click('#calcBtn');
    await expect(page.locator('#txnCount')).toContainText(`1 of ${game.ledger.transactions.length} settled`);
    await page.click('#waBtn');
    await expect.poll(async () => (await readWrites(page)).length).toBe(1);

    const writes = await readWrites(page);
    expect(writes[0]).toMatchObject({ op: 'update', table: 'games', filtered: true });
    const db = await readDb(page);
    expect(db.games).toHaveLength(1);
    expect(db.games[0].ledger.transactions.map(key).sort()).toEqual(game.ledger.transactions.map(key).sort());
  });

  test('changing a result updates the same game', async ({ page }) => {
    await installFakeSupabase(page, { games: [game], payments: [paid] });
    await page.goto('/?edit=edit1');
    await expect.poll(() => names(page)).toHaveLength(4);
    await setChips(page, 'Cy', 50);
    await setChips(page, 'Dee', 50);
    await calcAndShare(page);
    await expect.poll(async () => (await readWrites(page)).length).toBe(1);
    const db = await readDb(page);
    expect(db.games).toHaveLength(1);
    expect(db.games[0].ledger.standings.find((s) => s.name === 'Cy').chipsCents).toBe(5000);
  });
});

test.describe('last game settings', () => {
  const lastNight = savedGame('last1', '2026-11-01', [['Ann', 190], ['Bob', 110], ['Cy', 0]], { host: 'Ann', fee: 20 });

  test('a fresh form starts from the last game, and a different fee gets a quiet note', async ({ page }) => {
    await installFakeSupabase(page, { games: [lastNight] });
    await page.goto('/');
    await expect(page.locator('#feeValue')).toHaveValue('20');
    await expect(page.locator('#feeHint')).toBeHidden();

    await page.fill('#feeValue', '5');
    await expect(page.locator('#feeHint')).toBeVisible();
    await expect(page.locator('#feeHintText')).toContainText('$20 per player');
    await page.click('#feeHintUse');
    await expect(page.locator('#feeValue')).toHaveValue('20');
    await expect(page.locator('#feeHint')).toBeHidden();
  });

  test('New game goes back to the last game\'s settings', async ({ page }) => {
    await installFakeSupabase(page, { games: [lastNight] });
    await page.goto('/');
    await expect(page.locator('#feeValue')).toHaveValue('20');
    await page.fill('#feeValue', '7');
    page.once('dialog', (d) => d.accept());
    await page.click('#newGameBtn');
    await expect(page.locator('#feeValue')).toHaveValue('20');
  });

  test('a form you already started is left alone on reload', async ({ page }) => {
    await installFakeSupabase(page, { games: [lastNight] });
    await page.goto('/');
    await expect(page.locator('#feeValue')).toHaveValue('20');
    await page.fill('#feeValue', '5');
    await page.locator('#playersBody .j-name').first().fill('Ann');
    await page.reload();
    await expect(page.locator('#feeValue')).toHaveValue('5');
    await expect(page.locator('#feeHint')).toBeVisible();
  });
});
