/**
 * Trees are pathing obstacles: their footprint cells are unwalkable and
 * heroes route around them, but arrows fly through (trees are not in the
 * projectile obstacle list).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { parseDoo } from '../src/world/wc3/DooParser';
import { treeFootprints, TreeFootprint } from '../src/sim/treeFootprints';

export const name = 'tree-blocking';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadArenaTrees(h: SimHarness): TreeFootprint[] {
  const dooPath = path.resolve(__dirname, '..', 'assets', 'war3map.doo');
  const buf = fs.readFileSync(dooPath);
  const doodads = parseDoo(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const a = h.world.arena;
  return treeFootprints(doodads).filter(
    (t) => t.x > a.minX + 100 && t.x < a.maxX - 100 && t.z > a.minZ + 100 && t.z < a.maxZ - 100,
  );
}

export function run(h: SimHarness): void {
  const { navGrid, pathfinder } = h.world;
  const trees = loadArenaTrees(h);
  expectTrue(trees.length > 0, 'arena contains trees');

  // Every arena tree's center cell is unwalkable.
  let blocked = 0;
  for (const t of trees) {
    const { gx, gz } = navGrid.worldToGrid(t.x, t.z);
    if (!navGrid.isWalkable(gx, gz)) blocked++;
  }
  expectTrue(blocked === trees.length,
    `all ${trees.length} arena tree centers are unwalkable (got ${blocked})`);

  // A path across a tree detours: find a tree with clear reachable ground on
  // two opposite sides, and check the straight line through it is blocked
  // while a (longer) path still exists.
  const shop = h.shopPos;
  for (const t of trees) {
    const west = h.findWalkableNear(t.x - 160, t.z);
    const east = h.findWalkableNear(t.x + 160, t.z);
    if (!pathfinder.isReachable(west.x, west.z, shop.x, shop.z)) continue;
    if (!pathfinder.isReachable(east.x, east.z, shop.x, shop.z)) continue;
    if (navGrid.hasLineOfSight(west.x, west.z, east.x, east.z)) continue;

    const p = pathfinder.findSmoothedPath(west.x, west.z, east.x, east.z);
    expectTrue(p !== null && p.length > 2,
      'path around a tree exists and needs intermediate waypoints');
    return;
  }
  throw new Error('no tree with reachable ground on both sides found to test detouring');
}
