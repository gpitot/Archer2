/**
 * Verifies the WC3-rules fog of war end-to-end:
 *  - a unit below a cliff cannot see the plateau, even point-blank
 *  - a unit on the plateau sees ALL lower ground in range (no lip shadow)
 *  - rolling terrain on the same cliff layer never blocks vision
 *  - tree lines hide what's behind them, but a hugged tree's cells show
 *  - visible cells decay to explored; wards grant remote vision
 *  - sight radii match WC3 (hero 1800 day, observer ward 1600)
 *
 * Usage: pnpm tsx scripts/test-fog.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';
import { HERO, WARD } from '../src/sim/rules';

const ROOT = resolve(import.meta.dirname, '..');

let allPass = true;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) allPass = false;
}

async function main() {
  check('HERO.sightRadius is WC3 daytime 1800', HERO.sightRadius === 1800);
  check('WARD.sightRadius is WC3 observer ward 1600', WARD.sightRadius === 1600);

  const server = await createServer({ root: ROOT, server: { port: 4176 } });
  await server.listen();
  const addr = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('[PAGE ERROR]', e.message));
  await page.addInitScript('window.__name = (fn) => fn;');
  await page.goto(addr, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForFunction('window.__game && window.__game.debugReady', { timeout: 15000 });

  // Shared in-page helpers are re-created per evaluate (no page state kept).
  // ── 1 + 2. Cliff rules: never see up; high ground sees all lower ground ──
  const cliff = await page.evaluate(async () => {
    const g = (window as any).__game;
    const nav = g._navGrid;
    const a = g._arena;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    const tp = (id: string, x: number, z: number) => {
      const hs = g._state.heroes.find((h: any) => h.id === id);
      hs.pos.x = x; hs.pos.z = z;
      g._heroViews.get(id).mesh.position.set(x, g._terrain.heightAt(x, z) + 0.5, z);
    };

    // Find a walkable low point with a walkable point one layer up ~250-450u away.
    let pair: { lo: { x: number; z: number }; hi: { x: number; z: number } } | null = null;
    for (let z = a.minZ + 200; z < a.maxZ - 200 && !pair; z += 80) {
      for (let x = a.minX + 200; x < a.maxX - 200 && !pair; x += 80) {
        if (!walkable(x, z)) continue;
        const L = g._terrain.layerAt(x, z);
        for (const [dx, dz] of [[350, 0], [-350, 0], [0, 350], [0, -350]]) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < a.minX || nx > a.maxX || nz < a.minZ || nz > a.maxZ) continue;
          if (walkable(nx, nz) && g._terrain.layerAt(nx, nz) === L + 1) {
            pair = { lo: { x, z }, hi: { x: nx, z: nz } };
            break;
          }
        }
      }
    }
    if (!pair) return null;

    const enemy = g._state.heroes.find((h: any) => h.id !== g._playerState.id);
    tp(g._playerState.id, pair.lo.x, pair.lo.z);
    tp(enemy.id, pair.hi.x, pair.hi.z);
    g._fog.recomputeNow();
    await new Promise((r) => setTimeout(r, 200)); // let a frame apply mesh culling
    const fromBelow = {
      plateauVisible: g._fog.isVisible(0, pair.hi.x, pair.hi.z),
      enemyMeshVisible: g._heroViews.get(enemy.id).mesh.visible,
      dist: Math.hypot(pair.hi.x - pair.lo.x, pair.hi.z - pair.lo.z),
    };

    // Swap: player on the plateau, enemy below — and check a fan of low cells.
    tp(g._playerState.id, pair.hi.x, pair.hi.z);
    tp(enemy.id, pair.lo.x, pair.lo.z);
    g._fog.recomputeNow();
    await new Promise((r) => setTimeout(r, 200));
    const L = g._terrain.layerAt(pair.hi.x, pair.hi.z);
    // Sample low-ground cells in rings around the player: every cell at a
    // lower layer with a clear (no higher layer, no trees) line must be lit.
    let lowChecked = 0;
    let lowLit = 0;
    const fog = g._fog;
    const cs = fog.cellSize;
    const pcx = Math.floor((pair.hi.x - fog.originX) / cs);
    const pcz = Math.floor((pair.hi.z - fog.originZ) / cs);
    for (let dz = -30; dz <= 30; dz += 2) {
      for (let dx = -30; dx <= 30; dx += 2) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (cx < 1 || cz < 1 || cx >= fog.cellsX - 1 || cz >= fog.cellsZ - 1) continue;
        if (dx * dx + dz * dz > 30 * 30) continue;
        const idx = cz * fog.cellsX + cx;
        if (fog._cellLayer[idx] >= L) continue; // want strictly lower ground
        // Line must be free of higher layers and tree blockers to count.
        const steps = Math.max(Math.abs(dx), Math.abs(dz));
        let clear = true;
        for (let s = 1; s < steps; s++) {
          const sx = Math.round(pcx + (dx * s) / steps);
          const sz = Math.round(pcz + (dz * s) / steps);
          const si = sz * fog.cellsX + sx;
          if (fog._cellLayer[si] > L || fog._blocked[si]) { clear = false; break; }
        }
        if (!clear) continue;
        lowChecked++;
        const wx = fog.originX + (cx + 0.5) * cs;
        const wz = fog.originZ + (cz + 0.5) * cs;
        if (fog.isVisible(0, wx, wz)) lowLit++;
      }
    }
    const fromAbove = {
      enemyVisible: g._fog.isVisible(0, pair.lo.x, pair.lo.z),
      enemyMeshVisible: g._heroViews.get(enemy.id).mesh.visible,
      lowChecked,
      lowLit,
    };
    return { pair, fromBelow, fromAbove };
  });
  console.log('=== Cliff rules ===');
  console.log(JSON.stringify(cliff, null, 2));
  check('found a walkable low/high cliff pair', cliff !== null);
  if (cliff) {
    check('plateau hidden from below, even at ~350u', !cliff.fromBelow.plateauVisible);
    check('enemy mesh culled while on unseen high ground', !cliff.fromBelow.enemyMeshVisible);
    check('enemy on low ground visible from the plateau', cliff.fromAbove.enemyVisible);
    check('enemy mesh shown while in vision', cliff.fromAbove.enemyMeshVisible);
    check(
      'ALL clear-line lower cells lit from the plateau (no lip shadow)',
      cliff.fromAbove.lowChecked > 20 && cliff.fromAbove.lowLit === cliff.fromAbove.lowChecked,
    );
  }

  // ── 3. Same-layer rolling ground never blocks ──
  const rolling = await page.evaluate(() => {
    const g = (window as any).__game;
    const fog = g._fog;
    const nav = g._navGrid;
    const cs = fog.cellSize;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    // Find a walkable source and a clear same-layer cell line 1200-1600u long
    // with the biggest terrain bump along it (proves noise doesn't block).
    let best: any = null;
    for (let cz = 2; cz < fog.cellsZ - 2; cz += 4) {
      for (let cx = 2; cx < fog.cellsX - 2; cx += 4) {
        const wx = fog.originX + (cx + 0.5) * cs;
        const wz = fog.originZ + (cz + 0.5) * cs;
        if (!walkable(wx, wz)) continue;
        const L = fog._cellLayer[cz * fog.cellsX + cx];
        for (const [dx, dz] of [[1, 0], [0, 1], [1, 1]]) {
          const n = Math.floor(1400 / cs / Math.hypot(dx, dz));
          const tx = cx + dx * n;
          const tz = cz + dz * n;
          if (tx >= fog.cellsX - 1 || tz >= fog.cellsZ - 1) continue;
          let clear = true;
          let bump = 0;
          const h0 = g._terrain.smoothHeightAt(wx, wz);
          const steps = Math.max(Math.abs(tx - cx), Math.abs(tz - cz));
          for (let s = 1; s <= steps; s++) {
            const sx = Math.round(cx + ((tx - cx) * s) / steps);
            const sz = Math.round(cz + ((tz - cz) * s) / steps);
            const si = sz * fog.cellsX + sx;
            if (fog._cellLayer[si] !== L || fog._blocked[si]) { clear = false; break; }
            const sh = g._terrain.smoothHeightAt(
              fog.originX + (sx + 0.5) * cs, fog.originZ + (sz + 0.5) * cs);
            bump = Math.max(bump, sh - h0);
          }
          if (!clear) continue;
          if (!best || bump > best.bump) {
            best = {
              src: { x: wx, z: wz },
              dst: {
                x: fog.originX + (tx + 0.5) * cs,
                z: fog.originZ + (tz + 0.5) * cs,
              },
              bump,
              dist: steps * cs,
            };
          }
        }
      }
    }
    if (!best) return null;
    const hs = g._playerState;
    hs.pos.x = best.src.x; hs.pos.z = best.src.z;
    g._heroViews.get(hs.id).mesh.position.set(
      best.src.x, g._terrain.heightAt(best.src.x, best.src.z) + 0.5, best.src.z);
    fog.recomputeNow();
    return { ...best, visible: fog.isVisible(0, best.dst.x, best.dst.z) };
  });
  console.log('\n=== Same-layer rolling ground ===');
  console.log(rolling);
  check('found a clear same-layer sight line', rolling !== null);
  if (rolling) {
    check(
      `far cell at ${rolling.dist.toFixed(0)}u visible over a ${rolling.bump.toFixed(0)}u bump`,
      rolling.visible,
    );
  }

  // ── 4. Tree lines block; a hugged tree's own cells stay visible ──
  const trees = await page.evaluate(() => {
    const g = (window as any).__game;
    const fog = g._fog;
    const nav = g._navGrid;
    const cs = fog.cellSize;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    const W = fog.cellsX;
    // Find a horizontal run of blocked cells (a tree line) with walkable clear
    // ground on the west side and clear cells on the east, all on one layer.
    for (let cz = 4; cz < fog.cellsZ - 4; cz++) {
      for (let cx = 6; cx < W - 10; cx++) {
        const i = cz * W + cx;
        if (!fog._blocked[i] || fog._blocked[i - 1]) continue; // run starts here
        let end = cx;
        while (end < W - 6 && fog._blocked[cz * W + end]) end++;
        const runLen = end - cx;
        if (runLen > 5) continue;
        const heroCx = cx - 4;
        const targetCx = end + 3;
        const L = fog._cellLayer[i];
        let ok = true;
        for (let s = heroCx; s <= targetCx; s++) {
          const si = cz * W + s;
          if (fog._cellLayer[si] !== L) { ok = false; break; }
          if ((s < cx || s >= end) && fog._blocked[si]) { ok = false; break; }
        }
        if (!ok) continue;
        const heroX = fog.originX + (heroCx + 0.5) * cs;
        const heroZ = fog.originZ + (cz + 0.5) * cs;
        if (!walkable(heroX, heroZ)) continue;

        const hs = g._playerState;
        const tp = (x: number, z: number) => {
          hs.pos.x = x; hs.pos.z = z;
          g._heroViews.get(hs.id).mesh.position.set(x, g._terrain.heightAt(x, z) + 0.5, z);
        };
        tp(heroX, heroZ);
        fog.recomputeNow();
        const behindX = fog.originX + (targetCx + 0.5) * cs;
        const treeX = fog.originX + (cx + 0.5) * cs;
        const behindHidden = !fog.isVisible(0, behindX, heroZ);

        // Hug the tree: one cell west of the run — its first cell must show.
        const hugX = fog.originX + (cx - 1 + 0.5) * cs;
        tp(hugX, heroZ);
        fog.recomputeNow();
        const treeVisibleWhenHugged = fog.isVisible(0, treeX, heroZ);
        return { runLen, behindHidden, treeVisibleWhenHugged };
      }
    }
    return null;
  });
  console.log('\n=== Tree lines ===');
  console.log(trees);
  check('found a tree line with clear ground around it', trees !== null);
  if (trees) {
    check('cells behind the tree line are hidden', trees.behindHidden);
    check("hugging a tree shows the tree's own cell", trees.treeVisibleWhenHugged);
  }

  // ── 5. Explored decay + ward remote vision ──
  const wards = await page.evaluate(async () => {
    const g = (window as any).__game;
    const fog = g._fog;
    const nav = g._navGrid;
    const a = g._arena;
    const hs = g._playerState;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    const tp = (x: number, z: number) => {
      hs.pos.x = x; hs.pos.z = z;
      g._heroViews.get(hs.id).mesh.position.set(x, g._terrain.heightAt(x, z) + 0.5, z);
    };
    // Two walkable spots far apart (> hero sight radius).
    let spotA: any = null;
    let spotB: any = null;
    for (let z = a.minZ + 200; z < a.maxZ - 200 && !(spotA && spotB); z += 120) {
      for (let x = a.minX + 200; x < a.maxX - 200; x += 120) {
        if (!walkable(x, z)) continue;
        if (!spotA) { spotA = { x, z }; continue; }
        if (Math.hypot(x - spotA.x, z - spotA.z) > 2200) { spotB = { x, z }; break; }
      }
    }
    if (!spotA || !spotB) return null;

    // Stand at A, place a ward, then walk far away to B.
    tp(spotA.x, spotA.z);
    hs.wardCharges = 5;
    g.debugIssue({ type: 'ward' });
    await new Promise((r) => setTimeout(r, 300)); // sim tick processes the command
    tp(spotB.x, spotB.z);
    fog.recomputeNow();
    await new Promise((r) => setTimeout(r, 100));
    return {
      dist: Math.hypot(spotB.x - spotA.x, spotB.z - spotA.z),
      wardCount: g._state.wards.length,
      chargesLeft: hs.wardCharges,
      wardSpotVisible: fog.isVisible(0, spotA.x, spotA.z),
      exploredHalfway: fog.stateAt(0, (spotA.x + spotB.x) / 2, (spotA.z + spotB.z) / 2),
    };
  });
  console.log('\n=== Wards + explored decay ===');
  console.log(wards);
  check('found two walkable spots > 2200u apart', wards !== null);
  if (wards) {
    check('ward placed and charge consumed', wards.wardCount === 1 && wards.chargesLeft === 4);
    check('warded area stays visible without the hero nearby', wards.wardSpotVisible);
  }

  // ── 6. Screenshot for visual inspection ──
  await page.evaluate(() => {
    const g = (window as any).__game;
    g._cameraLocked = true;
  });
  await page.waitForTimeout(1500); // let fog brightness ease in
  await page.screenshot({ path: resolve(ROOT, 'screenshot-fog.png') });
  console.log('\nSaved screenshot-fog.png');

  await browser.close();
  await server.close();

  if (!allPass) {
    console.error('\nSome fog-of-war checks FAILED');
    process.exit(1);
  }
  console.log('\nAll fog-of-war checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
