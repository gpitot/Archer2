/**
 * Camp-wide retaliation: hitting any one creep in a camp pulls the whole camp
 * onto the attacker — you can't peel a camp off one creep at a time.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { CREEP_TYPES } from '../src/sim/creepRules';

export const name = 'creep-camp-aggro';
export const map = 'test';

export function run(h: SimHarness): void {
  const def = CREEP_TYPES.ghoul;
  const hero = h.spawnHero('p1', 0, h.findWalkableNear(-350, 420));
  const [a, b] = h.spawnCamp('camp_pair', h.findWalkableNear(250, 420), ['ghoul', 'ghoul']);

  // Both creeps start idle, and the hero is well outside their aggro range.
  expectTrue(a.aggroTargetId === null && b.aggroTargetId === null, 'camp idle at rest');
  expectTrue(
    Math.hypot(a.pos.x - hero.pos.x, a.pos.z - hero.pos.z) > def.aggroRange,
    'hero starts outside aggro range',
  );

  // Snipe only the first creep from beyond aggro range.
  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();
  h.issue('p1', { type: 'cast', ability: 'arrow', x: a.pos.x, z: a.pos.z });
  h.runUntil((_s, evs) => evs.some((e) => e.type === 'creepHit'), h.seconds(2), 'first creep hit');

  // Both creeps — not just the one that was shot — now hunt the attacker.
  expectTrue(a.aggroTargetId === 'p1', 'shot creep aggroed');
  expectTrue(b.aggroTargetId === 'p1', 'campmate aggroed too (camp-wide retaliation)');
}
