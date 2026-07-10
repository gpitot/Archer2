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

  // Dummy is at (10, -5). Player at (0, -15).
  // Fire three shots toward the dummy, aiming at its position
  for (let shot = 1; shot <= 4; shot++) {
    await page.evaluate(() => {
      const g = (window as any).__game;
      const hero = g._hero;
      const dummy = g._heroes[1]; // dummy is second hero

      // Start charge
      hero.beginCharge();
    });

    // Wait for charge (simulate holding Space)
    await page.waitForTimeout(1000); // 67% charge ≈ 30 damage

    // Fire directly at dummy position
    await page.evaluate(() => {
      const g = (window as any).__game;
      const hero = g._hero;
      const dummy = g._heroes[1];
      const aimPos = dummy.position.clone();
      hero.releaseCharge(aimPos);
    });

    await page.waitForTimeout(1000); // Let projectile fly
    console.log(`=== After shot ${shot} ===`);
    console.table(await dump());
  }

  // Wait for respawn
  console.log('\n=== Waiting for respawn (3s)... ===');
  await page.waitForTimeout(3500);
  console.table(await dump());

  await page.screenshot({ path: resolve(ROOT, 'screenshot-phase4.png') });
  console.log('Saved screenshot-phase4.png');

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
