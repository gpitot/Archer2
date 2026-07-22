/**
 * Balance audit for any custom map: proves every start is equivalent rather
 * than asserting it.
 *
 * For each spawn it measures the route the game's own pathfinder returns (so
 * cliffs, outcrops, trees and rocks all count) to every point of interest. On
 * a symmetric map each player's sorted distance list must match every other
 * player's; the spread between them is the map's real balance error.
 *
 * Usage:  pnpm tsx scripts/check-map-balance.ts [mapName]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseMapJson } from '../src/world/custom/mapSource';
import { buildCustomMap, buildCustomSimWorld } from '../src/world/custom/buildCustomMap';
import { CREEP_TYPES, MELEE_LADDER, RANGED_LADDER } from '../src/sim/creepRules';
import type { CreepTypeId } from '../src/sim/creepRules';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAME = process.argv[2] ?? 'pentad';

const src = parseMapJson(
  fs.readFileSync(path.resolve(__dirname, '..', 'maps', `${NAME}.map.json`), 'utf8'),
);
const map = buildCustomMap(src);
const world = buildCustomSimWorld(src);
const grid = world.navGrid;

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg: string) => console.log(`  ok    ${msg}`);

// ── Route length via the game's own pathfinder ────────────────────────
//
// Deliberately not a raw grid BFS: 8-connected octile distance overestimates
// by up to 8% depending on heading, and the five spawns sit at five different
// angles to the lattice, so a BFS would attribute its own metric anisotropy to
// the map. `findSmoothedPath` is what units actually walk, and string pulling
// removes that bias.

/** Length of the smoothed route a unit would actually walk, or Infinity. */
function walkDist(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const path = world.pathfinder.findSmoothedPath(from.x, from.z, to.x, to.z);
  if (!path) return Infinity;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i].wx - path[i - 1].wx, path[i].wz - path[i - 1].wz);
  }
  return total;
}

const spawns = map.spawns;
console.log(`\n${NAME}: ${src.tilesX}×${src.tilesZ} tiles, ${spawns.length} spawns\n`);

// ── 1. Reachability ───────────────────────────────────────────────────

console.log('reachability');

const pois: { label: string; pts: { x: number; z: number }[] }[] = [
  { label: 'shops', pts: map.shops },
  { label: 'runes', pts: map.runes },
  { label: 'fountains', pts: map.fountains.map((f) => f.pos) },
  { label: 'camps', pts: map.camps },
  { label: 'spawns', pts: spawns },
];
for (const { label, pts } of pois) {
  let worst = 0;
  for (const s of spawns) for (const p of pts) worst = Math.max(worst, walkDist(s, p));
  if (!Number.isFinite(worst)) fail(`${label}: some are unreachable from some spawn`);
  else pass(`${label}: all reachable from all spawns (max walk ${Math.round(worst)})`);
}

// ── 2. Symmetry: identical distance profiles ──────────────────────────

// For a radial map, an N-fold rotation cannot map a square lattice onto
// itself (unless N is 2 or 4), so tilepoint classification and 32u nav cells
// round slightly differently per sector. That residual is irreducible; what
// matters is that it stays far below the threshold at which a player could
// notice or exploit it. Budget: 0.25s of running (350 u/s) on any one trip.
console.log('\nsymmetry (walking distance profile per player)');
const HERO_SPEED = 350;
const BUDGET_SECONDS = 0.25;

/** Sorted walking distances from one spawn to a set of points. */
const profile = (s: { x: number; z: number }, pts: { x: number; z: number }[]) =>
  pts.map((p) => Math.round(walkDist(s, p))).sort((a, b) => a - b);

for (const { label, pts } of pois) {
  const profiles = spawns.map((s) => profile(s, pts));
  let worst = 0;
  let worstPct = 0;
  profiles[0].forEach((_, i) => {
    const col = profiles.map((p) => p[i]);
    const lo = Math.min(...col);
    const spread = Math.max(...col) - lo;
    worst = Math.max(worst, spread);
    if (lo > 0) worstPct = Math.max(worstPct, (spread / lo) * 100);
  });
  const secs = worst / HERO_SPEED;
  const detail = `≤${Math.round(worst)}u / ${secs.toFixed(2)}s / ${worstPct.toFixed(1)}% — [${profiles[0].join(', ')}]`;
  if (secs > BUDGET_SECONDS) fail(`${label}: spread ${detail}`);
  else pass(`${label}: ${detail}`);
}

// ── 3. No camp aggroes a spawning player ──────────────────────────────

// Camps climb their ladders on respawn (`campComposition`), so the authored
// tier-0 units understate the aggro this camp will project an hour in. Check
// against the worst aggro any unit on the camp's ladders can reach.
console.log('\nsafety');
const ladderMaxAggro = (units: readonly CreepTypeId[]): number => {
  let worst = 0;
  for (const u of units) {
    const ladder = RANGED_LADDER.includes(u) ? RANGED_LADDER : MELEE_LADDER;
    for (const rung of ladder) worst = Math.max(worst, CREEP_TYPES[rung].aggroRange);
  }
  return worst;
};

let worstAggro = Infinity;
for (const c of map.camps) {
  const aggro = ladderMaxAggro(c.units);
  for (const s of spawns) {
    const gap = Math.hypot(c.x - s.x, c.z - s.z) - aggro;
    worstAggro = Math.min(worstAggro, gap);
    if (gap < 0) fail(`camp ${c.id} (ladder aggro ${aggro}) reaches spawn at ${s.x},${s.z}`);
  }
}
if (worstAggro >= 0) pass(`no camp aggroes a spawn (tightest margin ${Math.round(worstAggro)}u)`);

// ── 4. Placements sit on walkable ground ──────────────────────────────

const onFoot = (p: { x: number; z: number }) => {
  const g = grid.worldToGrid(p.x, p.z);
  return grid.isWalkable(g.gx, g.gz);
};
for (const { label, pts } of pois) {
  const bad = pts.filter((p) => !onFoot(p));
  if (bad.length) fail(`${label}: ${bad.length} placed on blocked ground`);
  else pass(`${label}: all on walkable ground`);
}

console.log(failures === 0 ? '\nPASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
