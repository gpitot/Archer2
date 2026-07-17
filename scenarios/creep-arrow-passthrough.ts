/**
 * Hit-check ordering: heroes are tested before creeps, so an arrow that
 * passes through a dodging hero flies on and hits the creep behind them.
 */
import { SimHarness, expectEvent, expectTrue } from '../scripts/harness/SimHarness';
import { CREEP_TYPES } from '../src/sim/creepRules';

export const name = 'creep-arrow-passthrough';
export const map = 'test';

export function run(h: SimHarness): void {
  const shooter = h.spawnHero('p1', 0, h.findWalkableNear(-400, 420));
  const dodger = h.spawnHero('p2', 1, h.findWalkableNear(-200, 420));
  const [ghoul] = h.spawnCamp('camp_line', h.findWalkableNear(40, 420), ['ghoul']);

  // All three sit on one arrow line (same walkable grid row).
  expectTrue(
    Math.abs(shooter.pos.z - dodger.pos.z) < 1 && Math.abs(dodger.pos.z - ghoul.pos.z) < 1,
    'shooter, dodger, and ghoul are colinear',
  );
  expectTrue(h.hasLineOfSight(shooter.pos, ghoul.pos), 'clear arrow line to the ghoul');

  // Grant p2 a point for W rank 1 (the level-1 point is auto-spent on Q).
  dodger.skillPoints = 1;
  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.issue('p2', { type: 'levelAbility', ability: 'dodge' });
  h.tick();

  // p2 dodges, p1 fires through them at the ghoul.
  h.issue('p2', { type: 'dodge' });
  h.tick();
  expectTrue(dodger.dodgeActive, 'p2 is dodging');
  h.issue('p1', { type: 'fire', aimX: ghoul.pos.x, aimZ: ghoul.pos.z });

  const events = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'creepHit'),
    h.seconds(2),
    'arrow reaches the creep',
  );
  const creepHit = expectEvent(events, 'creepHit');
  expectTrue(creepHit.type === 'creepHit' && creepHit.creepId === 'c1', 'the ghoul was hit');
  expectTrue(
    !events.some((e) => e.type === 'hit' && e.targetId === 'p2'),
    'the dodging hero was passed through, not hit',
  );
  expectTrue(dodger.hp === 625, 'dodger untouched');
  expectTrue(ghoul.hp === CREEP_TYPES.ghoul.baseHp - 200, `ghoul took the arrow: ${ghoul.hp}`);
}
