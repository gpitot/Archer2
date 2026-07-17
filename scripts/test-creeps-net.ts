/**
 * Two-client network verification of jungle creeps against wrangler dev:
 * registry hydration, cross-client creep motion, kill + reward flush,
 * event-carried death, idle snapshot omission, and late-joiner state.
 */
import { chromium, Browser, Page } from 'playwright';
import { createServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const WRANGLER_PORT = 8787;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serverUp(): Promise<boolean> {
  try { await fetch(`http://localhost:${WRANGLER_PORT}/`); return true; } catch { return false; }
}

async function main() {
  let wrangler: ChildProcess | null = null;
  if (!(await serverUp())) {
    console.log('[net] starting wrangler dev...');
    wrangler = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(WRANGLER_PORT)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !(await serverUp())) await sleep(500);
    if (!(await serverUp())) throw new Error('wrangler dev not ready');
    console.log('[net] wrangler ready');
  }

  const vite = await createServer({
    root: ROOT,
    server: {
      port: 4177, open: false,
      proxy: { '/ws': { target: `ws://localhost:${WRANGLER_PORT}`, ws: true } },
    },
  });
  await vite.listen();
  const base = vite.resolvedUrls!.local[0];
  const room = `CREEP${Date.now() % 100000}`;

  const browser: Browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
  const errors: string[] = [];
  const open = async (label: string): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
    await page.goto(`${base}?map=test&room=${room}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 20000 });
    await page.waitForFunction(() => (window as any).__game?._playerState, undefined, { timeout: 20000 });
    return page;
  };

  const snap = (page: Page) => page.evaluate(() => {
    const g = (window as any).__game;
    return {
      playerId: g._playerId,
      creeps: g._state.creeps.map((c: any) => ({
        id: c.id, type: c.type, x: Math.round(c.pos.x), z: Math.round(c.pos.z),
        hp: c.hp, level: c.level, alive: c.alive,
      })),
      views: g._creepViews.size,
      gold: g._playerState.gold, xp: g._playerState.xp,
      lastSnapCreeps: g._network?.latestSnapshot?.creeps?.length ?? null,
    };
  });
  const cmd = (page: Page, c: any) => page.evaluate((cc) => (window as any).__game._enqueueCommand(cc), c);

  console.log('[net] opening client A + B');
  const A = await open('A');
  const B = await open('B');
  await sleep(1500);

  const a0 = await snap(A);
  const b0 = await snap(B);
  console.log('A0', JSON.stringify(a0));
  console.log('B0', JSON.stringify(b0));
  if (a0.creeps.length !== 6 || b0.creeps.length !== 6) throw new Error('registry hydration failed');

  // A walks to the west ghoul camp → creeps move on BOTH clients.
  const c1 = a0.creeps.find((c: any) => c.id === 'c1')!;
  await cmd(A, { type: 'moveTo', x: c1.x + 100, z: c1.z + 100 });
  await B.waitForFunction(() => {
    const g = (window as any).__game;
    const c = g._state.creeps.find((c: any) => c.id === 'c1' || c.id === 'c2');
    return g._state.creeps.some((c: any) => {
      const dx = c.pos.x - c.spawnPos.x, dz = c.pos.z - c.spawnPos.z;
      return dx * dx + dz * dz > 100;
    });
  }, undefined, { timeout: 30000 });
  console.log('[net] B sees creeps chasing A ✓');

  // A kills a ghoul: level arrow + fire until a creep dies.
  await cmd(A, { type: 'levelAbility', ability: 'arrow' });
  for (let i = 0; i < 10; i++) {
    const aim = await A.evaluate(() => {
      const g = (window as any).__game;
      const p = g._playerState.pos;
      const c = g._state.creeps
        .filter((c: any) => c.alive && c.type === 'ghoul')
        .sort((a: any, b: any) =>
          ((a.pos.x - p.x) ** 2 + (a.pos.z - p.z) ** 2) - ((b.pos.x - p.x) ** 2 + (b.pos.z - p.z) ** 2))[0];
      return c ? { x: c.pos.x, z: c.pos.z } : null;
    });
    if (!aim) break;
    await cmd(A, { type: 'cast', ability: 'arrow', x: aim.x, z: aim.z });
    await sleep(600);
    if (await A.evaluate(() => (window as any).__game._state.creeps.some((c: any) => !c.alive))) break;
  }

  await B.waitForFunction(
    () => (window as any).__game._state.creeps.some((c: any) => !c.alive),
    undefined, { timeout: 10000 },
  );
  const a1 = await snap(A);
  const b1 = await snap(B);
  console.log('A1', JSON.stringify(a1));
  console.log('B1', JSON.stringify(b1));
  if (a1.xp < 60) throw new Error(`killer xp not flushed: ${a1.xp}`);
  console.log('[net] kill visible on both clients, killer got xp/gold ✓');

  // Idle omission: park BOTH heroes out of every camp's aggro range (random
  // spawns/respawns can land in aggro, so keep re-issuing the retreat), then
  // wait for leash + heal + linger to expire → zero creeps per snapshot.
  let idleOk = false;
  for (let i = 0; i < 20; i++) {
    await cmd(A, { type: 'moveTo', x: -100, z: 700 });
    await cmd(B, { type: 'moveTo', x: 100, z: 700 });
    await sleep(2000);
    const s = await snap(A);
    if (s.lastSnapCreeps === 0) { idleOk = true; break; }
  }
  const aIdle = await snap(A);
  console.log('A-idle', JSON.stringify({ lastSnapCreeps: aIdle.lastSnapCreeps, creeps: aIdle.creeps }));
  if (!idleOk) throw new Error(`idle snapshot still carries creeps: ${aIdle.lastSnapCreeps}`);
  console.log('[net] idle camps cost zero snapshot bytes ✓');

  // Late joiner sees the dead creep dead and survivors alive + healed.
  const C = await open('C');
  await sleep(1000);
  const c0 = await snap(C);
  console.log('C0', JSON.stringify(c0));
  const deadA = a1.creeps.filter((c: any) => !c.alive).map((c: any) => c.id).sort();
  const deadC = c0.creeps.filter((c: any) => !c.alive).map((c: any) => c.id).sort();
  if (JSON.stringify(deadA) !== JSON.stringify(deadC)) {
    throw new Error(`late joiner dead-set mismatch: ${deadA} vs ${deadC}`);
  }
  console.log('[net] late joiner registry matches ✓');

  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  else console.log('NO PAGE ERRORS');

  await browser.close();
  await vite.close();
  wrangler?.kill();
  console.log('[net] DONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
