/**
 * A full economy loop over 300s of PvE (no enemy hero): the AI farms creep
 * camps, spends the gold on its build order, spends skill points as it levels,
 * and never gets stuck. Exercises the FARM/SHOP macro modes, `build.ts`, and
 * the LoF-aware repositioning that stops the bot freezing behind obstacles.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { FOUNTAIN } from '../src/sim/rules';
import * as V from '../src/sim/math';

export const name = 'ai-farms-shops-levels';

export function run(h: SimHarness): void {
  const shop = h.shopPos;
  const ai = h.spawnHero('p1', 0, h.findWalkableNear(shop.x + 150, shop.z + 150));
  h.world.fountains.push({
    pos: h.findWalkableNear(shop.x + 250, shop.z + 250),
    healRadius: FOUNTAIN.healRadius,
    healPerSecond: FOUNTAIN.healPerSecond,
  });
  h.spawnCamp('camp_a', { x: shop.x + 500, z: shop.z + 300 }, ['ghoul', 'ghoul']);
  h.spawnCamp('camp_b', { x: shop.x - 500, z: shop.z - 300 }, ['ghoul', 'ghoul']);
  h.attachAi('p1');

  const purchases: string[] = [];
  let kills = 0;
  const samples: V.Vec2[] = [];

  // 300s, not 120s: creeps carry ~3× the hp they used to for unchanged
  // bounties, so a two-item build order now takes ~5 minutes to fund.
  for (let t = 0; t < h.seconds(300); t++) {
    for (const e of h.tick()) {
      if (e.type === 'purchase' && e.heroId === 'p1') purchases.push(e.itemId);
      if (e.type === 'creepKill' && e.killerId === 'p1') kills++;
    }
    if (t % 30 === 0) samples.push({ x: ai.pos.x, z: ai.pos.z });
  }

  // Gold earned → the bot farmed.
  expectTrue(kills >= 4, `AI farmed creeps (creepKills=${kills})`);

  // Items bought, and bought in build order.
  expectTrue(purchases.length >= 2, `AI bought items (${purchases.join(', ') || 'none'})`);
  const expectedOrder = ['boots', 'ice_bow', 'crit_gem', 'blink_dagger'];
  for (let i = 0; i < purchases.length; i++) {
    expectTrue(purchases[i] === expectedOrder[i], `purchase ${i} was ${expectedOrder[i]} (got ${purchases[i]})`);
  }

  // Skill points spent — the hero leveled and invested.
  const spent =
    (ai.abilities.arrow.level - 1) + ai.abilities.split.level +
    ai.abilities.reveal.level + ai.abilities.blast.level;
  expectTrue(ai.level >= 2, `AI leveled up (level=${ai.level})`);
  expectTrue(spent >= 1, `AI spent skill points (extra ranks=${spent})`);

  // No stuck movement — position keeps changing across the run.
  let moved = 0;
  for (let i = 1; i < samples.length; i++) moved += V.distance(samples[i - 1], samples[i]);
  expectTrue(moved > 3000, `AI kept moving, never stuck (total sampled travel=${moved.toFixed(0)}u)`);
}
