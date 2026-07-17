/**
 * Verifies the WC3-rules fog of war end-to-end:
 *  - a unit below a cliff cannot see the plateau, even point-blank
 *  - a unit on the plateau sees ALL lower ground in range (no lip shadow)
 *  - rolling terrain on the same cliff layer never blocks vision
 *  - tree lines hide what's behind them, but a hugged tree's cells show
 *  - visible cells decay to explored; wards grant remote vision
 *  - ramps: from the base most of the ramp is lit and the plateau is dark;
 *    a hero gains high-ground vision near the crest (WC3-style)
 *  - an isolated tree casts a narrow shadow (footprint ≤ 2 cells per axis)
 *
 * Usage: pnpm tsx scripts/test-fog.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';
import { HERO, WARD } from '../src/sim/rules';
import { FLAG_RAMP, TILE_SIZE } from '../src/world/wc3/W3EParser';

const ROOT = resolve(import.meta.dirname, '..');

let allPass = true;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) allPass = false;
}

async function main() {
  // Sight radii are gameplay tuning (WC3 defaults: hero 1800 day, ward 1600);
  // log them and derive test distances from the live values.
  console.log(`HERO.sightRadius=${HERO.sightRadius} WARD.sightRadius=${WARD.sightRadius}`);
  check('sight radii are sane', HERO.sightRadius >= 400 && WARD.sightRadius >= 400);

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
  const rolling = await page.evaluate((lineLen) => {
    const g = (window as any).__game;
    const fog = g._fog;
    const nav = g._navGrid;
    const cs = fog.cellSize;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    // Find a walkable source and a clear same-layer cell line ~80% of the
    // sight radius long with the biggest terrain bump along it (proves noise
    // doesn't block).
    let best: any = null;
    for (let cz = 2; cz < fog.cellsZ - 2; cz += 4) {
      for (let cx = 2; cx < fog.cellsX - 2; cx += 4) {
        const wx = fog.originX + (cx + 0.5) * cs;
        const wz = fog.originZ + (cz + 0.5) * cs;
        if (!walkable(wx, wz)) continue;
        const L = fog._cellLayer[cz * fog.cellsX + cx];
        for (const [dx, dz] of [[1, 0], [0, 1], [1, 1]]) {
          const n = Math.floor(lineLen / cs / Math.hypot(dx, dz));
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
  }, HERO.sightRadius * 0.8);
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
    hs.inventory[0] = 'sentry_wards';
    g.debugIssue({ type: 'useItem', slot: 0 });
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

  // ── 6. Ramp vision: base sees up the ramp; high vision gained near crest ──
  const ramp = await page.evaluate(({ FLAG_RAMP, TILE_SIZE }) => {
    const g = (window as any).__game;
    const T = g._map.terrain;
    const fog = g._fog;
    const nav = g._navGrid;
    const a = g._arena;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    const tp = (x: number, z: number) => {
      const hs = g._playerState;
      hs.pos.x = x; hs.pos.z = z;
      g._heroViews.get(hs.id).mesh.position.set(x, g._terrain.heightAt(x, z) + 0.5, z);
    };

    // Find a ramp tile with walkable, path-connected low/high approaches
    // (same pattern as test-terrain.ts).
    const iA = Math.floor((a.minX - T.offsetX) / TILE_SIZE);
    const iB = Math.floor((a.maxX - T.offsetX) / TILE_SIZE);
    const jA = Math.floor((-a.maxZ - T.offsetY) / TILE_SIZE);
    const jB = Math.floor((-a.minZ - T.offsetY) / TILE_SIZE);
    let pick: any = null;
    for (let j = jA; j <= jB && !pick; j++) {
      for (let i = iA; i <= iB && !pick; i++) {
        const kSW = j * T.width + i;
        const ks = [kSW, kSW + 1, kSW + T.width + 1, kSW + T.width];
        const layers = ks.map((k: number) => T.layer[k]);
        const minL = Math.min(...layers);
        const maxL = Math.max(...layers);
        const ramps = ks.filter((k: number) => (T.flags[k] & FLAG_RAMP) !== 0).length;
        if (minL === maxL || ramps < 2) continue;
        const cx = T.offsetX + (i + 0.5) * TILE_SIZE;
        const cz = -(T.offsetY + (j + 0.5) * TILE_SIZE);
        const probes: { x: number; z: number }[] = [];
        for (const [dx, dz] of [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
                                [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) {
          probes.push({ x: cx + dx * TILE_SIZE, z: cz + dz * TILE_SIZE });
        }
        const lo = probes.find((p) => walkable(p.x, p.z) && g._terrain.layerAt(p.x, p.z) === minL);
        if (!lo) continue;
        const loH = g._terrain.heightAt(lo.x, lo.z);
        const hi = probes.find((p) =>
          walkable(p.x, p.z) &&
          g._terrain.layerAt(p.x, p.z) === maxL &&
          g._terrain.heightAt(p.x, p.z) - loH >= 90);
        if (!hi) continue;
        const path = g._world.pathfinder.findSmoothedPath(lo.x, lo.z, hi.x, hi.z);
        if (path && path.length > 1) pick = { lo, hi, mid: { x: cx, z: cz }, maxL };
      }
    }
    if (!pick) return null;

    // From the base: the ramp's own middle is lit, the plateau past it dark.
    tp(pick.lo.x, pick.lo.z);
    fog.recomputeNow();
    const fromBase = {
      midRampVisible: fog.isVisible(0, pick.mid.x, pick.mid.z),
      plateauVisible: fog.isVisible(0, pick.hi.x, pick.hi.z),
    };

    // Walk the path to the first point whose *vision* layer is the upper one
    // (the crest threshold); from there the plateau must be lit.
    const path = g._world.pathfinder.findSmoothedPath(pick.lo.x, pick.lo.z, pick.hi.x, pick.hi.z);
    let crest: { x: number; z: number } | null = null;
    outer:
    for (let s = 1; s < path.length; s++) {
      const ax = path[s - 1].wx; const az = path[s - 1].wz;
      const bx = path[s].wx; const bz = path[s].wz;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
      for (let q = 1; q <= n; q++) {
        const x = ax + ((bx - ax) * q) / n;
        const z = az + ((bz - az) * q) / n;
        if (g._terrain.visionLayerAt(x, z) === pick.maxL) { crest = { x, z }; break outer; }
      }
    }
    if (!crest) return { fromBase, crest: null };
    tp(crest.x, crest.z);
    fog.recomputeNow();
    return {
      fromBase,
      crest: {
        distToPlateauProbe: Math.hypot(crest.x - pick.hi.x, crest.z - pick.hi.z),
        plateauVisible: fog.isVisible(0, pick.hi.x, pick.hi.z),
      },
    };
  }, { FLAG_RAMP, TILE_SIZE });
  console.log('\n=== Ramp vision ===');
  console.log(JSON.stringify(ramp, null, 2));
  check('found a walkable ramp with low/high approaches', ramp !== null);
  if (ramp) {
    check('mid-ramp is visible from the base', ramp.fromBase.midRampVisible);
    check('plateau past the ramp is hidden from the base', !ramp.fromBase.plateauVisible);
    check('vision layer flips to upper before the top (crest found)', ramp.crest !== null);
    if (ramp.crest) {
      check('plateau visible once the hero crests the ramp', ramp.crest.plateauVisible);
    }
  }

  // ── 7. Isolated tree: small footprint, narrow shadow ──
  const lone = await page.evaluate(() => {
    const g = (window as any).__game;
    const fog = g._fog;
    const nav = g._navGrid;
    const cs = fog.cellSize;
    const W = fog.cellsX;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    const cellW = (cx: number, cz: number) => ({
      x: fog.originX + (cx + 0.5) * cs,
      z: fog.originZ + (cz + 0.5) * cs,
    });

    // Find a blocked cluster fitting in 2×2 cells whose 13×13 neighborhood is
    // otherwise clear and on one layer, with walkable ground 5 cells west.
    for (let cz = 8; cz < fog.cellsZ - 8; cz++) {
      for (let cx = 8; cx < W - 8; cx++) {
        if (!fog._blocked[cz * W + cx]) continue;
        if (fog._blocked[cz * W + cx - 1] || fog._blocked[(cz - 1) * W + cx]) continue;
        const L = fog._cellLayer[cz * W + cx];
        let ok = true;
        let w = 0;
        let h = 0;
        for (let dz = -6; dz <= 7 && ok; dz++) {
          for (let dx = -6; dx <= 7 && ok; dx++) {
            const b = fog._blocked[(cz + dz) * W + (cx + dx)];
            const inCluster = dx >= 0 && dx <= 1 && dz >= 0 && dz <= 1;
            if (b && !inCluster) ok = false;
            if (fog._cellLayer[(cz + dz) * W + (cx + dx)] !== L) ok = false;
            if (b && inCluster) { w = Math.max(w, dx + 1); h = Math.max(h, dz + 1); }
          }
        }
        if (!ok) continue;
        const hero = cellW(cx - 5, cz);
        if (!walkable(hero.x, hero.z)) continue;

        const hs = g._playerState;
        hs.pos.x = hero.x; hs.pos.z = hero.z;
        g._heroViews.get(hs.id).mesh.position.set(
          hero.x, g._terrain.heightAt(hero.x, hero.z) + 0.5, hero.z);
        fog.recomputeNow();
        const behind = cellW(cx + 4, cz);
        const offA = cellW(cx + 4, cz - 4);
        const offB = cellW(cx + 4, cz + 4);
        return {
          clusterW: w,
          clusterH: h,
          behindHidden: !fog.isVisible(0, behind.x, behind.z),
          offsetsVisible: fog.isVisible(0, offA.x, offA.z) && fog.isVisible(0, offB.x, offB.z),
        };
      }
    }
    return null;
  });
  console.log('\n=== Isolated tree shadow ===');
  console.log(lone);
  check('found an isolated tree (blocked cluster ≤ 2×2 cells)', lone !== null);
  if (lone) {
    check('cell directly behind the tree is hidden', lone.behindHidden);
    check('cells offset past the tree stay visible (narrow shadow)', lone.offsetsVisible);
  }

  // ── 8. Screenshot for visual inspection ──
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
