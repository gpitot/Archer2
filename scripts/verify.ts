/**
 * Headless end-to-end verification: boots the game, then checks
 * render stats, respawn validity, cross-arena pathfinding timing,
 * and arrow/obstacle collision — reporting pass/fail per check.
 *
 * Usage: pnpm tsx scripts/verify.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync } from 'fs';
import { withAuto } from './autoUrl';

const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';

async function main() {
  const server = await createServer({ root: process.cwd(), server: { port: 4175, open: false } });
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

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(withAuto(url), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(2500);

  const results = await page.evaluate(() => {
    const g = (window as any).__game;
    const out: Record<string, unknown> = {};

    // Render stats
    const info = g._renderer._renderer.info;
    out.drawCalls = info.render.calls;
    out.triangles = info.render.triangles;

    // Respawn validity: 20 respawns all walkable & reachable from shop
    let respawnOk = 0;
    for (let i = 0; i < 20; i++) {
      const pos = g._findRespawnPosition();
      const { gx, gz } = g._navGrid.worldToGrid(pos.x, pos.z);
      if (g._navGrid.isWalkable(gx, gz) &&
          g._pathfinder.isReachable(pos.x, pos.z, g._shop.position.x, g._shop.position.z)) {
        respawnOk++;
      }
    }
    out.respawnOk = `${respawnOk}/20`;

    // Cross-arena path timing (hero → far corner of walkable arena)
    const hero = g._hero.position;
    const t0 = performance.now();
    const path = g._pathfinder.findSmoothedPath(hero.x, hero.z, g._shop.position.x, g._shop.position.z);
    out.pathToShopMs = +(performance.now() - t0).toFixed(1);
    out.pathFound = !!path;

    // Unreachable goal (across the void to another arena) resolves fast
    const t1 = performance.now();
    const noPath = g._pathfinder.findSmoothedPath(hero.x, hero.z, 11000, 4000);
    out.unreachableMs = +(performance.now() - t1).toFixed(1);
    out.unreachableNull = noPath === null;

    // Obstacle collision: sphereCast against a known solid doodad AABB
    const obstacles = g._obstacleRegistry.obstacles;
    out.obstacleCount = obstacles.length;
    if (obstacles.length > 0) {
      const o = obstacles[0];
      out.sphereCastHit = g._obstacleRegistry.sphereCast(o.center.clone(), 5) !== null;
      const far = o.center.clone();
      far.x += 5000;
      out.sphereCastMiss = g._obstacleRegistry.sphereCast(far, 5) === null;
    }

    // Terrain sanity: heightAt varies across the arena
    const h1 = g._terrain.heightAt(816, 3104);
    const h2 = g._terrain.heightAt(-2000, 500);
    out.heightVaries = Math.abs(h1 - h2) > 1;

    return out;
  });

  console.log('verification results:');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
  if (pageErrors.length) {
    console.log('PAGE ERRORS:', pageErrors.join(' | '));
    process.exitCode = 1;
  }

  await browser.close();
  await server.close();
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
