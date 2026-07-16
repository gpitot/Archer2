/**
 * WebSocket message types shared by client and server.
 *
 * All messages are JSON with a `type` discriminator. The `cmd` field inside
 * `InputMessage` reuses the `Command` union from `state.ts` so the same types
 * drive both local prediction and network commands.
 *
 * v2: heroes are split across two messages so per-tick snapshots stay small.
 *  - `snapshot` (every SNAPSHOT_EVERY-th tick): the "hot" fields —
 *    pos/facing/hp/alive/moving — plus projectiles, wards, and any sim
 *    events since the previous snapshot.
 *  - `heroMeta` (low rate + on meta-changing events): the "cold" fields —
 *    economy, progression, inventory — which change rarely.
 * Values are quantized server-side before serialization.
 */
import { Command, Inventory, ProjectileState, WardState, SimEvent } from './state';
import { Vec2 } from './math';

// ── Client → Server ──────────────────────────────────────────────────

export interface JoinMessage {
  type: 'join';
  name: string;
  /**
   * Map the client wants to play on ('arena' when absent). The first join
   * decides the room's map; later joins with a different map are rejected.
   */
  map?: string;
}

export interface InputMessage {
  type: 'input';
  /** Monotonic sequence number so the server can detect gaps. */
  seq: number;
  cmd: Command;
}

export type ClientMessage = JoinMessage | InputMessage;

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
  inventory: Inventory;
  wardCharges: number;
  abilityLevel: number;
  abilityCooldown: number;
  abilityCharges: number;
  abilityRecoilTimer: number;
  dodgeActive: boolean;
  dodgeTimer: number;
  dodgeCooldown: number;
  dodgeLevel: number;
  blinkCooldown: number;
}

// ── Server → Client ──────────────────────────────────────────────────

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  tickRate: number;
  /** Snapshot broadcast rate (Hz). The sim runs at `tickRate`; snapshots go
   *  out every Nth tick, so clients size their interpolation delay from this. */
  snapshotRate: number;
  /** Map this room is running. */
  map?: string;
  /** Initial full state so the client can start rendering immediately. */
  snapshot: Snapshot;
  /** Cold fields for every hero in the snapshot. */
  meta: HeroMeta[];
}

export interface SnapshotMessage {
  type: 'snapshot';
  tick: number;
  heroes: SnapshotHero[];
  projectiles: ProjectileState[];
  wards: WardState[];
  /** Sim events since the previous snapshot, if any (piggybacked to save a WS frame). */
  events?: SimEvent[];
}

export interface HeroMetaMessage {
  type: 'heroMeta';
  heroes: HeroMeta[];
}

export interface PeerJoinedMessage {
  type: 'peerJoined';
  playerId: string;
  name: string;
}

export interface PeerLeftMessage {
  type: 'peerLeft';
  playerId: string;
}

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | HeroMetaMessage
  | PeerJoinedMessage
  | PeerLeftMessage;

// ── Snapshot (hot state at a tick) ───────────────────────────────────

export interface Snapshot {
  tick: number;
  heroes: SnapshotHero[];
  projectiles: ProjectileState[];
  wards: WardState[];
}

// ── Helpers ──────────────────────────────────────────────────────────

export function serialize(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function deserialize(data: string): ClientMessage | ServerMessage {
  return JSON.parse(data);
}
