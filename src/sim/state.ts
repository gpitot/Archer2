/**
 * Plain-data simulation state. Every field is JSON-serialisable so a whole
 * `MatchState` (or a per-entity slice) can be sent over the wire as a snapshot.
 * No behaviour lives here — the logic is in `stepMatch`.
 */
import { CreepTypeId } from './creepRules';
import { RuneTypeId } from './runeRules';
import { Vec2 } from './math';
import { HERO } from './rules';
import { createAbilityRuntimes, type AbilityId } from './abilities';

/** Six inventory slots holding item ids (null = empty). */
export type Inventory = (string | null)[];

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
  /** True while the ability's active window is open (e.g. dodge). */
  active?: boolean;
  /** Seconds left in the active window. */
  activeTimer?: number;
}

export interface HeroState {
  id: string;
  team: number;
  pos: Vec2;
  /** Smoothed facing yaw (radians). */
  facing: number;
  /** Facing the hero is turning toward. */
  targetFacing: number;
  /** Remaining path waypoints (world-space cell centers), first = next target. */
  path: Vec2[];
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
   */
  kind?: 'scout';
  team: number;
  pos: Vec2;
  dir: Vec2;
  speed: number;
  maxRange: number;
  traveled: number;
  damage: number;
}

export interface WardState {
  id: string;
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
export interface CreepState {
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
}

export interface MatchState {
  tick: number;
  heroes: HeroState[];
  projectiles: ProjectileState[];
  wards: WardState[];
  blasts: BlastState[];
  creeps: CreepState[];
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
  | { type: 'ward'; x?: number; z?: number }
  | { type: 'blink'; x: number; z: number }
  | { type: 'buy'; itemIndex: number }
  | { type: 'useItem'; slot: number }
  | { type: 'levelAbility'; ability: AbilityId };

/** A command tagged with the hero it applies to, queued for the next tick. */
export interface HeroInput {
  heroId: string;
  cmd: Command;
}

// ── Events (sim → clients) ────────────────────────────────────────────
export type SimEvent =
  | { type: 'hit'; targetId: string; sourceId: string; projectileId: string; damage: number; x: number; z: number; crit?: boolean }
  | { type: 'kill'; sourceId: string; victimId: string; gold?: number }
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
  | { type: 'creepRespawn'; creepId: string; level: number }
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
    hp: HERO.maxHp,
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
    runes: [],
    firstBlood: true,
    incomeAccumulator: 0,
    nextProjectileId: 1,
    nextWardId: 1,
    nextBlastId: 1,
  };
}
