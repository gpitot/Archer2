/**
 * Boot the game on a given map in headless Chromium, verify it loads with
 * no page errors, dump creep/hero state, and save an all-revealed overview
 * screenshot.
 *
 * Usage:  pnpm tsx scripts/shot-map.ts [mapName] [outPng] [zoomOut]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';
import { existsSync } from 'fs';

const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';
const ROOT = resolve(import.meta.dirname, '..');

const [, , nameArg, outArg, zoomArg] = process.argv;
const MAP = nameArg ?? 'glade';
const OUT = outArg ?? `/tmp/shot-${MAP}.png`;
const ZOOM_OUT = Number(zoomArg ?? 1400);

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4179, open: false } });
  await server.listen();
  const url = server.resolvedUrls!.local[0];

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (!existsSync(FALLBACK_CHROMIUM)) throw err;
    browser = await chromium.launch({ headless: true, executablePath: FALLBACK_CHROMIUM });
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs: string[] = [];
  const errors: string[] = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`${url}?map=${MAP}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForTimeout(2500);

  // Pull the camera back and reveal fog so the whole map is inspectable.
  await page.evaluate((zoomOut) => {
    const g = (window as any).__game;
    g._cameraLocked = false;
    g._camera.zoom(zoomOut);
    g._fog.team(0).fill(2);
    g._fogLayer.update(10);
  }, ZOOM_OUT);
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT });

  console.log('map log:', logs.find((l) => l.includes('[map]')) ?? 'MISSING');
  console.log('doodad log:', logs.find((l) => l.includes('[doodads]')) ?? 'MISSING');
  console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
  console.log('screenshot:', OUT);

  const state = await page.evaluate(() => {
    const g = (window as any).__game;
    return {
      creeps: g._state.creeps.map((c: any) => ({ type: c.type, x: Math.round(c.pos.x), z: Math.round(c.pos.z) })),
      heroes: g._state.heroes.map((h: any) => ({ id: h.id, x: Math.round(h.pos.x), z: Math.round(h.pos.z) })),
    };
  });
  console.log('state:', JSON.stringify(state));

  await browser.close();
  await server.close();
  if (errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
