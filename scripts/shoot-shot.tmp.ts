/** Close-up screenshots of the bow-release (shoot) animation. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4181, open: false } });
  await server.listen();
  const address = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  try {
    await page.goto(`${address}?map=test`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__game?.debugReady, undefined, { timeout: 30_000 });
    await page.waitForTimeout(1500);

    await page.evaluate(() => {
      const g = (window as any).__game;
      g._camera.zoom(-1200);
      g.debugIssue({ type: 'levelAbility', ability: 'arrow' });
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${ROOT}/scripts/shoot-0-rest.png` });

    const armsAt = () => page.evaluate(() => {
      const g = (window as any).__game;
      const s = g.debugState();
      const v = g._heroViews.get(s.playerId);
      return {
        timer: v._shootTimer.toFixed(3),
        armL: v._armL.rotation.x.toFixed(2),
        armR: v._armR.rotation.x.toFixed(2),
        armRz: v._armR.rotation.z.toFixed(2),
        bow: v._bow.rotation.x.toFixed(2),
      };
    });

    // Fire toward screen-left so the stance reads from the side.
    await page.evaluate(() => {
      const g = (window as any).__game;
      const s = g.debugState();
      const me = s.heroes.find((h: any) => h.id === s.playerId);
      g.debugIssue({ type: 'fire', aimX: me.x - 900, aimZ: me.z });
    });
    for (const [i, delay] of [[1, 100], [2, 150], [3, 200], [4, 250], [5, 900]] as const) {
      await page.waitForTimeout(delay);
      console.log(`shot ${i}:`, await armsAt());
      await page.screenshot({ path: `${ROOT}/scripts/shoot-${i}.png` });
    }

    console.log('errors:', errors.length ? errors : 'none');
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
