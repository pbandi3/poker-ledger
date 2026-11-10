import { test, expect } from '@playwright/test';
import { installFakeSupabase, readDb, readWrites } from './fake-supabase.js';
import { key, savedGame } from './helpers.js';

const older = savedGame('old1', '2025-12-01', [['Ann', 150], ['Bob', 50]]);
const newer = savedGame('new1', '2026-10-01', [['Ann', 120], ['Bob', 80], ['Zed (guest)', 100]]);
const seed = () => ({
  games: [older, newer],
  payments: newer.ledger.transactions.map((t) => ({ game_id: 'new1', txn_key: key(t), paid: true })),
});

test.describe('history', () => {
  test('guests are hidden until you show them', async ({ page }) => {
    await installFakeSupabase(page, seed());
    await page.goto('/history.html');
    const board = page.locator('#leaderboardTable');
    await expect(board).toContainText('Ann');
    await expect(board).not.toContainText('Zed (guest)');
    await page.check('#showGuests');
    await expect(board).toContainText('Zed (guest)');
  });

  test('the year filter narrows the standings', async ({ page }) => {
    await installFakeSupabase(page, seed());
    await page.goto('/history.html');
    await expect(page.locator('#leaderboardNote')).toContainText('across 2 games');
    await page.selectOption('#yearFilter', '2025');
    await expect(page.locator('#leaderboardNote')).toContainText('across 1 games in 2025');
    await expect(page.locator('#leaderboardTable')).not.toContainText('Zed');
  });

  test('past games show settled status and an Edit link', async ({ page }) => {
    await installFakeSupabase(page, seed());
    await page.goto('/history.html');
    const rows = page.locator('#gamesTable tbody tr');
    await expect(rows.filter({ hasText: 'Oct 1, 2026' })).toContainText('All settled');
    await expect(rows.filter({ hasText: 'Dec 1, 2025' })).toContainText('0 of 1 settled');
    await expect(rows.first().getByRole('link', { name: 'Edit' })).toHaveAttribute('href', /index\.html\?edit=/);
  });

  test('tapping a player opens their page', async ({ page }) => {
    await installFakeSupabase(page, seed());
    await page.goto('/history.html');
    await page.locator('.player-link[data-name="Ann"]').click();
    const dialog = page.locator('#playerDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Night by night');
    await expect(dialog).toContainText('Collects from');
    await page.click('#playerClose');
    await expect(dialog).toBeHidden();
  });

  test('rename changes every game and payment, and refuses a clash inside one game', async ({ page }) => {
    await installFakeSupabase(page, seed());
    await page.goto('/history.html');
    await expect(page.locator('#renameFrom option')).not.toHaveCount(0);

    await page.selectOption('#renameFrom', 'Bob');
    await page.fill('#renameTo', 'Ann');
    await page.click('#renameBtn');
    await expect(page.locator('#toast')).toContainText('already plays in the same game');
    expect(await readWrites(page)).toEqual([]);

    page.on('dialog', (d) => d.accept());
    await page.fill('#renameTo', 'Bobby');
    await page.click('#renameBtn');
    await expect.poll(async () => JSON.stringify((await readDb(page)).games)).not.toContain('"Bob"');
    const db = await readDb(page);
    expect(JSON.stringify(db.games)).toContain('Bobby');
    expect(db.payments.every((p) => p.txn_key.startsWith('Bobby>'))).toBe(true);
  });

  test('backup downloads a CSV', async ({ page }) => {
    await installFakeSupabase(page, seed());
    await page.goto('/history.html');
    await expect(page.locator('#renameFrom option')).not.toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsvBtn')]);
    expect(download.suggestedFilename()).toMatch(/^poker-ledger-.*\.csv$/);
  });
});

test.describe('pay page', () => {
  const game = savedGame('pay1', '2026-10-08', [['Ann', 200], ['Bob', 100], ['Cy', 50], ['Dee', 50]]);

  test('ticking every payment marks the game all settled', async ({ page }) => {
    await installFakeSupabase(page, { games: [game] });
    await page.goto('/pay.html?g=pay1');
    const boxes = page.locator('.j-paid');
    await expect(boxes).toHaveCount(game.ledger.transactions.length);
    await expect(page.locator('#payProgress')).toContainText(`0 of ${game.ledger.transactions.length}`);
    for (let i = 0; i < game.ledger.transactions.length; i++) await boxes.nth(i).check();
    await expect(page.locator('#payProgress')).toContainText('All settled');
    const db = await readDb(page);
    expect(db.payments.filter((p) => p.paid)).toHaveLength(game.ledger.transactions.length);
  });
});
