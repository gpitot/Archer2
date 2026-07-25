/**
 * Client frame-rate benchmark.
 *
 * Runs the offline match in headless Chromium under a CDP CPU throttle, drives
 * a deterministic fight (walk around, spam arrows), and reports the FPS and
 * frame-time percentiles the game's own `?perf=1` monitor logs at 1 Hz.
 *
 * The CPU throttle is the point: the machine this exists for is slower than a
 * dev box, and an unthrottled headless run is too fast to tell anything apart.
 *
 * It also samples the compiled shader-program count early and late in the run.
 * That number must be identical at both ends — if it grows, something is
 * changing a shader define at runtime (almost always the scene's light count),
 * which stalls the main thread recompiling every material mid-fight. See
 * `src/rendering/Lighting.ts`.
 *
 * Usage:
 *   pnpm perf                       # default: 4× throttle, 30 s, auto quality
 *   pnpm perf --throttle 1,4,6      # one run per rate
 *   pnpm perf --seconds 60
 *   pnpm perf --quality low
 */
import { chromium, Browser, Page } from 'playwright';
import { createServer, ViteDevServer } from 'vite';
import { existsSync } from 'fs';
import { resolve } from 'path';

const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';
const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4174;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One parsed `[perf] FPS=…` console line. */
interface PerfSample {
  fps: number;
  avg: number;
  p95: number;
  p99: number;
  max: number;
  drawCalls: number;
  programs: number;
}

interface RunResult {
  throttle: number;
  samples: PerfSample[];
  programsEarly: number;
  programsLate: number;
  renderScale: number;
  quality: string;
  errors: string[];
}

// ── CLI ────────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const THROTTLES = arg('throttle', '4').split(',').map((s) => Number(s.trim()));
const SECONDS = Number(arg('seconds', '30'));
const QUALITY = arg('quality', '');

// ── Console parsing ────────────────────────────────────────────────────

/**
 * Pull the numbers out of a PerformanceMonitor summary line, e.g.
 * `[perf] FPS=58 | avg=17.2ms p50=… p95=22.1ms p99=… max=… | drawCalls=210 tri=… programs=31 | heap=…`
 */
function parsePerfLine(text: string): PerfSample | null {
  if (!text.includes('[perf] FPS=')) return null;
  const num = (re: RegExp): number => {
    const m = text.match(re);
    return m ? Number(m[1]) : NaN;
  };
  const sample: PerfSample = {
    fps: num(/FPS=(\d+(?:\.\d+)?)/),
    avg: num(/avg=(\d+(?:\.\d+)?)ms/),
    p95: num(/p95=(\d+(?:\.\d+)?)ms/),
    p99: num(/p99=(\d+(?:\.\d+)?)ms/),
    max: num(/max=(\d+(?:\.\d+)?)ms/),
    drawCalls: num(/drawCalls=(\d+)/),
    programs: num(/programs=(\d+)/),
  };
  return Number.isFinite(sample.fps) ? sample : null;
}

// ── Scripted fight ─────────────────────────────────────────────────────

/**
 * Level up the hero and hand back its ability ids, so the driver can cast
 * whatever this build actually has rather than hard-coded names.
 */
async function prepareHero(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as any).__game;
    // Levels first, so the arrow ability can be ranked up past 1 and its
    // cooldown is short enough to keep several arrows in flight at once.
    // `debugGrantLevel` may be absent when benchmarking an older revision for a
    // baseline; the fight still runs, just with a rank-1 arrow.
    for (let i = 0; i < 8; i++) g.debugGrantLevel?.();
    for (let i = 0; i < 4; i++) g.debugIssue({ type: 'levelAbility', ability: 'arrow' });
  });
}

/**
 * Compiled shader-program count.
 *
 * Prefers the `__perf` debug global, and falls back to digging the number out
 * of the renderer the game holds — so this works against revisions that predate
 * the debug surface, which is exactly when a baseline is wanted.
 */
async function readPrograms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as any;
    if (w.__perf?.programs) return w.__perf.programs();
    const r = w.__game?._renderer?._renderer;
    return r?.info?.programs?.length ?? NaN;
  });
}

/**
 * The load being measured: walk a square around the spawn while firing arrows
 * as fast as the cooldown allows. Deterministic (no randomness, no input
 * timing dependence) so two runs are comparable.
 */
async function driveFight(page: Page, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  let step = 0;
  while (Date.now() < deadline) {
    await page.evaluate((s: number) => {
      const g = (window as any).__game;
      const st = g.debugState();
      const me = st.heroes.find((h: any) => h.id === st.playerId);
      if (!me) return;
      // Walk the corners of a 600-unit square.
      const corners = [[600, 0], [0, 600], [-600, 0], [0, -600]];
      const [dx, dz] = corners[s % 4];
      g.debugIssue({ type: 'moveTo', x: me.x + dx, z: me.z + dz });
      // Fan arrows across the arena so plenty are in flight at once.
      for (let k = 0; k < 4; k++) {
        const a = (s * 0.7 + k * 1.57);
        g.debugIssue({
          type: 'cast', ability: 'arrow',
          x: me.x + Math.cos(a) * 900, z: me.z + Math.sin(a) * 900,
        });
      }
    }, step);
    step++;
    await sleep(500);
  }
}

// ── One run ────────────────────────────────────────────────────────────

async function runOnce(browser: Browser, address: string, throttle: number): Promise<RunResult> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const samples: PerfSample[] = [];
  const errors: string[] = [];

  page.on('console', (msg) => {
    const sample = parsePerfLine(msg.text());
    if (sample) samples.push(sample);
  });
  page.on('pageerror', (err) => errors.push(err.message));

  // CPU throttling is a CDP-only capability — no Playwright API covers it.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

  const params = ['auto=1', 'perf=1'];
  if (QUALITY) params.push(`quality=${QUALITY}`);
  await page.goto(`${address}?${params.join('&')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__game?.debugReady, undefined, { timeout: 120_000 });

  await prepareHero(page);
  // Let the first frames (shader compiles, texture uploads) fall outside the
  // measurement — they are startup cost, not steady-state cost.
  await sleep(3000);
  samples.length = 0;

  const fight = driveFight(page, SECONDS);

  await sleep(2000);
  const programsEarly = await readPrograms(page);
  await fight;
  const programsLate = await readPrograms(page);
  const renderScale = await page.evaluate(
    () => (window as any).__perf?.renderScale?.() ?? 1,
  );
  const quality = await page.evaluate(
    () => (window as any).__perf?.quality?.() ?? 'n/a',
  );

  await page.close();
  return { throttle, samples, programsEarly, programsLate, renderScale, quality, errors };
}

// ── Reporting ──────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function report(r: RunResult): void {
  const n = r.samples.length;
  console.log(`\n── ${r.throttle}× CPU throttle ── quality=${r.quality} renderScale=${r.renderScale.toFixed(3)}`);
  if (n === 0) {
    console.log('  no [perf] samples collected — did the monitor fail to enable?');
    return;
  }
  const fps = mean(r.samples.map((s) => s.fps));
  const avg = mean(r.samples.map((s) => s.avg));
  const p95 = mean(r.samples.map((s) => s.p95));
  const worstP95 = Math.max(...r.samples.map((s) => s.p95));
  const maxDraw = Math.max(...r.samples.map((s) => s.drawCalls));
  console.log(`  FPS avg        ${fps.toFixed(1)}`);
  console.log(`  frame avg      ${avg.toFixed(1)} ms`);
  console.log(`  frame p95      ${p95.toFixed(1)} ms  (worst second: ${worstP95.toFixed(1)} ms)`);
  console.log(`  drawCalls max  ${maxDraw}`);

  const drift = r.programsLate - r.programsEarly;
  const verdict = !Number.isFinite(drift) ? '(unavailable)'
    : drift === 0 ? '✅ stable'
      : `❌ +${drift} — shaders recompiled mid-fight`;
  console.log(`  programs       ${r.programsEarly} → ${r.programsLate}  ${verdict}`);
  console.log(`  samples        ${n}`);
  if (r.errors.length > 0) {
    console.log(`  ⚠️  ${r.errors.length} page error(s):`);
    r.errors.slice(0, 5).forEach((e) => console.log(`     ${e}`));
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  try {
    vite = await createServer({ root: ROOT, server: { port: PORT, open: false } });
    await vite.listen();
    const address = vite.resolvedUrls!.local[0].replace(/\/$/, '');
    console.log(`[perf-bench] ${address} — ${SECONDS}s per run, throttles: ${THROTTLES.join(', ')}×`);

    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      if (!existsSync(FALLBACK_CHROMIUM)) throw err;
      browser = await chromium.launch({ headless: true, executablePath: FALLBACK_CHROMIUM });
    }

    const results: RunResult[] = [];
    for (const throttle of THROTTLES) {
      console.log(`[perf-bench] running at ${throttle}× throttle…`);
      results.push(await runOnce(browser, address, throttle));
    }
    results.forEach(report);

    const churned = results.filter(
      (r) => Number.isFinite(r.programsEarly) && r.programsLate > r.programsEarly,
    );
    if (churned.length > 0) {
      console.log('\n[perf-bench] ❌ shader program count grew during play — see Lighting.ts');
      process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    await vite?.close();
  }
}

main().catch((err) => {
  console.error('[perf-bench] fatal:', err);
  process.exit(1);
});
