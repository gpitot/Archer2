/**
 * A hero kills an enemy with arrows; the victim respawns after the delay and
 * the killer earns gold and XP.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { HERO } from '../src/sim/rules';

export const name = 'kill-respawn';

export function run(h: SimHarness): void {
  const { a: shooter, b: victim } = h.spawnDuelists(400);

  h.issue('p1', { type: 'levelAbility' });
  h.tick();

  // Fire whenever off cooldown until the victim dies (level 1 needs one hit).
  h.runUntil((_s, evs) => {
    if (shooter.abilityCooldown <= 0 && victim.alive) {
      h.issue('p1', { type: 'fire', aimX: victim.pos.x, aimZ: victim.pos.z });
    }
    return evs.some((e) => e.type === 'kill');
  }, h.seconds(10), 'victim killed');

  expectTrue(!victim.alive, 'victim is dead after kill event');
  expectTrue(shooter.kills === 1, 'shooter credited with the kill');
  expectTrue(shooter.gold > 0, 'shooter earned kill gold');
  expectTrue(shooter.xp > 0, 'shooter earned kill XP');

  h.runUntil((_s, evs) => evs.some((e) => e.type === 'respawn'), h.seconds(HERO.respawnDelay + 2), 'victim respawned');
  expectTrue(victim.alive && victim.hp === HERO.maxHp, 'victim alive at full hp after respawn');
}
