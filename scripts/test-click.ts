import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4174 } });
  await server.listen();
  const addr = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.goto(addr, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(1000);

  // Read hero position before click
  const posBefore = await page.evaluate(() => {
    const g = (window as any).__game;
    const p = g.hero.position;
    return { x: p.x, y: p.y, z: p.z, waypoints: g.hero.waypointCount };
  });
  console.log('Before click:', JSON.stringify(posBefore));

  // Click offset from center (bottom-left quadrant of screen)
  await page.click('canvas', { position: { x: 200, y: 500 } });
  await page.waitForTimeout(2000);

  // Read hero position after
  const posAfter = await page.evaluate(() => {
    const g = (window as any).__game;
    const p = g.hero.position;
    return { x: p.x, y: p.y, z: p.z, waypoints: g.hero.waypointCount };
  });
  console.log('After click:', JSON.stringify(posAfter));

  const moved = posBefore.x !== posAfter.x || posBefore.z !== posAfter.z;
  console.log(moved ? '✅ Hero moved!' : '❌ Hero did NOT move');

  await page.screenshot({ path: resolve(ROOT, 'screenshot-after-click.png') });
  console.log('Saved screenshot-after-click.png');

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
