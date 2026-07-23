/**
 * Ranged creep (dragon): stands off and fires a creep-owned projectile that
 * flies at a uniform sub-arrow speed and hits for dragon damage; a dodging
 * hero lets the fireball pass through; a fireball line blocked by the solid
 * rock never lands.
 */
import { DT, SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { CREEP_TYPES } from '../src/sim/creepRules';

export const name = 'creep-ranged';
export const map = 'test';

export function run(h: SimHarness): void {
  const def = CREEP_TYPES.dragon;

  // Part 1: hero inside the dragon's attack range — it fires from the spot.
  const hero = h.spawnHero('p1', 0, h.findWalkableNear(-300, 420));
  const [dragon] = h.spawnCamp('camp_dragon', h.findWalkableNear(150, 420), ['dragon']);
  expectTrue(
    Math.hypot(dragon.pos.x - hero.pos.x, dragon.pos.z - hero.pos.z) < def.attackRange,
    'hero starts inside dragon attack range',
  );

  // Part 2 setup: a second hero parked behind the solid rock (rock spans
  // x −240..−160, z −460..−380), with a second dragon due south of it.
  const bunkered = h.spawnHero('p2', 1, h.findWalkableNear(-200, -170));
  const [blockedDragon] = h.spawnCamp('camp_blocked', h.findWalkableNear(-200, -650), ['dragon']);
  expectTrue(
    !h.hasLineOfSight(blockedDragon.pos, bunkered.pos),
    'rock blocks the line between the second dragon and p2',
  );

  h.runUntil(
    (s) => s.projectiles.some((p) => p.ownerKind === 'creep' && p.ownerId === 'c1'),
    h.seconds(2),
    'dragon fires',
  );
  const fireball = h.state.projectiles.find((p) => p.ownerId === 'c1')!;
  expectTrue(fireball.speed === def.projectileSpeed, 'fireball flies at dragon projectile speed');
  expectTrue(fireball.damage === def.baseDamage, 'fireball carries level-1 dragon damage');
  expectTrue(fireball.team === -1, 'fireball is neutral-team');
  expectTrue(dragon.pos.x === dragon.spawnPos.x, 'dragon never moved (already in range)');

  const hitEvents = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'hit' && e.targetId === 'p1'),
    h.seconds(2),
    'fireball hit',
  );
  const hit = hitEvents.find((e) => e.type === 'hit' && e.targetId === 'p1')!;
  expectTrue(hit.type === 'hit' && hit.sourceId === 'c1', 'hit attributed to the dragon');
  expectTrue(hero.hp === 625 - def.baseDamage, `hero hp after fireball: ${hero.hp}`);

  // The sim's fireball advances exactly projectileSpeed * DT per tick, like
  // hero arrows — the client interpolates the same way for both.
  const flight = h.trace.filter((l) => l.projectiles.some((p) => p.id === fireball.id));
  for (let i = 1; i < flight.length; i++) {
    const a = flight[i - 1].projectiles.find((p) => p.id === fireball.id)!;
    const b = flight[i].projectiles.find((p) => p.id === fireball.id)!;
    const step = Math.hypot(b.x - a.x, b.z - a.z);
    expectTrue(Math.abs(step - def.projectileSpeed! * DT) < 1, 'fireball step is uniform');
  }

  // Dodge: grant the evasion window directly (the W dodge spell was replaced
  // by Split Arrow; the mechanic survives for future items) as the next
  // fireball spawns → it passes through and expires with no hit.
  const hpBeforeDodge = () => hero.hp;
  h.runUntil(
    (s) => s.projectiles.some((p) => p.ownerId === 'c1'),
    h.seconds(3),
    'second fireball',
  );
  const hpAtDodge = hpBeforeDodge();
  hero.dodgeTimer = 2;
  const dodgeWindow = h.runUntil(
    (s) => !s.projectiles.some((p) => p.ownerId === 'c1'),
    h.seconds(2),
    'dodged fireball expires',
  );
  expectTrue(
    !dodgeWindow.some((e) => e.type === 'hit' && e.targetId === 'p1'),
    'no hit on p1 while dodging',
  );
  expectTrue(hero.hp === hpAtDodge, 'dodged fireball dealt no damage');

  // Blocked line: the second dragon keeps firing at p2 but every fireball
  // dies on the rock — p2 never takes a hit.
  const blocked = h.tick(h.seconds(4));
  expectTrue(
    !blocked.some((e) => e.type === 'hit' && e.targetId === 'p2'),
    'rock-blocked fireballs never hit p2',
  );
  expectTrue(bunkered.hp === 625, 'p2 untouched behind the rock');
}
