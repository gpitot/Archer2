/**
 * WebSocket message types shared by client and server.
 *
 * All messages are JSON with a `type` discriminator. The `cmd` field inside
 * `InputMessage` reuses the `Command` union from `state.ts` so the same types
 * drive both local prediction and network commands.
 *
 * A room starts in a lobby: `join` gets you a `welcome` with the roster but no
 * world, `roster` tracks who's present and ready, and `matchStart` delivers the
 * world once someone starts the game. Joining a room that's already playing
 * skips the lobby — the `welcome` carries the same `MatchInit` payload that
 * `matchStart` would have.
 *
 * v2: heroes are split across two messages so per-tick snapshots stay small.
 *  - `snapshot` (every SNAPSHOT_EVERY-th tick): the "hot" fields —
 *    pos/facing/hp/alive/moving — plus wards and any sim events since the
 *    previous snapshot. Projectiles are NOT re-sent per snapshot: they fly
 *    deterministically, so the `fire` event carries their full initial state
 *    and clients simulate the flight (welcome snapshots still include
 *    in-flight projectiles for late joiners).
 *  - `heroMeta` (low rate + on meta-changing events): the "cold" fields —
 *    economy, progression, inventory — which change rarely.
 * Values are quantized server-side before serialization.
 */
import { AbilityRuntime, Command, GameMode, Inventory, ProjectileState, WardState, BlastState, SimEvent } from './state';
import type { AbilityId } from './abilities';
import { CreepTypeId } from './creepRules';
import { BuildingTypeId } from './buildingRules';
import { RuneTypeId } from './runeRules';
import { Vec2 } from './math';
import type { AiDifficulty } from './ai/AiController';

// ── Client → Server ──────────────────────────────────────────────────

export interface JoinMessage {
  type: 'join';
  name: string;
  /**
   * Map the client wants to play on ('arena' when absent). The first join
   * decides the room's map; later joins with a different map are rejected.
   */
  map?: string;
  /**
   * Game mode ('ffa' when absent). The first join decides the room's mode;
   * later joiners simply adopt it (the welcome tells them which it is).
   */
  mode?: string;
  /**
   * How many of the map's creep camps to enable, 1–4 (all when absent or out
   * of range — see `resolveCampCount`). First join decides, like the mode.
   */
  campCount?: number;
}

export interface InputMessage {
  type: 'input';
  /** Monotonic sequence number so the server can detect gaps. */
  seq: number;
  cmd: Command;
}

/** Change display name (lobby or mid-match); server re-sanitizes. */
export interface SetNameMessage {
  type: 'setName';
  name: string;
}

/** Toggle lobby ready state. Ignored once the match is running. */
export interface SetReadyMessage {
  type: 'setReady';
  ready: boolean;
}

/** Any player may start the match once everyone in the lobby is ready. */
export interface StartGameMessage {
  type: 'startGame';
}

/** Add an AI bot to the lobby at the given difficulty. Ignored mid-match. */
export interface AddBotMessage {
  type: 'addBot';
  difficulty: AiDifficulty;
}

/** Remove a previously added AI bot by its player id. Ignored mid-match. */
export interface RemoveBotMessage {
  type: 'removeBot';
  playerId: string;
}

export type ClientMessage =
  | JoinMessage
  | InputMessage
  | SetNameMessage
  | SetReadyMessage
  | StartGameMessage
  | AddBotMessage
  | RemoveBotMessage;

// ── Lobby ────────────────────────────────────────────────────────────

export type RoomPhase = 'lobby' | 'playing';

/** One row of the lobby roster. Also the client's source of display names. */
export interface LobbyPlayer {
  playerId: string;
  name: string;
  ready: boolean;
  team: number;
  /** True for AI bots (no socket); they are always ready and server-driven. */
  isBot?: boolean;
  /** Present for bots — the difficulty preset the server runs them at. */
  difficulty?: AiDifficulty;
}

// ── Wire hero representations ────────────────────────────────────────

/** Per-tick hero fields: what interpolation and combat feedback need. */
export interface SnapshotHero {
  id: string;
  team: number;
  pos: Vec2;
  facing: number;
  hp: number;
  alive: boolean;
  moving: boolean;
  /**
   * Final path waypoint, present while moving. The client re-derives the
   * full path locally (same NavGrid) when snap reconciliation needs one —
   * shipping every waypoint each tick isn't worth the bytes.
   */
  dest?: Vec2;
  /** Blink Dagger cast delay timer (0 = not casting). */
  blinkCastTimer: number;
  /**
   * Grappling Arrow yank, sent only while one is running (0/absent = none).
   * The client replays the same lerp locally, so a pulled hero slides on
   * every peer instead of being snapped by reconciliation.
   */
  pullTimer?: number;
  pullDuration?: number;
  pullFrom?: Vec2;
  pullTo?: Vec2;
  /** Seconds left on a stun, sent only while one is running (0/absent = none). */
  stunTimer?: number;
}

/** Low-rate hero fields: progression, economy, and timers. */
export interface HeroMeta {
  id: string;
  invulnerable: boolean;
  invulnerableTimer: number;
  respawnTimer: number;
  xp: number;
  level: number;
  skillPoints: number;
  gold: number;
  kills: number;
  deaths: number;
  killStreak: number;
  multiKillCount: number;
  multiKillTimer: number;
  speedBonus: number;
  bonusHp: number;
  bonusDamage: number;
  critChance: number;
  inventory: Inventory;
  wardCharges: number;
  /** Rune buff timers (seconds remaining; 0 = inactive). */
  ddTimer: number;
  hasteTimer: number;
  invisTimer: number;
  /** Slow debuff timer from Ice Bow (seconds remaining; 0 = inactive). */
  slowTimer: number;
  /** Per-ability rank/cooldown/charge state — mirrors `HeroState.abilities`. */
  abilities: Record<AbilityId, AbilityRuntime>;
  /** Active-item cooldowns keyed by item id — mirrors `HeroState.itemCooldowns`. */
  itemCooldowns: Record<string, number>;
}

// ── Wire creep representations ───────────────────────────────────────

/**
 * Per-tick creep fields. Only "active" creeps (recently moved / fought) are
 * included — an at-rest creep is fully described by its registry entry, so
 * idle camps cost zero snapshot bytes.
 */
export interface SnapshotCreep {
  id: string;
  pos: Vec2;
  facing: number;
  hp: number;
  /**
   * Seconds left on a stun, sent only while one is running (0/absent = none).
   * Drives the client's stun indicator — a stunned creep is always "active",
   * so it is never dropped by snapshot idle-omission while the timer runs.
   */
  stunTimer?: number;
}

/**
 * Cold creep registry entry, sent once in the welcome. Creep ids are stable
 * for the whole match; level/alive changes afterwards are event-carried
 * (`creepRespawn` / `creepKill` piggyback on snapshots).
 */
export interface CreepMeta {
  id: string;
  campId: string;
  type: CreepTypeId;
  level: number;
  alive: boolean;
  hp: number;
  pos: Vec2;
  spawnPos: Vec2;
}

// ── Wire building representations ────────────────────────────────────

/**
 * Building registry entry, sent once in the welcome. Buildings never move;
 * per-tick hp rides `SnapshotBuilding`, and razing is event-carried
 * (`buildingKill`).
 */
export interface BuildingMeta {
  id: string;
  type: BuildingTypeId;
  team: number;
  pos: Vec2;
  hp: number;
  alive: boolean;
}

/** Per-tick building fields — hp only (0 = razed). */
export interface SnapshotBuilding {
  id: string;
  hp: number;
}

// ── Wire rune representations ──────────────────────────────────

/**
 * Rune registry entry, sent once in the welcome. Rune ids/positions are
 * stable for the whole match; pickups and respawns afterwards are
 * event-carried (`runePickup` / `runeSpawn` piggyback on snapshots), so
 * runes never appear in per-tick snapshots.
 */
export interface RuneMeta {
  id: string;
  pos: Vec2;
  type: RuneTypeId;
  active: boolean;
}

// ── Server → Client ──────────────────────────────────────────────────

/**
 * Everything needed to bootstrap rendering a live match. Sent inside
 * `matchStart` when a lobby starts, and inside `welcome` when a player joins
 * a match already in progress — identical either way, so the client has one
 * code path for both.
 */
export interface MatchInit {
  /** Map this room is running. */
  map: string;
  /** Game mode this room is running ('ffa' when absent — older servers). */
  mode?: GameMode;
  /** Initial full state so the client can start rendering immediately. */
  snapshot: Snapshot;
  /** Cold fields for every hero in the snapshot. */
  meta: HeroMeta[];
  /** Cold registry for every creep in the match. */
  creepMeta: CreepMeta[];
  /** Registry for every building in the match (Defenders castles). */
  buildingMeta?: BuildingMeta[];
  /** Registry for every rune spot in the match. */
  runeMeta: RuneMeta[];
  /** Present iff the match already ended (late joiner after `matchOver`). */
  outcome?: 'victory' | 'defeat';
}

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  tickRate: number;
  /** Snapshot broadcast rate (Hz). The sim runs at `tickRate`; snapshots go
   *  out every Nth tick, so clients size their interpolation delay from this. */
  snapshotRate: number;
  /** Map this room is running. */
  map?: string;
  /** Game mode this room is running ('ffa' when absent). */
  mode?: GameMode;
  /** Which phase the room is in at the moment we joined. */
  phase: RoomPhase;
  /** Everyone currently in the room, including us. */
  roster: LobbyPlayer[];
  /**
   * Present iff `phase === 'playing'` — we joined a match in progress and
   * skip the lobby entirely. Absent while the room is still in its lobby;
   * the match state arrives later in `matchStart`.
   */
  init?: MatchInit;
}

/**
 * Roster changed — someone joined, left, renamed, or readied up. Broadcast in
 * both phases, so mid-match joins and renames reach every client's nameplates.
 */
export interface RosterMessage {
  type: 'roster';
  phase: RoomPhase;
  players: LobbyPlayer[];
}

/** The lobby started the match. Carries the same payload a late joiner gets. */
export interface MatchStartMessage {
  type: 'matchStart';
  init: MatchInit;
}

export interface SnapshotMessage {
  type: 'snapshot';
  tick: number;
  heroes: SnapshotHero[];
  wards: WardState[];
  /** Pending R-spell blast zones — visible to every player. */
  blasts: BlastState[];
  /** Active creeps only — idle/dead creeps are omitted (see SnapshotCreep). */
  creeps: SnapshotCreep[];
  /** Buildings' current hp (absent when the match has none). */
  buildings?: SnapshotBuilding[];
  /** Defenders only: current wave number (1-based; camps have no client-side
   *  tier state, so the HUD counter rides the wire). */
  wave?: number;
  /** Sim events since the previous snapshot, if any (piggybacked to save a WS frame). */
  events?: SimEvent[];
}

export interface HeroMetaMessage {
  type: 'heroMeta';
  heroes: HeroMeta[];
}

export type ServerMessage =
  | WelcomeMessage
  | RosterMessage
  | MatchStartMessage
  | SnapshotMessage
  | HeroMetaMessage;

// ── Snapshot (full hot state at a tick — welcome handshake only) ─────

export interface Snapshot {
  tick: number;
  heroes: SnapshotHero[];
  /** In-flight projectiles, so late joiners see arrows already in the air. */
  projectiles: ProjectileState[];
  wards: WardState[];
  blasts: BlastState[];
  creeps: SnapshotCreep[];
  /** Buildings' current hp (absent when the match has none). */
  buildings?: SnapshotBuilding[];
  /** Defenders only: current wave number (see SnapshotMessage.wave). */
  wave?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

export function serialize(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function deserialize(data: string): ClientMessage | ServerMessage {
  return JSON.parse(data);
}
