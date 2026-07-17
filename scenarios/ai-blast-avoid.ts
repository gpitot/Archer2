/**
 * The AI walks out of an enemy blast circle before it detonates. `state.blasts`
 * is global, so the perfect-info AI always sees the 1.5s-fuse zone it's
 * standing in and evacuates. We drop a max-rank enemy blast centred exactly on
 * the AI and assert it clears the radius and takes no damage.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { BLAST, HERO } from '../src/sim/rules';
import * as V from '../src/sim/math';

export const name = 'ai-blast-avoid';

export function run(h: SimHarness): void {
  const shop = h.shopPos;
  const pos = h.findWalkableNear(shop.x + 300, shop.z + 200);
  const ai = h.spawnHero('p1', 0, pos);
  h.attachAi('p1');
  h.tick(2); // let the controller settle

  // Drop a max-rank enemy blast right on top of the AI.
  const center = { x: ai.pos.x, z: ai.pos.z };
  h.state.blasts.push({
    id: `b${h.state.nextBlastId++}`,
    ownerId: 'enemy',
    team: 1,
    pos: center,
    timer: BLAST.delay,
    damage: BLAST.damageByLevel[BLAST.maxLevel],
  });
  const hpBefore = ai.hp;

  h.runUntil((_s, evs) => evs.some((e) => e.type === 'blastExplode'), h.seconds(3), 'blast detonates');

  const dist = V.distance(ai.pos, center);
  const safeDist = BLAST.radius + HERO.bodyRadius;
  expectTrue(dist > safeDist, `AI cleared the blast radius (moved ${dist.toFixed(0)}u > ${safeDist}u)`);
  expectTrue(ai.hp >= hpBefore, `AI took no blast damage (hp ${hpBefore} → ${ai.hp})`);
}
