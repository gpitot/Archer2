/**
 * A hero pathfinds to a clicked point and arrives.
 */
import { SimHarness, expectNear, expectTrue } from '../scripts/harness/SimHarness';

export const name = 'move-pathing';

export function run(h: SimHarness): void {
  const shop = h.shopPos;
  const spawn = h.findWalkableNear(shop.x + 40, shop.z + 40);
  const target = h.findWalkableNear(shop.x + 400, shop.z - 200);
  const hero = h.spawnHero('p1', 0, spawn);

  h.issue('p1', { type: 'moveTo', x: target.x, z: target.z });
  h.tick();
  expectTrue(hero.moving, 'pathfinder produced a path to the target');

  h.runUntil(() => !hero.moving, h.seconds(6), 'hero finished moving');

  const dist = Math.hypot(hero.pos.x - target.x, hero.pos.z - target.z);
  expectNear(dist, 0, 40, 'hero arrived near the move target');
}
