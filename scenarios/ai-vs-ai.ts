/**
 * Two AI controllers play a full match against each other in a populated world
 * (fountains, creep camps). This is a sanity harness for the whole system: it
 * must run for 150s with no crash, produce real bidirectional combat (each
 * hero scores kills on the other), and never collapse into a stalemate (both
 * keep moving the whole time).
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { FOUNTAIN } from '../src/sim/rules';
import * as V from '../src/sim/math';

export const name = 'ai-vs-ai';

export function run(h: SimHarness): void {
  const { a: p1, b: p2 } = h.spawnDuelists(700);
  const shop = h.shopPos;
  h.world.fountains.push(
    { pos: h.findWalkableNear(shop.x + 700, shop.z + 700), healRadius: FOUNTAIN.healRadius, healPerSecond: FOUNTAIN.healPerSecond },
    { pos: h.findWalkableNear(shop.x - 700, shop.z - 700), healRadius: FOUNTAIN.healRadius, healPerSecond: FOUNTAIN.healPerSecond },
  );
  h.spawnCamp('camp_a', { x: shop.x + 600, z: shop.z - 400 }, ['ghoul', 'ghoul']);
  h.spawnCamp('camp_b', { x: shop.x - 600, z: shop.z + 400 }, ['ghoul', 'ghoul']);
  h.attachAi('p1');
  h.attachAi('p2');

  let k1 = 0;
  let k2 = 0;
  const s1: V.Vec2[] = [];
  const s2: V.Vec2[] = [];

  for (let t = 0; t < h.seconds(150); t++) {
    for (const e of h.tick()) {
      if (e.type === 'kill' && e.sourceId === 'p1' && e.victimId === 'p2') k1++;
      if (e.type === 'kill' && e.sourceId === 'p2' && e.victimId === 'p1') k2++;
    }
    if (t % 30 === 0) {
      s1.push({ x: p1.pos.x, z: p1.pos.z });
      s2.push({ x: p2.pos.x, z: p2.pos.z });
    }
  }

  // Bidirectional combat — each side landed at least one kill on the other.
  expectTrue(k1 >= 1, `p1 scored a kill (p1 kills=${k1})`);
  expectTrue(k2 >= 1, `p2 scored a kill (p2 kills=${k2})`);
  expectTrue(k1 + k2 >= 3, `the match saw real fighting (total hero kills=${k1 + k2})`);

  // No stalemate — both heroes moved substantially over the match.
  let m1 = 0;
  let m2 = 0;
  for (let i = 1; i < s1.length; i++) {
    m1 += V.distance(s1[i - 1], s1[i]);
    m2 += V.distance(s2[i - 1], s2[i]);
  }
  expectTrue(m1 > 10000 && m2 > 10000, `no stalemate — travel p1=${m1.toFixed(0)} p2=${m2.toFixed(0)}`);
}
