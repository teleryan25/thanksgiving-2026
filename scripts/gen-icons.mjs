// Renders the app icon SVG to PNGs with Playwright's Chromium (run once: npm run icons).
import { chromium } from '@playwright/test';
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#fbf6ec"/>
<g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
<circle cx="256" cy="256" r="220" fill="#5f7d5b"/>
<path d="M256 120c-60 0-104 52-104 118 0 58 38 104 104 104s104-46 104-104c0-66-44-118-104-118z" fill="#b9573a"/>
<rect x="176" y="330" width="160" height="40" rx="20" fill="#2a2a28"/>
<circle cx="256" cy="230" r="34" fill="#fbf6ec"/>
<path d="M240 230h32M256 214v32" stroke="#2a2a28" stroke-width="10" stroke-linecap="round"/>
</g></svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192', 192, 0], ['icon-512', 512, 0], ['icon-maskable-512', 512, 70], ['apple-touch-icon', 180, 20]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `public/icons/${name}.png`, omitBackground: false });
}
await browser.close();
console.log('icons written');
