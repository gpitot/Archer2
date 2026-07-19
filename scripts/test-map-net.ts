/**
 * Multiplayer smoke test for custom maps: spawns a FRESH wrangler dev (own
 * port — never reuses a stale one), joins two clients to one room on
 * ?map=<name>, and checks the server accepted the map, spawned creeps at
 * the authored camps, and placed heroes on the authored spawns.
 *
 * Usage:  pnpm tsx scripts/test-map-net.ts [mapName]
 */
import { chromium, Browser, Page } from 'playwright';
import { createServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { parseMapJson } from '../src/world/custom/mapSource';
import { withAuto } from './autoUrl';

const ROOT = resolve(import.meta.dirname, '..');
const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';
const WRANGLER_PORT = 8791;
const MAP = process.argv[2] ?? 'glade';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function serverUp(): Promise<boolean> {
  try {
    await fetch(`http://localhost:${WRANGLER_PORT}/`);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const src = parseMapJson(readFileSync(resolve(ROOT, 'maps', `${MAP}.map.json`), 'utf8'));

  console.log('[net] starting wrangler dev...');
  const wrangler: ChildProcess = spawn(
    'pnpm', ['exec', 'wrangler', 'dev', '--port', String(WRANGLER_PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !(await serverUp())) await sleep(500);
  if (!(await serverUp())) throw new Error('wrangler dev not ready');

  const vite = await createServer({
    root: ROOT,
    server: {
      port: 4183, open: false,
      proxy: { '/ws': { target: `ws://localhost:${WRANGLER_PORT}`, ws: true } },
    },
  });
  await vite.listen();
  const base = vite.resolvedUrls!.local[0];
  const room = `MAP${Date.now() % 100000}`;

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (!existsSync(FALLBACK_CHROMIUM)) throw err;
    browser = await chromium.launch({ headless: true, executablePath: FALLBACK_CHROMIUM });
  }
  const errors: string[] = [];

  const open = async (label: string): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
    await page.goto(withAuto(`${base}?map=${MAP}&room=${room}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 20000 });
    await page.waitForFunction(() => (window as any).__game?._playerState, undefined, { timeout: 20000 });
    return page;
  };

  const snap = (page: Page) => page.evaluate(() => {
    const g = (window as any).__game;
    return {
      playerId: g._playerId as string,
      mapName: g._mapName as string,
      heroes: g._state.heroes.map((h: any) => ({ id: h.id, team: h.team, x: h.pos.x, z: h.pos.z })),
      creeps: g._state.creeps.map((c: any) => ({ id: c.id, type: c.type, x: c.pos.x, z: c.pos.z })),
    };
  });

  const p1 = await open('p1');
  await sleep(1000);
  const p2 = await open('p2');
  await sleep(1500);

  const s1 = await snap(p1);
  const s2 = await snap(p2);

  check('both clients joined the custom map', s1.mapName === MAP && s2.mapName === MAP,
    `${s1.mapName}/${s2.mapName}`);
  check('two heroes in the room', s1.heroes.length === 2 && s2.heroes.length === 2);

  const units = src.camps.reduce((n, c) => n + c.units.length, 0);
  check('server spawned authored camps', s1.creeps.length === units, `${s1.creeps.length}/${units}`);
  const campsHit = src.camps.every((c) =>
    s1.creeps.some((cr: { x: number; z: number }) => Math.hypot(cr.x - c.x, cr.z - c.z) < 300));
  check('creeps sit at authored camp positions', campsHit);

  const spawnsHit = s1.heroes.every((h: { team: number; x: number; z: number }) => {
    const sp = src.spawns[h.team % src.spawns.length];
    return Math.hypot(h.x - sp.x, h.z - sp.z) < 300;
  });
  check('heroes placed on authored spawns', src.spawns.length === 0 || spawnsHit,
    JSON.stringify(s1.heroes.map((h: { x: number; z: number }) => [Math.round(h.x), Math.round(h.z)])));

  check('clients agree on creep ids', JSON.stringify(s1.creeps.map((c: { id: string }) => c.id)) ===
    JSON.stringify(s2.creeps.map((c: { id: string }) => c.id)));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  await vite.close();
  wrangler.kill('SIGTERM');

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
