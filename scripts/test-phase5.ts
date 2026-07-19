import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';
import { withAuto } from './autoUrl';

const ROOT = resolve(import.meta.dirname, '..');

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4175 } });
  await server.listen();
  const addr = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.goto(withAuto(addr), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(2000);

  const debug = () => page.evaluate(() => {
    const g = (window as any).__game;
    const p = g._hero;
    const d = g._heroes[1];
    return {
      playerPos: [p.position.x.toFixed(1), p.position.y.toFixed(1), p.position.z.toFixed(1)],
      dummyPos: [d.position.x.toFixed(1), d.position.y.toFixed(1), d.position.z.toFixed(1)],
      dummyHp: d.hp,
      projCount: g._projectiles.active.length,
      playerState: p.state,
      abilityState: p.ability?.state,
      chargeLevel: p.ability?.chargeLevel.toFixed(2),
    };
  });

  console.log('=== Initial ===');
  console.log(await debug());

  // Move player closer to dummy for shorter flight
  // Player at (0, y, -15), dummy at (10, y, -5)
  // Click near dummy
  await page.click('canvas', { position: { x: 600, y: 350 } });
  await page.waitForTimeout(3000);
  console.log('\n=== After move ===');
  console.log(await debug());

  // Fire a shot at the dummy using page.evaluate
  await page.evaluate(() => {
    const g = (window as any).__game;
    g._hero.beginCharge();
  });
  await page.waitForTimeout(500);
  
  const beforeFire = await debug();
  console.log('\n=== Before fire (charging) ===');
  console.log(beforeFire);

  await page.evaluate(() => {
    const g = (window as any).__game;
    const dummy = g._heroes[1];
    g._hero.releaseCharge(dummy.position.clone());
  });
  
  // Check immediately
  console.log('\n=== 50ms after fire ===');
  await page.waitForTimeout(50);
  console.log(await debug());

  console.log('\n=== 200ms after fire ===');
  await page.waitForTimeout(150);
  console.log(await debug());

  console.log('\n=== 500ms after fire ===');
  await page.waitForTimeout(300);
  console.log(await debug());

  console.log('\n=== 1000ms after fire ===');
  await page.waitForTimeout(500);
  console.log(await debug());

  await page.screenshot({ path: resolve(ROOT, 'screenshot-phase5-debug.png') });

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
