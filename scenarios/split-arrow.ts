/**
 * Split Arrow (W): one cast looses a fan of three arrows — the middle one
 * straight at the aim point, the outer two rotated 15° to either side — each
 * dealing ~70% of the Q arrow's damage, and the cast starts W's cooldown.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { SPLIT } from '../src/sim/rules';

export const name = 'split-arrow';

export function run(h: SimHarness): void {
  const { a: shooter, b: target } = h.spawnDuelists(400);

  // Grant a point for W rank 1 (the level-1 point is auto-spent on Q).
  shooter.skillPoints = 1;
  h.issue('p1', { type: 'levelAbility', ability: 'split' });
  h.tick();
  expectTrue(shooter.abilities.split.level === 1, 'W learned at rank 1');

  // Cast at the enemy: three arrows spawn on the same tick.
  h.issue('p1', { type: 'cast', ability: 'split', x: target.pos.x, z: target.pos.z });
  const castEvents = h.tick();
  const fires = castEvents.filter((e) => e.type === 'fire' && e.heroId === 'p1');
  expectTrue(fires.length === SPLIT.arrowCount, `one cast fired ${SPLIT.arrowCount} arrows (got ${fires.length})`);

  // Fan geometry: middle arrow on the aim line, outer arrows ±15° off it.
  const headings = fires
    .map((e) => (e.type === 'fire' ? Math.atan2(e.projectile.dir.x, e.projectile.dir.z) : 0))
    .sort((a, b) => a - b);
  const spread = (SPLIT.spreadDegrees * Math.PI) / 180;
  expectTrue(Math.abs(headings[1] - headings[0] - spread) < 0.01, 'left arrow is 15° off the middle');
  expectTrue(Math.abs(headings[2] - headings[1] - spread) < 0.01, 'right arrow is 15° off the middle');

  // Each arrow carries the rank-1 split damage (~70% of Q's 200).
  for (const e of fires) {
    expectTrue(e.type === 'fire' && e.projectile.damage === SPLIT.damageByLevel[1],
      `arrow damage is ${SPLIT.damageByLevel[1]}`);
  }

  // Range scales like Q's table, and the cast started the long cooldown.
  expectTrue(fires.every((e) => e.type === 'fire' && e.projectile.maxRange === SPLIT.rangeByLevel[1]),
    'arrows use the rank-1 Q range');
  expectTrue(shooter.abilities.split.cooldown > SPLIT.cooldownByLevel[1] - 1, 'cast started W cooldown');

  // The middle arrow connects with the target for split damage.
  const events = h.runUntil((_s, evs) => evs.some((e) => e.type === 'hit'), h.seconds(2), 'middle arrow hit');
  const hit = events.find((e) => e.type === 'hit')!;
  expectTrue(hit.type === 'hit' && hit.targetId === 'p2', 'hit landed on p2');
  expectTrue(hit.type === 'hit' && hit.damage === SPLIT.damageByLevel[1], 'hit dealt split damage');

  // On cooldown: a second cast is ignored.
  h.issue('p1', { type: 'cast', ability: 'split', x: target.pos.x, z: target.pos.z });
  const recast = h.tick();
  expectTrue(!recast.some((e) => e.type === 'fire'), 'W cannot recast while cooling down');
}
