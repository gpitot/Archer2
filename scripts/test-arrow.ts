import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';
import { withAuto } from './autoUrl';

const ROOT = resolve(import.meta.dirname, '..');

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4174 } });
  await server.listen();
  const addr = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.goto(withAuto(addr), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(1000);

  const debug = () => page.evaluate(() => {
    const g = (window as any).__game;
    const h = g._hero;
    return {
      pos: [h.position.x.toFixed(1), h.position.z.toFixed(1)],
      hp: h.hp,
      abilityState: h.ability?.state,
      cooldownProgress: h.ability?.cooldownProgress?.toFixed(2),
      abilityLevel: h.ability?.level,
      projectiles: g._projectiles.active.length,
    };
  });

  console.log('=== Initial ===');
  console.log(await debug());

  // Fire arrow
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(50);
  console.log('\n=== After fire ===');
  console.log(await debug());

  // Wait for cooldown
  await page.waitForTimeout(2500);
  console.log('\n=== After cooldown ===');
  console.log(await debug());

  // Level up with Ctrl+Q
  await page.keyboard.down('ControlLeft');
  await page.keyboard.press('KeyQ');
  await page.keyboard.up('ControlLeft');
  console.log('\n=== After level up ===');
  console.log(await debug());

  // Level up twice more
  for (let i = 0; i < 2; i++) {
    await page.keyboard.down('ControlLeft');
    await page.keyboard.press('KeyQ');
    await page.keyboard.up('ControlLeft');
  }
  console.log('\n=== Level 4 ===');
  console.log(await debug());

  await page.screenshot({ path: resolve(ROOT, 'screenshot-arrow.png') });
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
