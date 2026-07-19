/**
 * Launches the Vite dev server, opens the game in headless Chromium,
 * takes a screenshot, and reports any console errors.
 *
 * Usage: pnpm shot
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { withAuto } from './autoUrl';

// Use a system-provided Chromium when the Playwright-managed one is absent
// (e.g. sandboxed CI/remote environments with a pre-installed browser).
const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';

const ROOT = resolve(import.meta.dirname, '..');
const SCREENSHOT_PATH = resolve(ROOT, 'screenshot.png');

async function main() {
  // 1. Start Vite dev server
  console.log('[shot] Starting Vite dev server...');
  const server = await createServer({
    root: ROOT,
    server: { port: 4173, open: false },
  });
  await server.listen();
  const address = server.resolvedUrls!.local[0];
  console.log(`[shot]   → ${address}`);

  // 2. Launch browser
  console.log('[shot] Launching headless Chromium...');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (!existsSync(FALLBACK_CHROMIUM)) throw err;
    console.log(`[shot]   (falling back to ${FALLBACK_CHROMIUM})`);
    browser = await chromium.launch({ headless: true, executablePath: FALLBACK_CHROMIUM });
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  // Collect console messages
  const logs: string[] = [];
  const errors: string[] = [];
  page.on('console', (msg) => {
    const text = `[browser:${msg.type()}] ${msg.text()}`;
    logs.push(text);
  });
  page.on('pageerror', (err) => {
    errors.push(`[PAGE ERROR] ${err.message}`);
  });
  page.on('requestfailed', (req) => {
    errors.push(`[REQ FAIL] ${req.url()} — ${req.failure()?.errorText}`);
  });

  try {
    // 3. Navigate and wait for canvas
    console.log('[shot] Navigating to game...');
    await page.goto(withAuto(address), { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('canvas', { timeout: 10000 });
    console.log('[shot] Canvas found.');

    // Let a few frames render
    await page.waitForTimeout(2000);

    // Check for WebGL context
    const glInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const gl = (canvas as HTMLCanvasElement).getContext('webgl2')
        || (canvas as HTMLCanvasElement).getContext('webgl');
      return gl ? 'WebGL OK' : 'WebGL MISSING';
    });
    console.log(`[shot]   ${glInfo}`);

    // 4. Screenshot
    console.log(`[shot] Taking screenshot → screenshot.png`);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });

    // Report
    if (errors.length > 0) {
      console.log(`\n[shot] ⚠️  ${errors.length} error(s):`);
      errors.forEach((e) => console.log(`  ${e}`));
    }
    if (logs.length > 0) {
      console.log(`[shot] ${logs.length} console message(s)`);
      logs.forEach((l) => console.log(`  ${l}`));
    }

    const fileSize = (await import('fs')).statSync(SCREENSHOT_PATH).size;
    console.log(`[shot] ✅ Done — ${(fileSize / 1024).toFixed(1)} KB`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error('[shot] Fatal error:', err);
  process.exit(1);
});
