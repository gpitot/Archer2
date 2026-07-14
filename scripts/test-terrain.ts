/**
 * Verifies the 3D terrain conversion end-to-end:
 *  - hero climbs a hill (Y follows terrain height)
 *  - a too-steep peak is blocked by navigation
 *  - an arrow fired across a height difference still HITS (2D collision)
 *
 * Usage: pnpm tsx scripts/test-terrain.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4175 } });
  await server.listen();
  const addr = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('[PAGE ERROR]', e.message));

  await page.goto(addr, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(800);

  // ── 1. Terrain sampling + steep-cell blocking ──
  const terrain = await page.evaluate(() => {
    const g = (window as any).__game;
    const t = g._terrain;
    const nav = g._navGrid;
    const steep = { x: 850, z: -620 }; // the steep peak from Terrain.HILLS
    const gsteep = nav.worldToGrid(steep.x, steep.z);
    return {
      heightAtSpawn: t.heightAt(0, -300).toFixed(1),
      heightAtHill: t.heightAt(650, 520).toFixed(1),
      heightAtFlatBorder: t.heightAt(1900, 1900).toFixed(1),
      slopeAtSteep: t.slopeAt(steep.x, steep.z).toFixed(3),
      steepCellWalkable: nav.isWalkable(gsteep.gx, gsteep.gz),
    };
  });
  console.log('=== Terrain ===');
  console.log(terrain);

  // ── 2. Hero climbs a hill: place it, path onto the big hill, watch Y rise ──
  await page.evaluate(() => {
    const g = (window as any).__game;
    const THREE = (window as any).THREE ?? null;
    const h = g._hero;
    // Teleport near the big hill base, then order a move up it.
    h.mesh.position.set(300, g._terrain.heightAt(300, 200) + 0.5, 200);
    h.setDestination({ x: 650, y: 0, z: 520 });
  });
  const climbStart = await page.evaluate(() => (window as any).__game._hero.position.y.toFixed(1));
  await page.waitForTimeout(2500);
  const climbEnd = await page.evaluate(() => {
    const h = (window as any).__game._hero;
    return { y: h.position.y.toFixed(1), x: h.position.x.toFixed(0), z: h.position.z.toFixed(0) };
  });
  console.log('\n=== Hero climb ===');
  console.log({ startY: climbStart, end: climbEnd });

  // ── 3. Arrow across a height gap must still hit (2D collision) ──
  const hit = await page.evaluate(async () => {
    const g = (window as any).__game;
    const shooter = g._hero;
    const victim = g._heroes[1];
    // Learn the ability to max.
    for (let i = 0; i < 4; i++) shooter.spendSkillPoint?.() ?? shooter.ability.levelUp();
    // Put shooter high on the hill, victim below, offset only in X.
    shooter.mesh.position.set(650, g._terrain.heightAt(650, 520) + 0.5, 520);
    victim.mesh.position.set(950, g._terrain.heightAt(950, 520) + 0.5, 520);
    shooter.stop?.();
    const before = victim.hp;
    // Aim straight at the (lower) victim and fire.
    shooter.fireAbility({ x: 950, y: 0, z: 520 });
    // Simulate ~1s of flight.
    await new Promise((r) => setTimeout(r, 800));
    return {
      shooterY: shooter.position.y.toFixed(1),
      victimY: victim.position.y.toFixed(1),
      heightGap: (shooter.position.y - victim.position.y).toFixed(1),
      hpBefore: before,
      hpAfter: victim.hp,
      damaged: victim.hp < before,
    };
  });
  console.log('\n=== Arrow across height gap ===');
  console.log(hit);

  await page.screenshot({ path: resolve(ROOT, 'screenshot-terrain.png') });
  console.log('\nSaved screenshot-terrain.png');
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
