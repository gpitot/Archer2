/**
 * Power-up rune simulation: spot spawning, walk-over pickup, buff
 * application, and timed respawns with a fresh random type. Pure and
 * deterministic like the rest of the sim — runs identically on the server,
 * in offline mode, and in the test harness.
 */
import * as V from './math';
import {
  RUNE,
  RUNE_SPOT_DEFS,
  RUNE_TYPES,
  RunePlacement,
  RuneTypeId,
  randomRuneType,
} from './runeRules';
import { HeroState, MatchState, SimEvent } from './state';
import { findReachableNear, findWalkableNear, SimWorld } from './world';

/**
 * Populate `state.runes` from spot placements. By default spots come from
 * `RUNE_SPOT_DEFS` (fractions of the arena rect, so the same defs work on
 * every built-in map); custom maps pass their authored world-coordinate
 * placements instead. Spots are snapped to the walkable component reachable
 * from the shop, so a rune never lands on a cliff top or islet. Ids
 * (`r1`, `r2`, …) follow definition order, so every peer derives the same
 * ids independently. Initial types roll from `rng`.
 */
export function spawnRunes(
  state: MatchState,
  world: SimWorld,
  placements?: readonly RunePlacement[] | null,
  rng: () => number = Math.random,
): void {
  const defs: readonly RunePlacement[] = placements ?? RUNE_SPOT_DEFS.map((def) => ({
    x: world.arena.minX + def.fx * world.arena.width,
    z: world.arena.minZ + def.fz * world.arena.height,
  }));
  defs.forEach((def, idx) => {
    const pos =
      findReachableNear(world, def.x, def.z, world.shop.pos.x, world.shop.pos.z) ??
      findWalkableNear(world, def.x, def.z);
    state.runes.push({
      id: `r${idx + 1}`,
      pos: { x: pos.x, z: pos.z },
      type: randomRuneType(rng),
      active: true,
      respawnTimer: 0,
    });
  });
}

/** Tick rune spots: pickups by heroes standing on them, and respawns. */
export function stepRunes(
  state: MatchState,
  dt: number,
  events: SimEvent[],
  rng: () => number,
): void {
  const r2 = RUNE.pickupRadius * RUNE.pickupRadius;

  for (const rune of state.runes) {
    if (!rune.active) {
      rune.respawnTimer -= dt;
      if (rune.respawnTimer <= 0) {
        rune.active = true;
        rune.respawnTimer = 0;
        rune.type = randomRuneType(rng);
        events.push({ type: 'runeSpawn', runeId: rune.id, runeType: rune.type });
      }
      continue;
    }

    // Walk-over pickup: first alive hero inside the radius takes it. Hero
    // order is state order — deterministic on every peer.
    for (const hero of state.heroes) {
      if (!hero.alive) continue;
      if (V.distanceSq(hero.pos, rune.pos) > r2) continue;
      applyRuneBuff(hero, rune.type);
      rune.active = false;
      rune.respawnTimer = RUNE.respawnInterval;
      events.push({
        type: 'runePickup',
        runeId: rune.id,
        heroId: hero.id,
        runeType: rune.type,
        x: rune.pos.x,
        z: rune.pos.z,
      });
      break;
    }
  }
}

/** Grant (or refresh) a rune buff on a hero. */
export function applyRuneBuff(hero: HeroState, type: RuneTypeId): void {
  const duration = RUNE_TYPES[type].duration;
  switch (type) {
    case 'doubleDamage':
      hero.ddTimer = duration;
      break;
    case 'haste':
      hero.hasteTimer = duration;
      break;
    case 'invisibility':
      hero.invisTimer = duration;
      break;
  }
}

/** Tick a hero's rune buff timers (called from stepHero). */
export function stepRuneBuffs(hero: HeroState, dt: number): void {
  if (hero.ddTimer > 0) hero.ddTimer = Math.max(0, hero.ddTimer - dt);
  if (hero.hasteTimer > 0) hero.hasteTimer = Math.max(0, hero.hasteTimer - dt);
  if (hero.invisTimer > 0) hero.invisTimer = Math.max(0, hero.invisTimer - dt);
}

/** Damage multiplier for hero-dealt hits (double damage rune). */
export function runeDamageMultiplier(hero: HeroState): number {
  return hero.ddTimer > 0 ? RUNE.ddMultiplier : 1;
}

/** Attacking or casting breaks invisibility (DotA rules). */
export function breakInvisibility(hero: HeroState): void {
  hero.invisTimer = 0;
}

/** True while the hero is hidden from enemies and creeps. */
export function isInvisible(hero: HeroState): boolean {
  return hero.invisTimer > 0;
}
