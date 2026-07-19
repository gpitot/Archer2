/**
 * Fire Bow: an arrow hit sets the target ablaze for an extra 10% of the hit's
 * damage over 3s, credited to the shooter and ticked via `hit` events. Re-hits
 * STACK — a second arrow adds another 10% to the burn pool rather than merely
 * refreshing it, so two hits burn for ~20% total.
 */
import { SimHarness, expectEvent, expectTrue, expectNear } from '../scripts/harness/SimHarness';
import { ARROW } from '../src/sim/rules';
import { FIRE_BOW_BURN_FRACTION, FIRE_BOW_BURN_DURATION } from '../src/sim/shopItems';

export const name = 'fire-bow-burn';

const directDamage = ARROW.damageByLevel[1];
const perHitBurn = directDamage * FIRE_BOW_BURN_FRACTION;

export function run(h: SimHarness): void {
  const { a: shooter, b: target } = h.spawnDuelists(400);
  shooter.inventory[0] = 'fire_bow';

  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();

  const fireAndAwaitDirectHit = (label: string) => {
    h.issue('p1', { type: 'cast', ability: 'arrow', x: target.pos.x, z: target.pos.z });
    return h.runUntil(
      (_s, evs) => evs.some((e) => e.type === 'hit' && e.projectileId !== 'burn'),
      h.seconds(2),
      label,
    );
  };

  // ── First hit: burn applied, credited to the shooter, one stack's worth ──
  const firstEvents = fireAndAwaitDirectHit('first arrow hit');
  const hit = expectEvent(firstEvents, 'hit');
  expectTrue(hit.type === 'hit' && hit.damage === directDamage, 'direct hit dealt level-1 arrow damage');
  expectTrue(target.burnSourceId === 'p1', 'burn credited to the shooter');
  expectNear(target.burnRemaining, perHitBurn, 0.01, 'one stack = 10% of the hit');

  // ── Second hit while still burning: the pool STACKS (grows past one stack) ──
  fireAndAwaitDirectHit('second arrow hit');
  expectTrue(
    target.burnRemaining > perHitBurn + 5,
    `pool stacked past a single hit (remaining=${target.burnRemaining.toFixed(1)})`,
  );

  // ── Drain to completion and confirm exact conservation ──
  h.runUntil(() => target.burnRemaining === 0, h.seconds(FIRE_BOW_BURN_DURATION + 1), 'burn drains');

  const totalDamage = 625 - target.hp;
  const totalBurn = totalDamage - 2 * directDamage;
  expectNear(totalBurn, 2 * perHitBurn, 0.5, `two stacks burned ~20% total (${totalBurn.toFixed(2)})`);
  expectTrue(target.alive, 'target survived (2×200 + burn < 625 hp)');
}
