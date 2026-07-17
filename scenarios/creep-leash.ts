/**
 * Leash + retaliation: shooting a ghoul from outside its aggro range pulls
 * it; a fleeing hero drags it past the leash range, where it gives up,
 * walks home, snaps to its spawn, and heals to full.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { CREEP, CREEP_TYPES, creepMaxHp } from '../src/sim/creepRules';

export const name = 'creep-leash';
export const map = 'test';

export function run(h: SimHarness): void {
  const def = CREEP_TYPES.ghoul;
  const hero = h.spawnHero('p1', 0, h.findWalkableNear(-350, 420));
  const [ghoul] = h.spawnCamp('camp_leash', h.findWalkableNear(250, 420), ['ghoul']);
  expectTrue(
    Math.hypot(ghoul.pos.x - hero.pos.x, ghoul.pos.z - hero.pos.z) > def.aggroRange,
    'hero starts outside ghoul aggro range',
  );

  // An arrow from beyond aggro range wounds the ghoul AND pulls it.
  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();
  h.issue('p1', { type: 'cast', ability: 'arrow', x: ghoul.pos.x, z: ghoul.pos.z });
  h.runUntil((_s, evs) => evs.some((e) => e.type === 'creepHit'), h.seconds(2), 'sniped');
  expectTrue(ghoul.hp === def.baseHp - 200, `ghoul wounded: ${ghoul.hp}`);
  expectTrue(ghoul.aggroTargetId === 'p1', 'retaliation aggro from out-of-range damage');

  // Run away — the slower ghoul chases until it crosses its leash range,
  // then gives up.
  h.issue('p1', { type: 'moveTo', x: -800, z: 420 });
  h.runUntil(() => ghoul.aggroTargetId === null, h.seconds(10), 'leash breaks aggro');
  expectTrue(
    Math.hypot(ghoul.pos.x - ghoul.spawnPos.x, ghoul.pos.z - ghoul.spawnPos.z) >
      CREEP.leashRange - def.speed / 10,
    'aggro dropped out at the leash boundary',
  );

  // It walks home, snaps to spawn, and heals to full.
  h.runUntil(
    () =>
      ghoul.pos.x === ghoul.spawnPos.x &&
      ghoul.pos.z === ghoul.spawnPos.z &&
      ghoul.hp === creepMaxHp('ghoul', 1),
    h.seconds(10),
    'ghoul home and healed',
  );
  expectTrue(ghoul.aggroTargetId === null, 'still idle after returning');
}
