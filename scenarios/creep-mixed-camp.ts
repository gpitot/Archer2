/**
 * Mixed camp (ghoul + dragon): the ranged unit opens from stand-off range
 * while the melee unit holds until the hero is inside ITS aggro radius,
 * then closes to melee. Hero-vs-hero kill credit still works with creeps
 * and creep projectiles in play (regression guard on the projectile-loop
 * restructure).
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { CREEP_TYPES } from '../src/sim/creepRules';

export const name = 'creep-mixed-camp';
export const map = 'test';

export function run(h: SimHarness): void {
  const ghoulDef = CREEP_TYPES.ghoul;
  const dragonDef = CREEP_TYPES.dragon;

  const hero = h.spawnHero('p1', 0, h.findWalkableNear(-700, 420));
  const [ghoul, dragon] = h.spawnCamp('camp_mixed', h.findWalkableNear(250, 420), [
    'ghoul',
    'dragon',
  ]);

  // Step into dragon range but stay outside ghoul aggro.
  const standoff = h.findWalkableNear(dragon.pos.x - dragonDef.attackRange + 60, 420);
  h.issue('p1', { type: 'moveTo', x: standoff.x, z: standoff.z });
  h.runUntil(
    (s) => s.projectiles.some((p) => p.ownerKind === 'creep'),
    h.seconds(6),
    'dragon opens fire',
  );
  expectTrue(dragon.aggroTargetId === 'p1', 'dragon aggroed');
  expectTrue(ghoul.aggroTargetId === null, 'ghoul still idle at stand-off range');
  expectTrue(
    ghoul.pos.x === ghoul.spawnPos.x && ghoul.pos.z === ghoul.spawnPos.z,
    'ghoul has not moved',
  );

  // Walk into ghoul aggro — now both attack: fireballs from range, claws up close.
  h.issue('p1', {
    type: 'moveTo',
    x: ghoul.pos.x - ghoulDef.aggroRange + 100,
    z: ghoul.pos.z,
  });
  const brawl = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'hit' && e.sourceId === ghoul.id),
    h.seconds(8),
    'ghoul melee connects',
  );
  expectTrue(
    brawl.some((e) => e.type === 'hit' && e.sourceId === dragon.id),
    'dragon fireballs also landed during the brawl',
  );

  // Hero-vs-hero kill credit is untouched by creeps being in the state:
  // a wounded p2 dies to p1's arrow — kill/first-blood credit goes to p1,
  // not to any creep path.
  const victim = h.spawnHero('p2', 1, h.findWalkableNear(hero.pos.x - 400, 420));
  victim.hp = 150; // pre-wounded: one level-1 arrow (200) is lethal
  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();
  h.issue('p1', { type: 'fire', aimX: victim.pos.x, aimZ: victim.pos.z });
  const duel = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'kill' && e.victimId === 'p2'),
    h.seconds(3),
    'hero kill lands',
  );
  const kill = duel.find((e) => e.type === 'kill' && e.victimId === 'p2')!;
  expectTrue(kill.type === 'kill' && kill.sourceId === 'p1', 'kill credited to the hero');
  expectTrue(hero.kills === 1, 'killer kill count incremented');
  expectTrue(!h.state.firstBlood, 'first blood consumed by the hero kill');
  expectTrue(!victim.alive, 'victim dead');
}
