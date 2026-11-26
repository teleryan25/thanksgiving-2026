import { expect, type Page } from '@playwright/test';

export function trackErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(`console: ${m.text()}`);
  });
  return errs;
}

export async function expectNoHorizontalOverflow(page: Page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, 'page must not scroll horizontally').toBeLessThanOrEqual(iw);
}

export async function enterSim(page: Page) {
  await page.getByTestId('btn-settings').click();
  await page.getByTestId('btn-enter-sim').click();
  await expect(page.getByTestId('sim-banner')).toBeVisible();
  await expect(page.getByTestId('now-card')).toBeVisible();
}

export async function doneCount(page: Page): Promise<number> {
  const t = await page.getByTestId('projected').locator('..').innerText();
  return Number(/Done\s+(\d+)\//.exec(t)?.[1] ?? -1);
}
