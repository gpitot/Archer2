/**
 * Verifies the discrete WC3 terrain-level model:
 *  - steppedHeightAt === bilinear off cliff tiles (uniform + ramp)
 *  - cliff tiles sample as plateau/floor with a real step between them
 *  - layerAt returns the discrete cliff layer either side of a wall
 *  - every cliff tile is unwalkable in the WPM (heroes can never Y-pop)
 *  - in-game: hero walks up a ramp without vertical jumps; an arrow fired
 *    across a cliff edge still hits (2D sim collision)
 *
 * Usage: pnpm tsx scripts/test-terrain.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { parseW3E, FLAG_RAMP, TILE_SIZE } from '../src/world/wc3/W3EParser';
import { parseWpm, isCellWalkable } from '../src/world/wc3/WpmParser';
import {
  tileIsCliff,
  cliffTileGeometry,
  steppedHeightAt,
  bilinearHeightAt,
  layerAt,
} from '../src/world/wc3/terrainLevels';

const ROOT = resolve(import.meta.dirname, '..');

// Arena Terrain 1 in world coords (see MapData.ARENA_TERRAIN1, WC3 y → -z).
const ARENA = { minX: -2784, maxX: 4416, minWc3Y: -6720, maxWc3Y: 512 };

let allPass = true;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) allPass = false;
}

function loadBuf(p: string): ArrayBuffer {
  const b = readFileSync(resolve(ROOT, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

async function main() {
  const t = parseW3E(loadBuf('assets/war3map.w3e'));
  const wpm = parseWpm(loadBuf('assets/war3map.wpm'));

  const i0 = Math.floor((ARENA.minX - t.offsetX) / TILE_SIZE);
  const i1 = Math.ceil((ARENA.maxX - t.offsetX) / TILE_SIZE);
  const j0 = Math.floor((ARENA.minWc3Y - t.offsetY) / TILE_SIZE);
  const j1 = Math.ceil((ARENA.maxWc3Y - t.offsetY) / TILE_SIZE);

  // ── 1. Off cliff tiles the stepped sampler is exactly the old bilinear ──
  let checked = 0;
  let mismatches = 0;
  for (let n = 0; n < 20000; n++) {
    const wx = ARENA.minX + Math.random() * (ARENA.maxX - ARENA.minX);
    const wz = -(ARENA.minWc3Y + Math.random() * (ARENA.maxWc3Y - ARENA.minWc3Y));
    const u = Math.floor(Math.min(Math.max((wx - t.offsetX) / TILE_SIZE, 0), t.width - 1.001));
    const v = Math.floor(Math.min(Math.max((-wz - t.offsetY) / TILE_SIZE, 0), t.height - 1.001));
    if (tileIsCliff(t, u, v)) continue;
    checked++;
    if (Math.abs(steppedHeightAt(t, wx, wz) - bilinearHeightAt(t, wx, wz)) > 1e-6) mismatches++;
  }
  console.log(`sampled ${checked} non-cliff points`);
  check('stepped === bilinear on uniform/ramp tiles', checked > 5000 && mismatches === 0);

  // ── 2. Cliff tiles step; layers differ across the wall ──
  let cliffTiles = 0;
  let stepped = 0;
  let layerPairs = 0;
  let layerOK = 0;
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      if (!tileIsCliff(t, i, j)) continue;
      cliffTiles++;
      const g = cliffTileGeometry(t, i, j);
      if (g.diagonal || g.polyHigh.length < 3 || g.polyLow.length < 3) continue;
      const cen = (poly: { x: number; z: number }[]): [number, number] => [
        poly.reduce((s, p) => s + p.x, 0) / poly.length,
        poly.reduce((s, p) => s + p.z, 0) / poly.length,
      ];
      const [hx, hz] = cen(g.polyHigh);
      const [lx, lz] = cen(g.polyLow);
      if (steppedHeightAt(t, hx, hz) - steppedHeightAt(t, lx, lz) >= 60) stepped++;
      // layerAt at the actual corner tilepoints must read back their layers
      // (crossing points sit on edge midpoints and may round to either side).
      const kSW = j * t.width + i;
      const ks = [kSW, kSW + 1, kSW + t.width + 1, kSW + t.width];
      const minL = Math.min(...ks.map((k) => t.layer[k]));
      const hiK = ks.find((k) => t.layer[k] > minL)!;
      const loK = ks.find((k) => t.layer[k] === minL)!;
      const posOf = (k: number) => ({
        x: t.offsetX + (k % t.width) * TILE_SIZE,
        z: -(t.offsetY + Math.floor(k / t.width) * TILE_SIZE),
      });
      const hp = posOf(hiK);
      const lp = posOf(loK);
      layerPairs++;
      if (layerAt(t, hp.x, hp.z) === t.layer[hiK] && layerAt(t, lp.x, lp.z) === t.layer[loK]) layerOK++;
    }
  }
  console.log(`cliff tiles in arena: ${cliffTiles}, plateau-floor step >=60u: ${stepped}/${layerPairs}`);
  check('cliff tiles found in arena', cliffTiles > 100);
  check('>=95% of single-contour cliff tiles step >=60u between centroids', stepped >= layerPairs * 0.95);
  check('layerAt reads back corner tilepoint layers', layerOK === layerPairs);

  // ── 3. All pathing cells on cliff tiles are unwalkable (no hero Y pops) ──
  let walkableCliffCells = 0;
  let totalCliffCells = 0;
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      if (!tileIsCliff(t, i, j)) continue;
      for (let pz = 0; pz < 4; pz++) {
        for (let px = 0; px < 4; px++) {
          totalCliffCells++;
          if (isCellWalkable(wpm, i * 4 + px, j * 4 + pz)) walkableCliffCells++;
        }
      }
    }
  }
  console.log(`walkable pathing cells on cliff tiles: ${walkableCliffCells}/${totalCliffCells}`);
  check('cliff tiles are fully unwalkable', walkableCliffCells === 0);

  // ── 4. In-game: ramp walk continuity + arrow across a cliff edge ──
  const server = await createServer({ root: ROOT, server: { port: 4175 } });
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

  // Find a ramp with pathable ground at both ends, walk it, record view Y.
  const ramp = await page.evaluate(async ({ FLAG_RAMP, TILE_SIZE }) => {
    const g = (window as any).__game;
    const T = g._map.terrain;
    const nav = g._navGrid;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    const a = g._arena;

    // Scan arena tiles for a ramp tile (mixed layers, >=2 FLAG_RAMP corners)
    // whose low/high approaches are walkable and connected.
    const iA = Math.floor((a.minX - T.offsetX) / TILE_SIZE);
    const iB = Math.floor((a.maxX - T.offsetX) / TILE_SIZE);
    const jA = Math.floor((-a.maxZ - T.offsetY) / TILE_SIZE);
    const jB = Math.floor((-a.minZ - T.offsetY) / TILE_SIZE);
    let pick: { lo: { x: number; z: number }; hi: { x: number; z: number } } | null = null;
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
        // Probe outward for a walkable low & high approach. Layer alone isn't
        // enough for the high side — ramp tilepoints carry the upper layer
        // while their ground height is lowered to form the slope — so also
        // require the high probe to sit ~a full layer above the low one.
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
        if (path && path.length > 1) pick = { lo, hi };
      }
    }
    if (!pick) return null;

    // Y-continuity along the actual path geometry (the sim can outpace any
    // real-time sampling, so walk the polyline instead): sample heightAt
    // every 8u of arc length — a cliff pop would show as a >=100u step.
    const path = g._world.pathfinder.findSmoothedPath(pick.lo.x, pick.lo.z, pick.hi.x, pick.hi.z);
    let maxStep = 0;
    let sampleCount = 0;
    let prevH = g._terrain.heightAt(path[0].wx, path[0].wz);
    for (let s = 1; s < path.length; s++) {
      const ax = path[s - 1].wx; const az = path[s - 1].wz;
      const bx = path[s].wx; const bz = path[s].wz;
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / 8));
      for (let q = 1; q <= n; q++) {
        const h = g._terrain.heightAt(ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n);
        maxStep = Math.max(maxStep, Math.abs(h - prevH));
        prevH = h;
        sampleCount++;
      }
    }

    // And actually walk it: teleport to the base, order the move, wait for arrival.
    const hero = g._playerState;
    const view = g._heroViews.get(hero.id);
    hero.pos.x = pick.lo.x;
    hero.pos.z = pick.lo.z;
    view.mesh.position.set(pick.lo.x, g._terrain.heightAt(pick.lo.x, pick.lo.z) + 0.5, pick.lo.z);
    const loH = g._terrain.heightAt(pick.lo.x, pick.lo.z);
    g.debugIssue({ type: 'moveTo', x: pick.hi.x, z: pick.hi.z });
    for (let n = 0; n < 100; n++) {
      await new Promise((r) => setTimeout(r, 50));
      if (Math.hypot(hero.pos.x - pick.hi.x, hero.pos.z - pick.hi.z) < 30) break;
    }
    await new Promise((r) => setTimeout(r, 100)); // one more frame for the view
    return {
      startLayer: g._terrain.layerAt(pick.lo.x, pick.lo.z),
      endLayer: g._terrain.layerAt(hero.pos.x, hero.pos.z),
      wantLayer: g._terrain.layerAt(pick.hi.x, pick.hi.z),
      rise: view.mesh.position.y - (loH + 0.5),
      maxStep,
      sampleCount,
    };
  }, { FLAG_RAMP, TILE_SIZE });
  console.log('\n=== Ramp walk ===');
  console.log(ramp);
  check('found a walkable ramp', ramp !== null);
  if (ramp) {
    check('hero reached the upper layer via the ramp', ramp.endLayer === ramp.wantLayer);
    check('hero climbed (Y rose >= 60u)', ramp.rise >= 60);
    check('path height is continuous (max step per 8u of path < 40u)', ramp.sampleCount > 10 && ramp.maxStep < 40);
  }

  // Arrow across a cliff edge: shooter on the plateau, victim below.
  const arrow = await page.evaluate(async () => {
    const g = (window as any).__game;
    const nav = g._navGrid;
    const walkable = (x: number, z: number) => {
      const c = nav.worldToGrid(x, z);
      return nav.isWalkable(c.gx, c.gz);
    };
    const a = g._arena;
    // Find a walkable high point with a walkable lower point ~400u away.
    let pair: { hi: { x: number; z: number }; lo: { x: number; z: number } } | null = null;
    for (let z = a.minZ + 200; z < a.maxZ - 200 && !pair; z += 80) {
      for (let x = a.minX + 200; x < a.maxX - 200 && !pair; x += 80) {
        if (!walkable(x, z)) continue;
        const L = g._terrain.layerAt(x, z);
        for (const [dx, dz] of [[400, 0], [-400, 0], [0, 400], [0, -400]]) {
          const nx = x + dx;
          const nz = z + dz;
          if (walkable(nx, nz) && g._terrain.layerAt(nx, nz) === L - 1) {
            pair = { hi: { x, z }, lo: { x: nx, z: nz } };
            break;
          }
        }
      }
    }
    if (!pair) return null;

    const shooter = g._playerState;
    const victim = g._state.heroes.find((h: any) => h.id !== shooter.id);
    shooter.pos.x = pair.hi.x; shooter.pos.z = pair.hi.z;
    victim.pos.x = pair.lo.x; victim.pos.z = pair.lo.z;
    g._heroViews.get(shooter.id).mesh.position.set(pair.hi.x, g._terrain.heightAt(pair.hi.x, pair.hi.z) + 0.5, pair.hi.z);
    g._heroViews.get(victim.id).mesh.position.set(pair.lo.x, g._terrain.heightAt(pair.lo.x, pair.lo.z) + 0.5, pair.lo.z);

    shooter.skillPoints = Math.max(shooter.skillPoints, 1);
    g.debugIssue({ type: 'levelAbility' });
    await new Promise((r) => setTimeout(r, 150));
    const before = victim.hp;
    g.debugIssue({ type: 'cast', ability: 'arrow', x: pair.lo.x, z: pair.lo.z });
    await new Promise((r) => setTimeout(r, 1000));
    return {
      heightGap: (g._terrain.heightAt(pair.hi.x, pair.hi.z) - g._terrain.heightAt(pair.lo.x, pair.lo.z)).toFixed(1),
      hpBefore: before,
      hpAfter: victim.hp,
      damaged: victim.hp < before,
    };
  });
  console.log('\n=== Arrow across cliff edge ===');
  console.log(arrow);
  check('found a cliff-adjacent hi/lo pair', arrow !== null);
  if (arrow) check('arrow across the height gap still hits (2D collision)', arrow.damaged);

  await page.screenshot({ path: resolve(ROOT, 'screenshot-terrain.png') });
  console.log('\nSaved screenshot-terrain.png');
  await browser.close();
  await server.close();

  if (!allPass) {
    console.error('\nSome terrain checks FAILED');
    process.exit(1);
  }
  console.log('\nAll terrain checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
