/**
 * Exercises the tiny generated debug map: a hero climbs the ramp onto the
 * cliff plateau, trees block pathing, and the rock blocks arrows.
 */
import { SimHarness, expectNear, expectTrue } from '../scripts/harness/SimHarness';
import { TEST_MAP_SPAWNS } from '../src/world/testMap';

export const name = 'test-map';
export const map = 'test';

export function run(h: SimHarness): void {
  const spawn = h.findWalkableNear(TEST_MAP_SPAWNS[0].x, TEST_MAP_SPAWNS[0].z);
  const hero = h.spawnHero('p1', 0, spawn);

  // ── Ramp: the plateau top is only reachable through it ──
  const plateau = h.findWalkableNear(600, -600);
  expectTrue(
    h.world.pathfinder.isReachable(spawn.x, spawn.z, plateau.x, plateau.z),
    'plateau reachable from low ground (via the ramp)',
  );
  h.issue('p1', { type: 'moveTo', x: plateau.x, z: plateau.z });
  h.tick();
  expectTrue(hero.moving, 'pathfinder produced a path to the plateau');
  h.runUntil(() => !hero.moving, h.seconds(12), 'hero finished the climb');
  const dist = Math.hypot(hero.pos.x - plateau.x, hero.pos.z - plateau.z);
  expectNear(dist, 0, 40, 'hero arrived on the plateau');

  // ── Trees: the cluster around (-500, -180) blocks cells ──
  const treeCell = h.world.navGrid.worldToGrid(-500, -100);
  expectTrue(!h.world.navGrid.isWalkable(treeCell.gx, treeCell.gz), 'tree cell is blocked');

  // ── Rock: blocks arrows (line of sight through it fails) ──
  expectTrue(
    !h.hasLineOfSight({ x: -200, z: -560 }, { x: -200, z: -280 }),
    'rock blocks the arrow line through it',
  );
  expectTrue(
    h.hasLineOfSight({ x: 0, z: -560 }, { x: 0, z: -280 }),
    'parallel line beside the rock is clear',
  );
}
