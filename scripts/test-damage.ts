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

  const dump = () => page.evaluate(() => {
    const g = (window as any).__game;
    return g._heroes.map((h: any, i: number) => ({
      i,
      alive: h.isAlive,
      hp: h.hp,
      ratio: h.hpRatio.toFixed(2),
      invuln: h.isInvulnerable,
      pos: `${h.position.x.toFixed(1)}, ${h.position.z.toFixed(1)}`,
    }));
  });

  console.log('=== Before ===');
  console.table(await dump());

  // Dummy at (200, -100). Player at (0, -300). Arrow does 200 dmg at level 1.
  // Learn Shoot Arrow (skill point)
  await page.keyboard.down('ControlLeft');
  await page.keyboard.press('KeyQ');
  await page.keyboard.up('ControlLeft');
  await page.waitForTimeout(100);

  // One shot kills dummy (100 HP).
  await page.evaluate(() => {
    const g = (window as any).__game;
    const dummy = g._heroes[1];
    g._hero.fireAbility(dummy.position.clone());
  });
  await page.waitForTimeout(500);
  console.log('=== After shot (dmg=200) ===');
  console.table(await dump());

  // Wait for respawn
  await page.waitForTimeout(3500);
  console.log('=== After respawn ===');
  console.table(await dump());

  await page.screenshot({ path: resolve(ROOT, 'screenshot-damage.png') });
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
