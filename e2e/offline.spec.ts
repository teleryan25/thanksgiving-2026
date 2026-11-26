import { expect, test } from '@playwright/test';
import { trackErrors } from './helpers';

test('becomes offline-ready only after a verified cache, then reloads offline', async ({ page, context }) => {
  const errs = trackErrors(page);
  await page.goto('./');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // First visit: SW installed; reload so it controls the page.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.getByTestId('btn-settings').click();
  await expect(page.getByTestId('offline-status')).toContainText('Offline-ready', { timeout: 30_000 });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('clock')).toBeVisible();
  await expect(page.getByTestId('now-card')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('tab-recipes').click();
  await expect(page.getByTestId('recipe-stuffing')).toBeVisible();
  // Fonts come from the cache, not the network.
  const fontsOk = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px "Space Grotesk"');
  });
  expect(fontsOk).toBe(true);
  await context.setOffline(false);
  expect(errs.filter((e) => !e.includes('net::ERR_INTERNET_DISCONNECTED'))).toEqual([]);
});
