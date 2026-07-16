/**
 * A hero levels Shoot Arrow, fires at a stationary enemy, and the arrow
 * travels smoothly (constant speed) and connects.
 */
import { SimHarness, DT, expectEvent, expectNear, expectTrue } from '../scripts/harness/SimHarness';
import { ARROW } from '../src/sim/rules';

export const name = 'arrow-hit';

export function run(h: SimHarness): void {
  const { a: shooter, b: target } = h.spawnDuelists(400);

  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();
  expectTrue(shooter.abilityLevel === 1, 'ability learned from starting skill point');

  h.issue('p1', { type: 'fire', aimX: target.pos.x, aimZ: target.pos.z });
  const events = h.runUntil((_s, evs) => evs.some((e) => e.type === 'hit'), h.seconds(2), 'arrow hit');

  const hit = expectEvent(events, 'hit');
  expectTrue(hit.type === 'hit' && hit.targetId === 'p2', 'hit landed on p2');
  // A level-1 arrow does 200 damage vs 625 max hp — non-lethal hit.
  expectTrue(hit.type === 'hit' && hit.damage === ARROW.damageByLevel[1], 'hit dealt level-1 arrow damage');
  expectTrue(target.alive, 'target survived non-lethal hit');
  expectTrue(target.hp === 425, `target hp after hit: ${target.hp}`);

  // The sim's projectile must advance exactly ARROW.speed * dt every tick —
  // this is the smooth baseline the client view should match.
  const flight = h.trace.filter((l) => l.projectiles.length > 0);
  for (let i = 1; i < flight.length; i++) {
    const [a, b] = [flight[i - 1].projectiles[0], flight[i].projectiles[0]];
    const step = Math.hypot(b.x - a.x, b.z - a.z);
    expectNear(step, ARROW.speed * DT, 1, `projectile step at tick ${flight[i].tick} is uniform`);
  }
}
