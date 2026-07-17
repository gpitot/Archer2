/**
 * Neutral jungle creep simulation: camp spawning, aggro/leash AI, melee and
 * ranged attacks, deaths, rewards, and escalating respawns. Pure and
 * deterministic like the rest of the sim — runs identically on the server,
 * in offline mode, and in the test harness.
 */
import {
  CAMP_DEFS,
  CampPlacement,
  CREEP,
  CREEP_TYPES,
  CreepTypeDef,
  CreepTypeId,
  creepDamage,
  creepGold,
  creepMaxHp,
  creepXp,
} from './creepRules';
import * as V from './math';
import { ARROW } from './rules';
import { CreepState, HeroState, MatchState, ProjectileState, SimEvent } from './state';
import { addXp, killHero, dealDamageToHero, dealDamageToCreep } from './damage';
import { spawnProjectile } from './projectiles';
import { findReachableNear, findWalkableNear, SimWorld, sphereHitsObstacle } from './world';

// ── Camp construction ─────────────────────────────────────────────────

export function createCreep(id: string, campId: string, type: CreepTypeId, pos: V.Vec2): CreepState {
  return {
    id,
    campId,
    type,
    pos: V.clone(pos),
    facing: 0,
    spawnPos: V.clone(pos),
    hp: creepMaxHp(type, 1),
    level: 1,
    alive: true,
    respawnTimer: 0,
    aggroTargetId: null,
    attackCooldown: 0,
    lastActiveTick: 0,
    slowTimer: 0,
  };
}

/**
 * Populate `state.creeps` from camp definitions. By default camps come from
 * `CAMP_DEFS` (centers as fractions of the arena rect, so the same defs work
 * on every built-in map); custom maps pass their authored world-coordinate
 * placements instead. Centers are snapped to the walkable component
 * reachable from the shop so a camp never lands on a cliff top or islet.
 * Ids (`c1`, `c2`, …) follow definition order, so every peer derives the
 * same ids independently.
 */
export function spawnCamps(state: MatchState, world: SimWorld, camps?: readonly CampPlacement[] | null): void {
  const defs: readonly CampPlacement[] = camps ?? CAMP_DEFS.map((def) => ({
    id: def.id,
    x: world.arena.minX + def.fx * world.arena.width,
    z: world.arena.minZ + def.fz * world.arena.height,
    units: def.units,
  }));
  let nextId = 1;
  for (const def of defs) {
    const nx = def.x;
    const nz = def.z;
    const center =
      findReachableNear(world, nx, nz, world.shop.pos.x, world.shop.pos.z) ??
      findWalkableNear(world, nx, nz);
    for (let i = 0; i < def.units.length; i++) {
      const offsetX = (i - (def.units.length - 1) / 2) * CREEP.spawnSpread;
      const offsetZ = i % 2 === 0 ? -CREEP.spawnSpread / 2 : CREEP.spawnSpread / 2;
      const pos = findWalkableNear(world, center.x + offsetX, center.z + offsetZ);
      state.creeps.push(createCreep(`c${nextId++}`, def.id, def.units[i], pos));
    }
  }
}

// ── Per-tick step ─────────────────────────────────────────────────────

export function stepCreeps(
  state: MatchState,
  dt: number,
  world: SimWorld,
  events: SimEvent[],
): void {
  for (let i = 0; i < state.creeps.length; i++) {
    const creep = state.creeps[i];
    const def = CREEP_TYPES[creep.type];

    if (!creep.alive) {
      creep.respawnTimer -= dt;
      if (creep.respawnTimer <= 0) respawnCreep(state, creep, events);
      continue;
    }

    if (creep.attackCooldown > 0) {
      creep.attackCooldown = Math.max(0, creep.attackCooldown - dt);
    }

    if (creep.slowTimer > 0) {
      creep.slowTimer = Math.max(0, creep.slowTimer - dt);
    }

    // Acquire aggro. Idle scans are throttled and staggered by creep index so
    // a full camp never scans on the same tick.
    if (creep.aggroTargetId === null && state.tick % CREEP.aggroScanEvery === i % CREEP.aggroScanEvery) {
      const target = closestHeroInRange(state, creep.pos, def.aggroRange);
      if (target) {
        creep.aggroTargetId = target.id;
        creep.lastActiveTick = state.tick;
      }
    }

    // Validate aggro every tick (cheap): target gone/dead/invulnerable/
    // invisible, or creep dragged past its leash → give up and go home.
    let target: HeroState | null = null;
    if (creep.aggroTargetId !== null) {
      target = state.heroes.find((h) => h.id === creep.aggroTargetId) ?? null;
      if (
        !target ||
        !target.alive ||
        target.invulnerable ||
        target.invisTimer > 0 ||
        V.distanceSq(creep.pos, creep.spawnPos) > CREEP.leashRange * CREEP.leashRange
      ) {
        creep.aggroTargetId = null;
        target = null;
      }
    }

    if (target) {
      const dist = V.distance(creep.pos, target.pos);
      if (dist > def.attackRange) {
        moveCreep(creep, target.pos, def, dt, world);
        creep.lastActiveTick = state.tick;
      } else {
        // In range: face the target, swing/shoot when off cooldown.
        const dir = V.normalize(V.sub(target.pos, creep.pos));
        if (dir.x !== 0 || dir.z !== 0) creep.facing = V.heading(dir);
        if (creep.attackCooldown <= 0) {
          if (def.kind === 'melee') {
            // Melee ignores dodge (dodge evades projectiles, not claws).
            applyCreepDamageToHero(state, target, creepDamage(creep.type, creep.level), creep, creep.id, events);
          } else {
            fireCreepProjectile(state, creep, def, target, events);
          }
          creep.attackCooldown = def.attackCooldown;
        }
        creep.lastActiveTick = state.tick;
      }
    } else if (V.distanceSq(creep.pos, creep.spawnPos) > CREEP.arriveEpsilon * CREEP.arriveEpsilon) {
      moveCreep(creep, creep.spawnPos, def, dt, world);
      creep.lastActiveTick = state.tick;
    } else if (creep.pos.x !== creep.spawnPos.x || creep.pos.z !== creep.spawnPos.z) {
      // Arrived home: snap and heal to full, so an at-rest creep is always
      // "at spawn, full hp" — the invariant behind snapshot idle-omission.
      creep.pos = V.clone(creep.spawnPos);
      creep.hp = creepMaxHp(creep.type, creep.level);
      creep.lastActiveTick = state.tick;
    } else if (creep.hp < creepMaxHp(creep.type, creep.level)) {
      creep.hp = creepMaxHp(creep.type, creep.level);
      creep.lastActiveTick = state.tick;
    }
  }
}

/** Closest alive, non-invulnerable, non-invisible hero within `range`, or null. */
function closestHeroInRange(state: MatchState, pos: V.Vec2, range: number): HeroState | null {
  const r2 = range * range;
  let best: HeroState | null = null;
  let bestD2 = Infinity;
  for (const hero of state.heroes) {
    if (!hero.alive || hero.invulnerable) continue;
    if (hero.invisTimer > 0) continue; // invisible heroes draw no aggro
    const d2 = V.distanceSq(pos, hero.pos);
    if (d2 < r2 && d2 < bestD2) {
      best = hero;
      bestD2 = d2;
    }
  }
  return best;
}

/**
 * Straight-line movement — no pathfinding. Creeps stop at doodads and
 * unwalkable terrain, which keeps them cheap and lets heroes kite them
 * around trees.
 */
function moveCreep(
  creep: CreepState,
  targetPos: V.Vec2,
  def: CreepTypeDef,
  dt: number,
  world: SimWorld,
): void {
  const speed = creep.slowTimer > 0 ? def.speed * 0.8 : def.speed;
  const dir = V.sub(targetPos, creep.pos);
  const dist = V.length(dir);
  if (dist < 1e-3) return;
  const unitDir = V.scale(dir, 1 / dist);
  const next = V.add(creep.pos, V.scale(unitDir, Math.min(speed * dt, dist)));
  if (sphereHitsObstacle(world, next, def.bodyRadius)) return;
  const { gx, gz } = world.navGrid.worldToGrid(next.x, next.z);
  if (!world.navGrid.isWalkable(gx, gz)) return;
  creep.pos = next;
  creep.facing = V.heading(unitDir);
}

function fireCreepProjectile(
  state: MatchState,
  creep: CreepState,
  def: CreepTypeDef,
  target: HeroState,
  events: SimEvent[],
): void {
  // Aim at the target's position at fire time — straight flight at a speed
  // below ARROW.speed makes the fireball sidesteppable. Fireballs announce
  // themselves on the wire via the same `fire` event as hero arrows.
  const dir = V.normalize(V.sub(target.pos, creep.pos));
  spawnProjectile(state, events, {
    ownerId: creep.id,
    ownerKind: 'creep',
    team: -1,
    pos: V.add(creep.pos, V.scale(dir, def.bodyRadius)),
    dir,
    speed: def.projectileSpeed!,
    maxRange: def.attackRange * (def.projectileRangeSlack ?? 1),
    traveled: 0,
    damage: creepDamage(creep.type, creep.level),
  });
}

function respawnCreep(state: MatchState, creep: CreepState, events: SimEvent[]): void {
  creep.level = Math.min(creep.level + 1, CREEP.maxLevel);
  creep.hp = creepMaxHp(creep.type, creep.level);
  creep.alive = true;
  creep.respawnTimer = 0;
  creep.pos = V.clone(creep.spawnPos);
  creep.aggroTargetId = null;
  creep.attackCooldown = 0;
  creep.slowTimer = 0;
  creep.lastActiveTick = state.tick;
  events.push({ type: 'creepRespawn', creepId: creep.id, level: creep.level });
}

// ── Damage ────────────────────────────────────────────────────────────

/**
 * Creep → hero damage (melee swings and fireball impacts). Thin wrapper
 * over `dealDamageToHero` — the unified function handles the guard, clamp,
 * hit event, killHero, and kill-credit gating.
 */
export function applyCreepDamageToHero(
  state: MatchState,
  target: HeroState,
  amount: number,
  creep: CreepState,
  projectileId: string,
  events: SimEvent[],
): void {
  dealDamageToHero(state, target, { kind: 'creep', creep }, amount, projectileId, events);
}

/**
 * Hero → creep damage (arrows). Thin wrapper over `dealDamageToCreep`.
 */
export function applyCreepDamage(
  state: MatchState,
  creep: CreepState,
  source: HeroState,
  damage: number,
  events: SimEvent[],
  crit = false,
): void {
  dealDamageToCreep(state, creep, { kind: 'hero', hero: source }, damage, events, crit);
}

// ── Projectile collision helpers (called from stepProjectiles) ────────

/** First live creep the projectile overlaps (2D), or null. */
export function hitCreep(state: MatchState, p: ProjectileState): CreepState | null {
  for (const creep of state.creeps) {
    if (!creep.alive) continue;
    const hitRadius = CREEP_TYPES[creep.type].bodyRadius + ARROW.collisionRadius;
    if (V.distanceSq(p.pos, creep.pos) < hitRadius * hitRadius) return creep;
  }
  return null;
}
