/**
 * Clicking an unwalkable spot (cliff, tree, fogged terrain) is never a dead
 * click: the hero walks to the nearest reachable cell instead.
 */
import { SimHarness, expectNear, expectTrue } from '../scripts/harness/SimHarness';

export const name = 'move-click-unwalkable';

/** Nearest unwalkable cell center to (x, z) — a guaranteed "bad click" target. */
function findUnwalkableNear(h: SimHarness, x: number, z: number): { x: number; z: number } {
  const { navGrid } = h.world;
  const start = navGrid.worldToGrid(x, z);
  for (let radius = 0; radius < 64; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const gx = start.gx + dx;
        const gz = start.gz + dz;
        if (!navGrid.isInBounds(gx, gz) || navGrid.isWalkable(gx, gz)) continue;
        const { wx, wz } = navGrid.gridToWorld(gx, gz);
        return { x: wx, z: wz };
      }
    }
  }
  throw new Error('no unwalkable cell found near the shop');
}

export function run(h: SimHarness): void {
  const shop = h.shopPos;
  const spawn = h.findWalkableNear(shop.x + 40, shop.z + 40);
  const hero = h.spawnHero('p1', 0, spawn);

  const target = findUnwalkableNear(h, shop.x + 600, shop.z - 300);

  h.issue('p1', { type: 'moveTo', x: target.x, z: target.z });
  h.tick();
  expectTrue(hero.moving, 'unwalkable click still produced a path (snapped to nearest reachable)');

  h.runUntil(() => !hero.moving, h.seconds(15), 'hero finished moving');

  // The hero should end up close to the clicked point — within the snapping
  // spiral's practical range for a lone blocked cell (a few cells away).
  const dist = Math.hypot(hero.pos.x - target.x, hero.pos.z - target.z);
  expectNear(dist, 0, 5 * h.world.navGrid.cellSize, 'hero stopped near the unwalkable click');
}
