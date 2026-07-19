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
  campComposition,
  campPoolSize,
  campTierLevel,
  creepDamage,
  creepGold,
  creepMaxHp,
  creepXp,
} from './creepRules';
import * as V from './math';
import { ARROW } from './rules';
import { CampState, CreepState, HeroState, MatchState, ProjectileState, SimEvent } from './state';
import { addXp, killHero, dealDamageToHero, dealDamageToCreep, stepBurn } from './damage';
import { spawnProjectile } from './projectiles';
import { findReachableNear, findWalkableNear, SimWorld } from './world';
import { followPath, computePath } from './movement';

// ── Camp construction ─────────────────────────────────────────────────

export function createCreep(
  id: string,
  campId: string,
  type: CreepTypeId,
  pos: V.Vec2,
  opts: { alive?: boolean; level?: number } = {},
): CreepState {
  const level = opts.level ?? 1;
  return {
    id,
    campId,
    type,
    pos: V.clone(pos),
    facing: 0,
    spawnPos: V.clone(pos),
    hp: creepMaxHp(type, level),
    level,
    alive: opts.alive ?? true,
    respawnTimer: 0,
    aggroTargetId: null,
    attackCooldown: 0,
    path: [],
    lastActiveTick: 0,
    slowTimer: 0,
    burnRemaining: 0,
    burnDps: 0,
    burnSourceId: null,
    burnTickAccum: 0,
    leashing: false,
  };
}

/**
 * Build one camp's creeps and its `CampState`, appending both to `state`.
 * A camp reserves a fixed pool (`campPoolSize` = base + `maxExtraUnits`) so
 * creep ids stay stable for the whole match even as higher tiers field more
 * units: the tier-0 (base) slots start alive at their authored positions, the
 * extra slots start dead and are activated when the camp climbs a tier.
 * Returns the tier-0 (alive) creeps in slot order.
 */
export function buildCamp(
  state: MatchState,
  world: SimWorld,
  campId: string,
  base: readonly CreepTypeId[],
  center: V.Vec2,
  startId: number,
): CreepState[] {
  const pool = campPoolSize(base);
  const level = campTierLevel(0);
  const tier0 = campComposition(base, 0); // == base (0 upgrade steps, 0 extra)
  const created: CreepState[] = [];
  for (let i = 0; i < pool; i++) {
    // Spread the units along one row, centred on the BASE units so tier-0
    // positions are unaffected by the reserved extra slots (which trail off to
    // one side, used only at higher tiers).
    const offsetX = (i - (base.length - 1) / 2) * CREEP.spawnSpread;
    const pos = findWalkableNear(world, center.x + offsetX, center.z);
    const alive = i < tier0.length;
    const type = alive ? tier0[i] : base[Math.min(i, base.length - 1)];
    const creep = createCreep(`c${startId + i}`, campId, type, pos, { alive, level });
    state.creeps.push(creep);
    if (alive) created.push(creep);
  }
  state.camps.push({ id: campId, base: [...base], tier: 0, respawnTimer: -1 });
  return created;
}

/**
 * Populate `state.creeps` and `state.camps` from camp definitions. By default
 * camps come from `CAMP_DEFS` (centers as fractions of the arena rect, so the
 * same defs work on every built-in map); custom maps pass their authored
 * world-coordinate placements instead. Centers are snapped to the walkable
 * component reachable from the shop so a camp never lands on a cliff top or
 * islet. Ids (`c1`, `c2`, …) follow definition + pool order, so every peer
 * derives the same ids independently.
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
    const center =
      findReachableNear(world, def.x, def.z, world.shops[0].pos.x, world.shops[0].pos.z) ??
      findWalkableNear(world, def.x, def.z);
    buildCamp(state, world, def.id, def.units, center, nextId);
    nextId += campPoolSize(def.units);
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

    // Dead creeps wait for their whole camp to be cleared; camp-level respawn
    // (below) brings them all back together, one tier stronger.
    if (!creep.alive) continue;

    if (creep.attackCooldown > 0) {
      creep.attackCooldown = Math.max(0, creep.attackCooldown - dt);
    }

    if (creep.slowTimer > 0) {
      creep.slowTimer = Math.max(0, creep.slowTimer - dt);
    }

    // Fire Bow burn: damage over time credited to the burning hero. May kill
    // the creep — bail out of the rest of its step if so.
    if (creep.burnRemaining > 0) {
      const src = state.heroes.find((h) => h.id === creep.burnSourceId);
      if (src) {
        stepBurn(creep, dt, (dmg) =>
          dealDamageToCreep(state, creep, { kind: 'hero', hero: src }, dmg, events),
        );
      } else {
        creep.burnRemaining = 0;
      }
      if (!creep.alive) continue;
    }

    // Acquire aggro. Idle scans are throttled and staggered by creep index so
    // a full camp never scans on the same tick. A leashing creep won't
    // re-aggro until it's home again (prevents oscillation at the leash edge).
    if (creep.aggroTargetId === null && !creep.leashing && state.tick % CREEP.aggroScanEvery === i % CREEP.aggroScanEvery) {
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
      const leashed = V.distanceSq(creep.pos, creep.spawnPos) > CREEP.leashRange * CREEP.leashRange;
      if (!target || !target.alive || target.invulnerable || target.invisTimer > 0 || leashed) {
        creep.aggroTargetId = null;
        // Dragged past the leash → commit to walking home before re-aggroing.
        if (leashed) creep.leashing = true;
        target = null;
      }
    }

    if (target) {
      const dist = V.distance(creep.pos, target.pos);
      if (dist > def.attackRange) {
        // Chase with real pathfinding so cliffs/water are routed around, not
        // walked into. Re-path as the hero drifts (throttled per creep).
        moveCreepTo(creep, target.pos, def, dt, world, state.tick, i);
        creep.lastActiveTick = state.tick;
      } else {
        // In range: stop, face the target, swing/shoot when off cooldown.
        creep.path.length = 0;
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
      moveCreepTo(creep, creep.spawnPos, def, dt, world, state.tick, i);
      creep.lastActiveTick = state.tick;
    } else {
      // At home (within arriveEpsilon): settle in one shot — snap to spawn,
      // heal to full, drop the leash lock, clear the path. An at-rest creep is
      // then always "at spawn, full hp" (the invariant behind snapshot
      // idle-omission); once settled this does nothing, so it stays silent.
      const settled =
        creep.pos.x === creep.spawnPos.x &&
        creep.pos.z === creep.spawnPos.z &&
        creep.hp === creepMaxHp(creep.type, creep.level) &&
        !creep.leashing &&
        creep.path.length === 0;
      if (!settled) {
        creep.pos = V.clone(creep.spawnPos);
        creep.hp = creepMaxHp(creep.type, creep.level);
        creep.leashing = false;
        creep.path.length = 0;
        creep.lastActiveTick = state.tick;
      }
    }
  }

  stepCamps(state, dt, world, events);
}

/**
 * Per-camp tier progression. A camp with any living member is not respawning;
 * once every member is dead a `respawnInterval` countdown starts, and on expiry
 * the camp climbs one tier and its whole roster comes back stronger (see
 * `respawnCamp`). Keeping the timer at the camp level is what makes "clear the
 * camp → it returns as a tougher pack" work.
 */
function stepCamps(state: MatchState, dt: number, world: SimWorld, events: SimEvent[]): void {
  for (const camp of state.camps) {
    const anyAlive = state.creeps.some((c) => c.campId === camp.id && c.alive);
    if (anyAlive) {
      camp.respawnTimer = -1;
      continue;
    }
    if (camp.respawnTimer < 0) camp.respawnTimer = CREEP.respawnInterval;
    camp.respawnTimer -= dt;
    if (camp.respawnTimer <= 0) respawnCamp(state, camp, events);
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
 * Move a creep toward `goal` along an A*-smoothed path — the same pathfinder
 * heroes use — so it routes around cliffs, water, and doodads instead of
 * walking into them. The path is recomputed when it's empty, or when the goal
 * has drifted past `repathThreshold` (throttled to this creep's stagger slot so
 * a whole camp's re-paths don't land on one tick). `tick`/`index` drive that
 * stagger. Follows waypoints like `moveAlongPath` does for heroes.
 */
function moveCreepTo(
  creep: CreepState,
  goal: V.Vec2,
  def: CreepTypeDef,
  dt: number,
  world: SimWorld,
  tick: number,
  index: number,
): void {
  const end = creep.path.length > 0 ? creep.path[creep.path.length - 1] : null;
  const drifted = !end || V.distanceSq(goal, end) > CREEP.repathThreshold * CREEP.repathThreshold;
  const mayRepath = tick % CREEP.repathEvery === index % CREEP.repathEvery;
  if (creep.path.length === 0 || (drifted && mayRepath)) {
    repathCreep(creep, goal, world);
  }

  if (!creep.path[0]) return; // unreachable this tick; try again next stagger slot
  const speed = creep.slowTimer > 0 ? def.speed * 0.8 : def.speed;
  followPath(creep, dt, { speed, arriveEpsilon: CREEP.arriveEpsilon, facingMode: 'snap' });
}

/** (Re)compute a creep's path to `goal`, snapping to reachable ground if the
 *  exact goal is unwalkable — the same `computePath` heroes use. */
function repathCreep(creep: CreepState, goal: V.Vec2, world: SimWorld): void {
  creep.path = computePath(world, creep.pos, goal);
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

/**
 * Respawn a cleared camp one tier stronger. `campComposition` decides the new
 * roster (upgraded types, possibly more units); every unit shares
 * `campTierLevel(tier)`, which raises hp/damage and gold/xp via the `creep*`
 * curves. The camp's fixed creep pool is reused slot-for-slot — a slot the new
 * tier doesn't field simply stays dead — so ids remain stable and each
 * activated slot announces its (possibly changed) type via `creepRespawn`.
 */
function respawnCamp(state: MatchState, camp: CampState, events: SimEvent[]): void {
  camp.tier += 1;
  camp.respawnTimer = -1;
  const level = campTierLevel(camp.tier);
  const comp = campComposition(camp.base, camp.tier);
  const members = state.creeps.filter((c) => c.campId === camp.id); // slot (id) order
  for (let i = 0; i < members.length; i++) {
    if (i >= comp.length) break; // remaining slots stay dead this tier
    const creep = members[i];
    creep.type = comp[i];
    creep.level = level;
    creep.hp = creepMaxHp(creep.type, level);
    creep.alive = true;
    // Extra slots that have never been active still sit at their reserved
    // spread position; re-snap to it and clear combat state.
    creep.pos = V.clone(creep.spawnPos);
    creep.facing = 0;
    creep.aggroTargetId = null;
    creep.attackCooldown = 0;
    creep.slowTimer = 0;
    creep.burnRemaining = 0;
    creep.burnDps = 0;
    creep.burnSourceId = null;
    creep.burnTickAccum = 0;
    creep.leashing = false;
    creep.path = [];
    creep.lastActiveTick = state.tick;
    events.push({ type: 'creepRespawn', creepId: creep.id, creepType: creep.type, level });
  }
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
