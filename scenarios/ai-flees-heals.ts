/**
 * A low-hp AI disengages and heals instead of fighting. With hp below the
 * flee threshold (~35%) and a live enemy nearby, the macro FSM must pick
 * FLEE/HEAL: path to the nearest fountain, reach its aura, and recover hp —
 * rather than trading into a fight it would lose.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { FOUNTAIN, HERO } from '../src/sim/rules';
import * as V from '../src/sim/math';

export const name = 'ai-flees-heals';

export function run(h: SimHarness): void {
  const { a: ai, b: enemy } = h.spawnDuelists(500);

  // A reachable fountain (near the shop, the map's connectivity anchor).
  const shop = h.shopPos;
  const fpos = h.findWalkableNear(shop.x + 250, shop.z + 250);
  h.world.fountains.push({ pos: fpos, healRadius: FOUNTAIN.healRadius, healPerSecond: FOUNTAIN.healPerSecond });

  ai.hp = 120; // ~19% — well under the flee threshold
  const startHp = ai.hp;
  h.attachAi('p1');

  let reached = false;
  let maxHp = ai.hp;
  for (let t = 0; t < h.seconds(25); t++) {
    enemy.hp = HERO.maxHp; // keep the aggressor alive so fighting stays a bad idea
    h.tick();
    if (V.distance(ai.pos, fpos) <= FOUNTAIN.healRadius) reached = true;
    maxHp = Math.max(maxHp, ai.hp);
  }

  expectTrue(reached, 'AI reached the fountain aura');
  expectTrue(maxHp > startHp + 100, `AI healed at the fountain (${startHp} → peak ${maxHp.toFixed(0)})`);
  expectTrue(ai.deaths === 0, `AI survived by disengaging (deaths=${ai.deaths})`);
}
