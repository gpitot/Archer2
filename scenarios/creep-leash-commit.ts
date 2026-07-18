/**
 * Leash commitment: once a creep is dragged past its leash it walks all the
 * way home without re-aggroing, even if the hero is standing right next to it
 * within aggro range. This is the fix for the "stutter at the leash edge"
 * (drop aggro → step home → re-aggro → step out → re-leash) oscillation.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { CREEP, CREEP_TYPES } from '../src/sim/creepRules';

export const name = 'creep-leash-commit';
export const map = 'test';

export function run(h: SimHarness): void {
  const def = CREEP_TYPES.ghoul;
  const hero = h.spawnHero('p1', 0, h.findWalkableNear(-350, 420));
  const [ghoul] = h.spawnCamp('camp_commit', h.findWalkableNear(250, 420), ['ghoul']);

  // Aggro it, then drag it past the leash (leashRange 1200 exceeds the test
  // map, so teleport it out) so it gives up and commits to going home.
  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();
  h.issue('p1', { type: 'cast', ability: 'arrow', x: ghoul.pos.x, z: ghoul.pos.z });
  h.runUntil((_s, evs) => evs.some((e) => e.type === 'creepHit'), h.seconds(2), 'aggroed');
  ghoul.pos = { x: ghoul.spawnPos.x, z: ghoul.spawnPos.z - (CREEP.leashRange + 50) };
  h.tick();
  expectTrue(ghoul.aggroTargetId === null, 'leash breaks');
  expectTrue(ghoul.leashing, 'creep is committed to returning home');
  // Drop it back onto walkable ground mid-field so it can path home.
  ghoul.pos = h.findWalkableNear(ghoul.spawnPos.x - 300, ghoul.spawnPos.z);

  // Teleport-follow the hero right onto the returning creep — always inside
  // aggro range. The OLD code would re-aggro here and stutter; the fix keeps
  // the creep homing monotonically without ever re-aggroing until it's home.
  let prevDist = Math.hypot(ghoul.pos.x - ghoul.spawnPos.x, ghoul.pos.z - ghoul.spawnPos.z);
  let reachedHome = false;
  for (let i = 0; i < 80; i++) {
    hero.pos.x = ghoul.pos.x + 40;
    hero.pos.z = ghoul.pos.z;
    h.tick();
    const heroDist = Math.hypot(ghoul.pos.x - hero.pos.x, ghoul.pos.z - hero.pos.z);
    const dist = Math.hypot(ghoul.pos.x - ghoul.spawnPos.x, ghoul.pos.z - ghoul.spawnPos.z);
    expectTrue(heroDist < def.aggroRange, `hero stays in aggro range: ${Math.round(heroDist)}`);
    if (dist < CREEP.arriveEpsilon) { reachedHome = true; break; }
    expectTrue(ghoul.aggroTargetId === null, 'does not re-aggro while returning');
    expectTrue(dist <= prevDist + 0.01, `homing is monotonic (no stutter): ${Math.round(dist)}`);
    prevDist = dist;
  }
  expectTrue(reachedHome, 'creep made it home despite the hero shadowing it');
}
