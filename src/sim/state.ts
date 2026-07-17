/**
 * Plain-data simulation state. Every field is JSON-serialisable so a whole
 * `MatchState` (or a per-entity slice) can be sent over the wire as a snapshot.
 * No behaviour lives here — the logic is in `stepMatch`.
 */
import { CreepTypeId } from './creepRules';
import { Vec2 } from './math';
import { HERO, ARROW } from './rules';

/** Six inventory slots holding item ids (null = empty). */
export type Inventory = (string | null)[];

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
  dodgeActive: boolean;
  dodgeTimer: number;
  dodgeCooldown: number;
  dodgeLevel: number;
  revealLevel: number;
  blastLevel: number;
  blinkCooldown: number;
  blastCooldown: number;
  inventory: Inventory;
  wardCharges: number;
  abilityLevel: number;
  abilityCooldown: number;
  abilityCharges: number;
  abilityRecoilTimer: number;
}

export interface ProjectileState {
  id: string;
  ownerId: string;
  /** Absent = hero-owned. Creep fireballs skip the hero kill-credit path. */
  ownerKind?: 'creep';
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
}

export interface MatchState {
  tick: number;
  heroes: HeroState[];
  projectiles: ProjectileState[];
  wards: WardState[];
  blasts: BlastState[];
  creeps: CreepState[];
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
  | { type: 'fire'; aimX: number; aimZ: number }
  | { type: 'ward'; x?: number; z?: number }
  | { type: 'blink'; x: number; z: number }
  | { type: 'buy'; itemIndex: number }
  | { type: 'useItem'; slot: number }
  | { type: 'levelAbility'; ability: 'arrow' | 'dodge' | 'reveal' | 'blast' }
  | { type: 'dodge' }
  | { type: 'blast'; x: number; z: number };

/** A command tagged with the hero it applies to, queued for the next tick. */
export interface HeroInput {
  heroId: string;
  cmd: Command;
}

// ── Events (sim → clients) ────────────────────────────────────────────
export type SimEvent =
  | { type: 'hit'; targetId: string; sourceId: string; projectileId: string; damage: number; x: number; z: number }
  | { type: 'kill'; sourceId: string; victimId: string }
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
  | { type: 'creepHit'; creepId: string; sourceId: string; damage: number; x: number; z: number }
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
  | { type: 'creepRespawn'; creepId: string; level: number };

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
    skillPoints: 1,
    gold: 0,
    kills: 0,
    deaths: 0,
    killStreak: 0,
    multiKillCount: 0,
    multiKillTimer: 0,
    speedBonus: 0,
    inventory: [null, null, null, null, null, null],
    wardCharges: 0,
    // Q starts pre-learned at rank 1 (special case — it's the basic attack).
    abilityLevel: 1,
    abilityCooldown: 0,
    abilityCharges: ARROW.maxCharges,
    abilityRecoilTimer: 0,
    dodgeActive: false,
    dodgeTimer: 0,
    dodgeCooldown: 0,
    dodgeLevel: 0,
    revealLevel: 0,
    blastLevel: 0,
    blinkCooldown: 0,
    blastCooldown: 0,
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
    firstBlood: true,
    incomeAccumulator: 0,
    nextProjectileId: 1,
    nextWardId: 1,
    nextBlastId: 1,
  };
}
