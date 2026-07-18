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

  // Creeps chase as far as leashRange (1200) — wider than the whole test map —
  // so rather than kiting it off the edge, drag it past the leash boundary
  // directly to exercise the give-up-and-go-home path.
  ghoul.pos = { x: ghoul.spawnPos.x, z: ghoul.spawnPos.z - (CREEP.leashRange + 50) };
  h.tick();
  expectTrue(ghoul.aggroTargetId === null, 'aggro dropped past the leash boundary');
  expectTrue(ghoul.leashing, 'creep committed to returning home');

  // Put it back on walkable ground; it paths home, snaps to spawn, heals full.
  ghoul.pos = h.findWalkableNear(ghoul.spawnPos.x - 250, ghoul.spawnPos.z);
  h.runUntil(
    () =>
      ghoul.pos.x === ghoul.spawnPos.x &&
      ghoul.pos.z === ghoul.spawnPos.z &&
      ghoul.hp === creepMaxHp('ghoul', 1),
    h.seconds(10),
    'ghoul home and healed',
  );
  expectTrue(ghoul.aggroTargetId === null, 'still idle after returning');
  expectTrue(!ghoul.leashing, 'leash lock cleared at home');
}
