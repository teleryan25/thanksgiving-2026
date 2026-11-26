import { expect, test } from '@playwright/test';
import { doneCount, enterSim, expectNoHorizontalOverflow, trackErrors } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('all four tabs render without overflow or errors', async ({ page }) => {
  const errs = trackErrors(page);
  await expect(page.getByTestId('now-card')).toBeVisible();
  await expect(page.getByTestId('clock')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByTestId('tab-timeline').click();
  await expect(page.getByTestId('oven-chart')).toBeVisible();
  await expect(page.getByTestId('task-list')).toContainText('Bake stuffing at 350°F');
  await expectNoHorizontalOverflow(page);
  await page.getByTestId('tab-recipes').click();
  for (const id of ['compote', 'stuffing', 'mash', 'sweetpotato', 'greenbeans', 'mac', 'corn', 'gravy']) await expect(page.getByTestId(`recipe-${id}`)).toBeVisible();
  await page.getByTestId('recipe-mash').locator('button').first().click();
  await expect(page.getByTestId('recipe-mash')).toContainText('14 tbsp unsalted butter');
  await expectNoHorizontalOverflow(page);
  await page.getByTestId('tab-shopping').click();
  await expect(page.getByTestId('shop-butter')).toContainText('30 tbsp + 2 1/2 tsp');
  await expectNoHorizontalOverflow(page);
  expect(errs).toEqual([]);
});

test('simulation: start, timer expiry never completes, confirm, undo, refresh, isolation', async ({ page }) => {
  const errs = trackErrors(page);
  await enterSim(page);
  await expect(page.getByTestId('now-card')).toContainText('Preheat oven to 250°F');
  await page.getByTestId('btn-start').click();
  await expect(page.getByTestId('now-card')).toContainText(/Cube Hawaiian rolls|In progress/);
  // Instantly expire the simulated timers — the task must still be running.
  await page.getByTestId('sim-expire').click();
  const expired = page.locator('[data-status="expired"]');
  await expect(expired.first()).toBeVisible();
  await expired.first().getByRole('button', { name: 'Acknowledge' }).click();
  await page.getByTestId('tab-timeline').click();
  await expect(page.getByTestId('row-oven-preheat-250')).toContainText('running');
  await page.getByTestId('row-oven-preheat-250').click();
  await page.getByTestId('task-sheet').getByTestId('btn-complete').click();
  const confirm = page.getByTestId('btn-confirm-complete');
  await expect(confirm).toBeDisabled();
  await page.getByTestId('chk-safety').check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId('row-oven-preheat-250')).toContainText('done');
  await expect.poll(() => doneCount(page)).toBe(1);
  await page.keyboard.press('Escape');
  // Undo
  await page.getByTestId('tab-cook').click();
  await page.getByTestId('btn-undo').click();
  await expect(page.getByTestId('toast')).toContainText('nothing physical was reversed');
  await expect.poll(() => doneCount(page)).toBe(0);
  // Redo completion via the plan, advance the clock, then refresh — state must persist.
  await page.getByTestId('tab-timeline').click();
  await page.getByTestId('row-oven-preheat-250').click();
  await page.getByTestId('task-sheet').getByTestId('btn-complete').click();
  await page.getByTestId('chk-safety').check();
  await page.getByTestId('btn-confirm-complete').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('sim-adv-30').click();
  await page.reload();
  await expect(page.getByTestId('sim-banner')).toBeVisible();
  await expect(page.getByTestId('sim-banner')).toContainText('8:30');
  await expect.poll(() => doneCount(page)).toBe(1);
  // Live data untouched by simulation.
  await page.getByTestId('sim-exit').click();
  await expect(page.getByTestId('sim-banner')).toHaveCount(0);
  await expect.poll(() => doneCount(page)).toBe(0);
  expect(errs).toEqual([]);
});

test('unsafe skip needs explicit confirmation and leaves dependents blocked', async ({ page }) => {
  await enterSim(page);
  await page.getByTestId('tab-timeline').click();
  await page.getByTestId('row-stuffing-cook-sausage').click();
  await page.getByTestId('task-sheet').getByTestId('btn-skip').click();
  const go = page.getByTestId('btn-confirm-skip');
  await expect(go).toBeDisabled();
  await expect(page.getByTestId('dlg-skip')).toContainText('stay blocked');
  await page.getByTestId('chk-unsafe').check();
  await go.click();
  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByTestId('row-stuffing-bake')).toContainText('blocked');
  await expect(page.getByTestId('warning-blocked').first()).toBeVisible();
});

test('task picker, delay, pause/resume and custom timer', async ({ page }) => {
  await enterSim(page);
  await page.getByTestId('btn-select').click();
  await expect(page.getByTestId('task-picker')).toBeVisible();
  await page.getByTestId('task-picker').getByText('Zest and juice the orange').first().click();
  await page.getByTestId('task-sheet').getByTestId('btn-delay').click();
  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.getByTestId('btn-pause').click();
  await expect(page.getByText('Guidance paused.').first()).toBeVisible();
  await page.getByTestId('btn-resume').click();
  await page.getByLabel('Timer label').fill('Wine');
  await page.getByLabel('Timer minutes').fill('3');
  await page.getByTestId('btn-add-timer').click();
  await expect(page.getByText('Wine')).toBeVisible();
  await page.getByTestId('sim-next-timer').click();
  await expect(page.locator('[data-status="expired"]').filter({ hasText: 'Wine' })).toBeVisible();
});

test('shopping checks, settings and turkey ETA persist across reload', async ({ page }) => {
  await page.getByTestId('tab-shopping').click();
  await page.getByTestId('shop-butter').locator('input').check();
  await page.getByTestId('btn-settings').click();
  await page.getByTestId('input-target').fill('13:30');
  await page.getByTestId('input-turkey').fill('12:45');
  await page.getByRole('button', { name: 'More burners' }).click();
  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.locator('.top-stats')).toContainText('Target 1:30 PM');
  await page.reload();
  await expect(page.locator('.top-stats')).toContainText('Target 1:30 PM');
  await page.getByTestId('tab-shopping').click();
  await expect(page.getByTestId('shop-butter').locator('input')).toBeChecked();
  await page.getByTestId('btn-settings').click();
  await expect(page.getByTestId('input-turkey')).toHaveValue('12:45');
  await expect(page.getByTestId('burners')).toHaveText('5');
});

test('reset requires confirmation', async ({ page }) => {
  await enterSim(page);
  await page.getByTestId('btn-start').click();
  await page.getByTestId('btn-settings').click();
  await page.getByTestId('btn-reset-progress').click();
  await expect(page.getByTestId('confirm-reset')).toBeVisible();
  await page.getByTestId('btn-confirm-reset').click();
  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.getByTestId('tab-timeline').click();
  await expect(page.getByTestId('row-oven-preheat-250')).toContainText('scheduled');
});

test('runtime diagnostics run production logic and report results', async ({ page }) => {
  await page.getByTestId('btn-settings').click();
  await page.getByTestId('btn-diag').click();
  const rep = page.getByTestId('diag-report');
  await expect(rep).toBeVisible({ timeout: 60_000 });
  await expect(rep).toContainText(/\d+ passed, 0 failed/);
  await expect(rep).toContainText('Local storage');
  await expect(rep).toContainText('Background alarms');
});

test('print emergency cookbook', async ({ page, browserName }, info) => {
  await page.emulateMedia({ media: 'print' });
  const book = page.getByTestId('print-cookbook');
  await expect(book).toBeVisible();
  await expect(book).toContainText('Baseline schedule');
  await expect(book).toContainText('Preheat oven to 250°F', { timeout: 30_000 });
  await expect(book).toContainText('Cheddar Gouda Mac and Cheese');
  await expect(page.locator('main')).toBeHidden();
  if (browserName === 'chromium' && info.project.name === 'desktop') {
    const pdf = await page.pdf({ format: 'Letter' });
    expect(pdf.byteLength).toBeGreaterThan(20_000);
  }
});
