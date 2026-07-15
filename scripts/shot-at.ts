/** Screenshot the game with the camera parked at given world coords. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const [, , xArg, zArg, outArg, distArg] = process.argv;
const X = Number(xArg ?? 816);
const Z = Number(zArg ?? 3104);
const OUT = outArg ?? '/tmp/shot.png';
const DIST = Number(distArg ?? 1600);

async function main() {
  const server = await createServer({ root: '/home/user/Archer2', server: { port: 4174, open: false } });
  await server.listen();
  const url = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(1500);

  await page.evaluate(([x, z, dist]) => {
    const g = (window as any).__game;
    g._cameraLocked = false;
    const THREE_V3 = g._hero.position.constructor;
    g._camera.zoom(dist - 1600);
    g._camera.setTarget(new THREE_V3(x, g._terrain.heightAt(x, z), z));
    // Reveal everything for inspection shots: mark player fog fully visible
    const fog = g._fog;
    const map = fog.team(0);
    map.fill(2);
    g._fogLayer.update(10);
  }, [X, Z, DIST]);
  await page.waitForTimeout(800);

  await page.screenshot({ path: OUT });
  if (errors.length) console.log('PAGE ERRORS:', errors.join(' | '));
  console.log(`wrote ${OUT} at (${X}, ${Z}) dist ${DIST}`);
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
