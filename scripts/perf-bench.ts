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
 * Read `frame avg` / `frame p95`, not `frames/sec`. Headless Chromium in a
 * container throttles requestAnimationFrame hard (often to a couple of hertz)
 * no matter how cheap the frames are, so the rendered frame rate here says
 * nothing. Per-frame *work* is what this measures, and it is what translates to
 * frames on a real machine.
 *
 * It also tracks the compiled shader-program count once a second.
 *
 * Some growth early on is normal and harmless: a material compiles the first
 * time something using it is actually drawn, so the first arrow, the first hit
 * burst, and the first death each add one. What must not happen is growth that
 * keeps going — that means a shader define is changing at runtime (almost always
 * the scene's light count), which stalls the main thread recompiling every
 * material in the scene, repeatedly, mid-fight. See `src/rendering/Lighting.ts`.
 *
 * So the check is on the *tail* of the run: once the fight is underway, the
 * count must be flat.
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

/** One parsed `[perf] FPS=…` console line — the monitor emits one per second. */
interface PerfSample {
  /** The monitor's 1000/avg figure: frames per second the *work* would allow. */
  fps: number;
  avg: number;
  p95: number;
  p99: number;
  max: number;
  drawCalls: number;
  /**
   * Frames actually rendered in that second. Distinct from `fps`: rAF can be
   * capped by vsync, or throttled hard in a headless container, so this is the
   * real frame rate while `fps` is the rate the per-frame cost would permit.
   */
  frames: number;
}

interface RunResult {
  throttle: number;
  samples: PerfSample[];
  /** Compiled-program count sampled once a second through the fight. */
  programs: number[];
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
    frames: num(/samples=(\d+)/),
  };
  return Number.isFinite(sample.fps) ? sample : null;
}

// ── Scripted fight ─────────────────────────────────────────────────────

/** Put the hero in the state a real mid-game fight would find it in. */
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

  // Poll the program count alongside the fight, so the report shows how it
  // evolves rather than just its endpoints.
  const programs: number[] = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      programs.push(await readPrograms(page));
      await sleep(1000);
    }
  })();

  await driveFight(page, SECONDS);
  polling = false;
  await poller;

  const renderScale = await page.evaluate(
    () => (window as any).__perf?.renderScale?.() ?? 1,
  );
  const quality = await page.evaluate(
    () => (window as any).__perf?.quality?.() ?? 'n/a',
  );

  await page.close();
  return { throttle, samples, programs, renderScale, quality, errors };
}

// ── Reporting ──────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Growth in the program count over the last two thirds of the run, or null when
 * there aren't enough samples to say. Skipping the first third lets first-draw
 * compiles settle, so what's left is steady-state churn.
 */
function programTailGrowth(series: number[]): number | null {
  if (series.length < 6) return null;
  const tail = series.slice(Math.floor(series.length / 3));
  return Math.max(...tail) - tail[0];
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
  const frames = mean(r.samples.map((s) => s.frames));
  console.log(`  frames/sec     ${frames.toFixed(1)}  (actually rendered)`);
  console.log(`  FPS if uncapped${fps.toFixed(1).padStart(7)}  (1000 / frame work)`);
  console.log(`  frame avg      ${avg.toFixed(1)} ms`);
  console.log(`  frame p95      ${p95.toFixed(1)} ms  (worst second: ${worstP95.toFixed(1)} ms)`);
  console.log(`  drawCalls max  ${maxDraw}`);

  const series = r.programs.filter(Number.isFinite);
  const tailGrowth = programTailGrowth(series);
  const verdict = tailGrowth === null ? '(unavailable)'
    : tailGrowth === 0 ? '✅ flat once the fight is underway'
      : `❌ +${tailGrowth} in the tail — shaders recompiling mid-fight`;
  console.log(`  programs       ${series.length > 0 ? series.join(' ') : 'n/a'}`);
  console.log(`                 ${verdict}`);
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

    const churned = results.filter((r) => {
      const growth = programTailGrowth(r.programs.filter(Number.isFinite));
      return growth !== null && growth > 0;
    });
    if (churned.length > 0) {
      console.log('\n[perf-bench] ❌ shader programs still being compiled mid-fight — see Lighting.ts');
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
