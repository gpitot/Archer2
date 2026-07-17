/**
 * Editor smoke test: boots /editor.html headlessly, creates a map, paints
 * cliffs and places a tree with real pointer/keyboard input, exercises
 * undo, saves, and verifies both files landed on disk. Cleans up after
 * itself.
 *
 * Usage:  pnpm tsx scripts/test-editor.ts [outPng]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';
import { existsSync, rmSync } from 'fs';

const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';
const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.argv[2] ?? '/tmp/shot-editor.png';
const NAME = 'smoketest';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4181, open: false } });
  await server.listen();
  const url = server.resolvedUrls!.local[0];

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (!existsSync(FALLBACK_CHROMIUM)) throw err;
    browser = await chromium.launch({ headless: true, executablePath: FALLBACK_CHROMIUM });
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`${url}editor.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__editor !== undefined, { timeout: 15000 });
  await page.waitForTimeout(2000);

  const ed = () => page.evaluate(() => {
    const app = (window as any).__editor;
    return {
      name: app._src.name,
      doodads: app._src.doodads.length,
      camps: app._src.camps.length,
      spawns: app._src.spawns.length,
      maxLayer: Math.max(...app._src.layer),
      water: app._src.flags.some((f: number) => f & 2),
      // A visible pond needs at least one interior "floor" point at −64.
      hasPondFloor: app._custom.data.terrain.finalHeight.some((h: number) => h === -64),
    };
  });

  check('boots onto an existing map', (await ed()).name.length > 0, (await ed()).name);

  // New map through the dialog.
  await page.click('#btn-new');
  await page.fill('#new-name', NAME);
  await page.fill('#new-x', '24');
  await page.fill('#new-z', '24');
  await page.click('#new-dialog button[type=submit]');
  await page.waitForTimeout(500);
  check('new map created', (await ed()).name === NAME && (await ed()).maxLayer === 2);

  const vp = (await page.locator('#viewport').boundingBox())!;
  const cx = vp.x + vp.width / 2;
  const cy = vp.y + vp.height / 2;

  // Raise cliffs: key 1, drag across the middle.
  await page.keyboard.press('1');
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  for (let i = 0; i <= 8; i++) await page.mouse.move(cx - 80 + i * 20, cy);
  await page.mouse.up();
  await page.waitForTimeout(400);
  check('raise tool painted layer 3', (await ed()).maxLayer === 3);

  // Water: key 4, click a spot south-west.
  await page.keyboard.press('4');
  await page.mouse.click(cx - 150, cy + 150);
  await page.waitForTimeout(300);
  const afterWater = await ed();
  check('water tool set water flags', afterWater.water);
  check('pond has a visible floor point', afterWater.hasPondFloor);

  // Tree: key w, two clicks.
  await page.keyboard.press('w');
  await page.mouse.click(cx + 150, cy + 100);
  await page.mouse.click(cx + 190, cy + 140);
  await page.waitForTimeout(300);
  check('tree tool placed 2 trees', (await ed()).doodads === 2, `${(await ed()).doodads}`);

  // Camp + spawn.
  await page.keyboard.press('c');
  await page.mouse.click(cx + 60, cy - 120);
  await page.keyboard.press('p');
  await page.mouse.click(cx - 60, cy + 60);
  await page.waitForTimeout(300);
  check('camp + spawn placed', (await ed()).camps === 1 && (await ed()).spawns === 1);

  // Undo the spawn.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  check('undo removed the spawn', (await ed()).spawns === 0 && (await ed()).camps === 1);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  check('redo restored the spawn', (await ed()).spawns === 1);

  // Save writes both files through the dev-server API.
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  const jsonRes = await page.request.get(`${url}maps/${NAME}.map.json`);
  const amapRes = await page.request.get(`${url}maps/${NAME}.amap`);
  const amapBody = amapRes.ok() ? await amapRes.body() : Buffer.alloc(0);
  check('save wrote .map.json', jsonRes.ok() && (await jsonRes.text()).includes('"archer-map"'));
  check('save wrote .amap', amapRes.ok() && amapBody.subarray(0, 4).toString() === 'AMAP',
    `${amapBody.length} B`);

  await page.screenshot({ path: OUT });
  console.log('screenshot:', OUT);
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  await server.close();

  for (const f of [`maps/${NAME}.map.json`, `maps/${NAME}.amap`]) {
    rmSync(resolve(ROOT, f), { force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
