/**
 * Plain-data simulation state. Every field is JSON-serialisable so a whole
 * `MatchState` (or a per-entity slice) can be sent over the wire as a snapshot.
 * No behaviour lives here — the logic is in `stepMatch`.
 */
import { CreepTypeId } from './creepRules';
import { RuneTypeId } from './runeRules';
import { Vec2 } from './math';
import { HERO, maxHpForLevel } from './rules';
import { createAbilityRuntimes, type AbilityId } from './abilities';

/** Six inventory slots holding item ids (null = empty). */
export type Inventory = (string | null)[];

// ── Unit substrate ───────────────────────────────────────────────────

/**
 * Shared base for every in-game unit (hero or creep). Fields that both
 * types carry verbatim live here so damage and movement helpers can be
 * written once against this interface.
 *
 * To add a new unit type:
 *   1. Define its state interface, extending `UnitCore`.
 *   2. Add a per-type array to `MatchState` and factory + step functions.
 *   3. Keep per-type arrays separate (heroes[], creeps[], …) — never merge
 *      them into one generic list (iteration-order determinism).
 */
export interface UnitCore {
  id: string;
  pos: Vec2;
  facing: number;
  hp: number;
  alive: boolean;
  respawnTimer: number;
  level: number;
  /** Remaining path waypoints (world-space cell centers), first = next target.
   *  Sim-internal — never sent over the wire. Followed by `followPath`. */
  path: Vec2[];

  // ── Status effects (see statusEffects.ts) ───────────────────────────
  // These live on the substrate, not on HeroState, because a stun or a
  // displacement means the same thing whoever it lands on — one set of
  // helpers then drives both heroes and creeps.

  /**
   * Seconds left on a stun (0 = not stunned). A stunned unit cannot move,
   * cast, or attack; its cooldowns keep ticking. Applied via `applyStun`.
   */
  stunTimer: number;
  /**
   * Scripted displacement (the Grappling Arrow yank): seconds left in the
   * pull, 0 = none. While it runs the unit can't walk and its position is a
   * straight lerp from `pullFrom` to `pullTo` — the same for the grappler
   * reeling themselves to a wall and for a victim dragged in by the hook.
   */
  pullTimer: number;
  /** Total duration of the active pull, for the lerp denominator. */
  pullDuration: number;
  /** Where the pull started. */
  pullFrom?: Vec2;
  /** Where the pull ends (already snapped to walkable ground). */
  pullTo?: Vec2;
}

/**
 * Per-ability mutable state. One record entry per registered ability —
 * adding a spell adds a key here automatically (via `createAbilityRuntimes`)
 * instead of a hand-threaded set of HeroState fields.
 */
export interface AbilityRuntime {
  /** Current rank (0 = unlearned). */
  level: number;
  /** Seconds until ready (doubles as the recharge timer for charge abilities). */
  cooldown: number;
  /** Charges in the magazine (charge abilities only). */
  charges?: number;
  /** Minimum delay between consecutive casts (charge abilities only). */
  recoil?: number;
  /**
   * Seconds left in the pre-fire cast point (0/undefined = not winding up).
   * The shot looses when this reaches 0; a fresh order clears it (see
   * `cancelArrowWindup`). Arrow only.
   */
  windup?: number;
  /** Aim point captured at cast; the wind-up looses toward it. Arrow only. */
  windupAim?: Vec2;
  /** True while the ability's active window is open (e.g. dodge). */
  active?: boolean;
  /** Seconds left in the active window. */
  activeTimer?: number;
}

export interface HeroState extends UnitCore {
  id: string;
  team: number;
  pos: Vec2;
  /** Smoothed facing yaw (radians). */
  facing: number;
  /** Facing the hero is turning toward. */
  targetFacing: number;
  moving: boolean;

  // Health / life-cycle
  hp: number;
  alive: boolean;
  invulnerable: boolean;
  invulnerableTimer: number;
  respawnTimer: number;

  // Progression
  xp: number;
  level: number;
  skillPoints: number;

  // Economy & score
  gold: number;
  kills: number;
  deaths: number;
  killStreak: number;
  multiKillCount: number;
  multiKillTimer: number;

  // Items / abilities
  speedBonus: number;
  /** Permanent bonus HP from consumed tomes (survives death). */
  bonusHp: number;
  /** Permanent bonus damage from consumed tomes. */
  bonusDamage: number;
  /** Chance (0–1) for any ability to deal double damage. */
  critChance: number;
  /** Per-ability rank/cooldown/charge state, keyed in ABILITY_ORDER. */
  abilities: Record<AbilityId, AbilityRuntime>;
  /** Active-item cooldowns keyed by item id (e.g. blink_dagger). */
  itemCooldowns: Record<string, number>;
  inventory: Inventory;
  wardCharges: number;
  /** Rune buff timers (seconds remaining; 0 = inactive). */
  ddTimer: number;
  hasteTimer: number;
  invisTimer: number;
  slowTimer: number;
  /** Fire Bow burn: total damage still owed (stacks across hits); 0 = none. Sim-only. */
  burnRemaining: number;
  /** Rate the burn pool drains at (damage/sec), re-timed on each stacking hit. */
  burnDps: number;
  /** Hero credited with burn damage (kill attribution), or null. */
  burnSourceId: string | null;
  /** Accumulates elapsed time toward the next discrete burn damage tick. */
  burnTickAccum: number;
  /** Blink Dagger cast delay timer (seconds; 0 = not casting). */
  blinkCastTimer: number;
  /** Where to teleport when the cast delay expires. */
  blinkTarget?: Vec2;
}

export interface ProjectileState {
  id: string;
  ownerId: string;
  /** Absent = hero-owned. Creep fireballs skip the hero kill-credit path. */
  ownerKind?: 'creep';
  /**
   * Absent = damaging arrow. 'scout' = the E vision projectile: no damage,
   * no collision (flies over obstacles and units), grants fog vision around
   * itself to the owner's team, and is always visible to enemies.
   * 'grapple' = the Grappling Arrow hook: no damage, dies on the first
   * obstacle or hero it touches and pulls someone as it does.
   */
  kind?: 'scout' | 'grapple';
  /** Scout only: fog reveal radius around the projectile (per caster's E rank). */
  sightRadius?: number;
  team: number;
  pos: Vec2;
  dir: Vec2;
  speed: number;
  maxRange: number;
  traveled: number;
  damage: number;
  /**
   * Ids of units this projectile has already damaged. Hero arrows pierce —
   * they keep flying and hit every enemy along the path once (matching the
   * original), tracked here so a unit isn't re-hit each tick it overlaps.
   */
  hitIds?: string[];
  /**
   * How many creeps this projectile has already pierced. Drives
   * `ARROW.creepPierceFalloff`; counted apart from `hitIds`, which also holds
   * hero ids and so can't index the falloff table.
   */
  creepHits?: number;
}

export interface WardState {
  id: string;
  ownerId: string;
  team: number;
  pos: Vec2;
  life: number;
}

/** A pending R-spell blast zone — visible to everyone, detonates when timer hits 0. */
export interface BlastState {
  id: string;
  ownerId: string;
  team: number;
  pos: Vec2;
  /** Seconds until detonation. */
  timer: number;
  /** Damage locked in at cast time (from the caster's R rank). */
  damage: number;
}

/**
 * A power-up rune spot. One `RuneState` per spot, alive for the whole match
 * (ids are stable, like creeps): `active` toggles as the rune is taken and
 * respawns, `type` re-rolls on every respawn.
 */
export interface RuneState {
  id: string;
  pos: Vec2;
  type: RuneTypeId;
  /** True while a rune is sitting on the spot, ready to be picked up. */
  active: boolean;
  /** Seconds until the next rune appears (only meaningful while inactive). */
  respawnTimer: number;
}

/** A neutral jungle creep. Ids are stable for the whole match. */
export interface CreepState extends UnitCore {
  id: string;
  campId: string;
  type: CreepTypeId;
  pos: Vec2;
  facing: number;
  /** Camp position — leash anchor and respawn point. */
  spawnPos: Vec2;
  /** Max HP is derived: `creepMaxHp(type, level)`. */
  hp: number;
  level: number;
  alive: boolean;
  respawnTimer: number;
  aggroTargetId: string | null;
  attackCooldown: number;
  /** Last tick this creep moved/fought/changed — drives snapshot idle-omission. */
  lastActiveTick: number;
  /** Slow debuff timer from Ice Bow (seconds remaining; 0 = inactive). */
  slowTimer: number;
  /** Fire Bow burn: total damage still owed (stacks across hits); 0 = none. Sim-only. */
  burnRemaining: number;
  /** Rate the burn pool drains at (damage/sec), re-timed on each stacking hit. */
  burnDps: number;
  /** Hero credited with burn damage (kill attribution), or null. */
  burnSourceId: string | null;
  /** Accumulates elapsed time toward the next discrete burn damage tick. */
  burnTickAccum: number;
  /**
   * True while returning home after crossing the leash — suppresses re-aggro so
   * a creep dragged to its leash edge walks all the way back instead of
   * oscillating at the boundary. Cleared on arrival home or on being attacked.
   */
  leashing: boolean;
}

/**
 * Per-camp progression state. A camp climbs one `tier` each time it is fully
 * cleared and respawns (see `stepCreeps`); `respawnTimer` counts down only
 * while every member is dead. Sim-internal — never sent over the wire; the
 * realized creeps (type/level via `creepRespawn` events) carry everything a
 * client needs to render the current tier.
 */
export interface CampState {
  id: string;
  /** Base composition (tier 0) — the ladder `campComposition` climbs from. */
  base: CreepTypeId[];
  tier: number;
  /** Seconds until respawn; -1 while any member is still alive. */
  respawnTimer: number;
}

export interface MatchState {
  tick: number;
  heroes: HeroState[];
  projectiles: ProjectileState[];
  wards: WardState[];
  blasts: BlastState[];
  creeps: CreepState[];
  camps: CampState[];
  runes: RuneState[];
  /** First blood is a one-time global bonus. */
  firstBlood: boolean;
  /** Accumulates real time toward the next per-second passive-income tick. */
  incomeAccumulator: number;
  nextProjectileId: number;
  nextWardId: number;
  nextBlastId: number;
}

// ── Commands (client → sim) ───────────────────────────────────────────
export type Command =
  | { type: 'moveTo'; x: number; z: number }
  /** Cast any registered ability; (x, z) is the aim/target point when the ability takes one. */
  | { type: 'cast'; ability: AbilityId; x?: number; z?: number }
  | { type: 'buy'; shopIndex: number; itemIndex: number }
  /** Use the item in the given inventory slot. For point-targeted items (blink, wards),
   *  (x, z) is the ground target; omit to self-cast (wards at hero position). */
  | { type: 'useItem'; slot: number; x?: number; z?: number }
  | { type: 'levelAbility'; ability: AbilityId };

/** A command tagged with the hero it applies to, queued for the next tick. */
export interface HeroInput {
  heroId: string;
  cmd: Command;
}

// ── Events (sim → clients) ────────────────────────────────────────────
export type SimEvent =
  | { type: 'hit'; targetId: string; sourceId: string; projectileId: string; damage: number; x: number; z: number; crit?: boolean }
  | { type: 'kill'; sourceId: string; victimId: string; gold?: number;
      /** True when this kill was the match's first blood. */
      firstBlood?: boolean;
      /** Killer's kill streak after this kill (drives streak announcements). */
      streak?: number;
      /** Killer's multi-kill chain count after this kill (2 = double, 3+ = triple). */
      multiKill?: number }
  | { type: 'respawn'; heroId: string }
  /**
   * Carries the full initial projectile state plus the tick it spawned on.
   * Projectiles fly deterministically (straight line, constant speed), so
   * this event is the only wire copy — snapshots don't re-send them.
   */
  | { type: 'fire'; heroId: string; tick: number; projectile: ProjectileState }
  | { type: 'blastExplode'; blastId: string; ownerId: string; x: number; z: number }
  | { type: 'purchase'; heroId: string; itemId: string }
  | { type: 'levelUp'; heroId: string; level: number }
  | { type: 'creepHit'; creepId: string; sourceId: string; damage: number; x: number; z: number; crit?: boolean }
  | {
      type: 'creepKill';
      creepId: string;
      campId: string;
      killerId: string;
      gold: number;
      xp: number;
      x: number;
      z: number;
    }
  | { type: 'creepRespawn'; creepId: string; creepType: CreepTypeId; level: number }
  | { type: 'runeSpawn'; runeId: string; runeType: RuneTypeId }
  | { type: 'runePickup'; runeId: string; heroId: string; runeType: RuneTypeId; x: number; z: number };

// ── Factories ─────────────────────────────────────────────────────────
export function createHeroState(id: string, team: number, pos: Vec2): HeroState {
  return {
    id,
    team,
    pos: { x: pos.x, z: pos.z },
    facing: 0,
    targetFacing: 0,
    path: [],
    moving: false,
    hp: maxHpForLevel(1),
    alive: true,
    invulnerable: false,
    invulnerableTimer: 0,
    respawnTimer: 0,
    xp: 0,
    level: 1,
    skillPoints: 0,
    gold: 0,
    kills: 0,
    deaths: 0,
    killStreak: 0,
    multiKillCount: 0,
    multiKillTimer: 0,
    speedBonus: 0,
    bonusHp: 0,
    bonusDamage: 0,
    critChance: 0,
    // Built in ABILITY_ORDER so key iteration is identical on every peer.
    // The level-1 skill point is auto-spent on Q (it's the basic attack), so
    // heroes start with Q rank 1 and 0 banked points — next point at level 2.
    abilities: createAbilityRuntimes(),
    itemCooldowns: {},
    inventory: [null, null, null, null, null, null],
    wardCharges: 0,
    ddTimer: 0,
    hasteTimer: 0,
    invisTimer: 0,
    slowTimer: 0,
    burnRemaining: 0,
    burnDps: 0,
    burnSourceId: null,
    burnTickAccum: 0,
    blinkCastTimer: 0,
    stunTimer: 0,
    pullTimer: 0,
    pullDuration: 0,
  };
}

export function createMatchState(): MatchState {
  return {
    tick: 0,
    heroes: [],
    projectiles: [],
    wards: [],
    blasts: [],
    creeps: [],
    camps: [],
    runes: [],
    firstBlood: true,
    incomeAccumulator: 0,
    nextProjectileId: 1,
    nextWardId: 1,
    nextBlastId: 1,
  };
}
