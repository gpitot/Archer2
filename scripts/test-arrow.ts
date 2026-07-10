import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4175 } });
  await server.listen();
  const addr = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.goto(addr, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(1000);

  const state = () => page.evaluate(() => {
    const g = (window as any).__game;
    const h = g.hero;
    const a = h.ability;
    const p = h.position;
    return {
      heroState: h.state,
      abilityState: a.state,
      chargeLevel: a.chargeLevel.toFixed(2),
      posX: p.x.toFixed(1),
      posZ: p.z.toFixed(1),
      projectiles: g._projectiles.active.length,
    };
  });

  // 1. Click to move somewhere, then start charging while moving
  console.log('=== Test 1: Move while charging ===');
  await page.click('canvas', { position: { x: 900, y: 200 } });
  await page.waitForTimeout(300);
  console.log('After click (moving):', await state());

  await page.keyboard.down('Space');
  await page.waitForTimeout(500);
  console.log('500ms charging + moving:', await state());
  // Should show: heroState=moving, abilityState=charging, pos changed

  // 2. Move mouse to a different direction, release to aim at mouse
  console.log('\n=== Test 2: Aim toward mouse ===');
  // Move mouse to bottom-left of canvas (aim SW of hero)
  await page.mouse.move(200, 500);
  await page.waitForTimeout(100);
  await page.keyboard.up('Space');
  await page.waitForTimeout(200);
  console.log('After fire toward mouse:', await state());
  // Should have 1 projectile heading in roughly (-X, +Z) direction (SW)

  await page.waitForTimeout(1500);
  console.log('After 1.5s flight:', await state());

  await page.screenshot({ path: resolve(ROOT, 'screenshot-changes.png') });
  console.log('\nSaved screenshot-changes.png');

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
