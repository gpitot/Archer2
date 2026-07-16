/**
 * Browser driver: reproduces a gameplay sequence in the real client (network
 * mode against wrangler dev) and captures per-frame state traces instead of
 * screenshots.
 *
 * Sequence: two clients join the same room. The shooter levels Shoot Arrow
 * and fires three arrows toward the shop; the observer just watches. Both
 * clients' traces are dumped:
 *   traces/client-own.jsonl     — the shooter (own arrows: local prediction path)
 *   traces/client-remote.jsonl  — the observer (same arrows: interpolation path)
 *
 * Inspect with:
 *   pnpm trace traces/client-own.jsonl --motion cosmetic:pool_19
 *   pnpm trace traces/client-remote.jsonl --motion proj:p1
 *
 * Usage: pnpm drive
 * Starts wrangler dev itself unless something already listens on :8787.
 */
import { chromium, Browser, Page } from 'playwright';
import { createServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';
const ROOT = resolve(import.meta.dirname, '..');
const TRACES_DIR = resolve(ROOT, 'traces');
const WRANGLER_PORT = 8787;
const VITE_PORT = 4173;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serverUp(): Promise<boolean> {
  try {
    await fetch(`http://localhost:${WRANGLER_PORT}/`);
    return true;
  } catch {
    return false;
  }
}

async function ensureWrangler(): Promise<ChildProcess | null> {
  if (await serverUp()) {
    console.log(`[drive] reusing wrangler dev already on :${WRANGLER_PORT}`);
    return null;
  }
  console.log('[drive] starting wrangler dev...');
  const proc = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(WRANGLER_PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr!.on('data', (d: Buffer) => {
    const s = d.toString();
    if (s.toLowerCase().includes('error')) console.error(`[wrangler] ${s.trim()}`);
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await serverUp()) {
      console.log('[drive] wrangler dev ready');
      return proc;
    }
    await sleep(500);
  }
  proc.kill();
  throw new Error('wrangler dev did not become ready within 60s');
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    if (!existsSync(FALLBACK_CHROMIUM)) throw err;
    return await chromium.launch({ headless: true, executablePath: FALLBACK_CHROMIUM });
  }
}

async function openClient(browser: Browser, room: string, label: string, errors: string[]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (err) => errors.push(`[${label}] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[${label}] ${msg.text()}`);
  });
  const url = `http://localhost:${VITE_PORT}/?room=${room}&debug=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__game?.debugReady, undefined, { timeout: 30_000 });
  console.log(`[drive] ${label} ready`);
  return page;
}

async function dumpTrace(page: Page, file: string): Promise<string> {
  const trace: string = await page.evaluate(() => (window as any).__game.debugDumpTrace());
  mkdirSync(TRACES_DIR, { recursive: true });
  const out = resolve(TRACES_DIR, file);
  writeFileSync(out, trace);
  const frames = trace.split('\n').filter((l) => l.trim()).length;
  const projIds = new Set<string>();
  const cosIds = new Set<string>();
  for (const line of trace.split('\n')) {
    if (!line.trim()) continue;
    const l = JSON.parse(line);
    for (const p of l.projectiles ?? []) projIds.add(p.id);
    for (const c of l.cosmetic ?? []) cosIds.add(c.id);
  }
  console.log(`[drive] ${file}: ${frames} frames, server projectiles [${[...projIds].join(', ') || 'none'}], cosmetic [${[...cosIds].join(', ') || 'none'}]`);
  return out;
}

async function main(): Promise<void> {
  const wrangler = await ensureWrangler();

  console.log('[drive] starting vite...');
  const vite = await createServer({
    root: ROOT,
    server: { port: VITE_PORT, open: false },
  });
  await vite.listen();

  const browser = await launchBrowser();
  try {
    const errors: string[] = [];
    // Fresh room per run so no state lingers from previous drives.
    const room = `DRV${Date.now().toString(36).toUpperCase().slice(-5)}`;
    console.log(`[drive] room ${room}`);

    const observer = await openClient(browser, room, 'observer', errors);
    const shooter = await openClient(browser, room, 'shooter', errors);

    // Let the snapshot/interpolation buffers warm up.
    await sleep(1000);

    // Shooter learns Shoot Arrow (heroes start with one skill point); wait
    // for server confirmation via reconciliation.
    await shooter.evaluate(() => (window as any).__game.debugIssue({ type: 'levelAbility', ability: 'arrow' }));
    await shooter.waitForFunction(() => {
      const g = (window as any).__game;
      const s = g.debugState();
      return s.heroes.find((h: any) => h.id === s.playerId)?.abilityLevel >= 1;
    }, undefined, { timeout: 10_000 });
    console.log('[drive] shooter ability learned');

    // Fire three arrows toward the shop (open, walkable ground), spaced past
    // the level-1 cooldown (2.25 s).
    for (let shot = 0; shot < 3; shot++) {
      await shooter.evaluate(() => {
        const g = (window as any).__game;
        const s = g.debugState();
        const me = s.heroes.find((h: any) => h.id === s.playerId);
        const dx = s.shop.x - me.x;
        const dz = s.shop.z - me.z;
        const len = Math.hypot(dx, dz) || 1;
        g.debugIssue({ type: 'fire', aimX: me.x + (dx / len) * 900, aimZ: me.z + (dz / len) * 900 });
      });
      console.log(`[drive] fired arrow ${shot + 1}/3`);
      await sleep(2500);
    }

    await dumpTrace(shooter, 'client-own.jsonl');
    await dumpTrace(observer, 'client-remote.jsonl');

    if (errors.length > 0) {
      console.log(`[drive] ⚠️ ${errors.length} page error(s):`);
      errors.slice(0, 10).forEach((e) => console.log(`  ${e}`));
    }
  } finally {
    await browser.close();
    await vite.close();
    if (wrangler) wrangler.kill();
  }
}

main().catch((err) => {
  console.error('[drive] fatal:', err);
  process.exit(1);
});
