/**
 * Rune power-ups: walk-over pickup, haste speed, double damage, invisibility
 * (creep aggro immunity + break-on-attack), and timed respawn with a fresh
 * roll.
 */
import { SimHarness, expectTrue, expectEvent } from '../scripts/harness/SimHarness';
import { spawnRunes, applyRuneBuff } from '../src/sim/stepRunes';
import { heroSpeed } from '../src/sim/stepMatch';
import { RUNE, RUNE_TYPES } from '../src/sim/runeRules';
import { HERO } from '../src/sim/rules';
import { TEST_MAP_SPAWNS } from '../src/world/testMap';

export const name = 'rune-pickup';
export const map = 'test';

export function run(h: SimHarness): void {
  const spawn = h.findWalkableNear(TEST_MAP_SPAWNS[0].x, TEST_MAP_SPAWNS[0].z);
  const hero = h.spawnHero('p1', 0, spawn);

  // One authored rune spot a short walk away.
  const spot = h.findWalkableNear(spawn.x + 300, spawn.z);
  spawnRunes(h.state, h.world, [{ x: spot.x, z: spot.z }], h.rng);
  expectTrue(h.state.runes.length === 1, 'one rune spot spawned');
  const rune = h.state.runes[0];
  expectTrue(rune.active, 'rune starts active');

  // Force a known type, walk over it, and expect the pickup.
  rune.type = 'haste';
  h.issue('p1', { type: 'moveTo', x: rune.pos.x, z: rune.pos.z });
  const events = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'runePickup'),
    h.seconds(10),
    'rune picked up',
  );
  const pickup = expectEvent(events, 'runePickup');
  expectTrue((pickup as any).heroId === 'p1', 'picked up by p1');
  expectTrue((pickup as any).runeType === 'haste', 'haste rune type carried');
  expectTrue(!rune.active, 'rune consumed');
  expectTrue(hero.hasteTimer > 0, 'haste timer running');
  expectTrue(
    heroSpeed(hero) === HERO.baseSpeed + RUNE.hasteSpeedBonus,
    `haste speed applied (${heroSpeed(hero)})`,
  );

  // Haste expires.
  h.tick(h.seconds(RUNE_TYPES.haste.duration + 0.5));
  expectTrue(hero.hasteTimer === 0, 'haste expired');
  expectTrue(heroSpeed(hero) === HERO.baseSpeed, 'speed back to base');

  // ── Double damage ──
  applyRuneBuff(hero, 'doubleDamage');
  const enemy = h.spawnHero('p2', 1, h.findWalkableNear(hero.pos.x + 400, hero.pos.z));
  h.tick(); // settle
  h.issue('p1', { type: 'fire', aimX: enemy.pos.x, aimZ: enemy.pos.z });
  const hitEvents = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'hit' && (e as any).targetId === 'p2'),
    h.seconds(3),
    'arrow hits enemy',
  );
  const hit = hitEvents.find((e) => e.type === 'hit' && (e as any).targetId === 'p2') as any;
  expectTrue(hit.damage === 400, `double damage dealt (got ${hit.damage}, want 400)`);

  // ── Invisibility: creeps ignore the hero, attacking breaks it ──
  applyRuneBuff(hero, 'invisibility');
  const [ghoul] = h.spawnCamp('camp_t', { x: hero.pos.x + 200, z: hero.pos.z }, ['ghoul']);
  h.tick(h.seconds(1));
  expectTrue(ghoul.aggroTargetId !== 'p1', 'invisible hero draws no creep aggro');
  h.issue('p1', { type: 'fire', aimX: hero.pos.x + 100, aimZ: hero.pos.z });
  h.tick();
  expectTrue(hero.invisTimer === 0, 'attacking breaks invisibility');

  // ── Respawn: a new rune (freshly rolled type) appears after the interval ──
  const respawnEvents = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'runeSpawn'),
    h.seconds(RUNE.respawnInterval + 1),
    'rune respawned',
  );
  expectEvent(respawnEvents, 'runeSpawn');
  expectTrue(rune.active, 'rune active again after respawn');
}
