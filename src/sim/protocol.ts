/**
 * WebSocket message types shared by client and server.
 *
 * All messages are JSON with a `type` discriminator. The `cmd` field inside
 * `InputMessage` reuses the `Command` union from `state.ts` so the same types
 * drive both local prediction and network commands.
 *
 * v1: full-state snapshots (not deltas). Fine for ≤10 players.
 */
import { Command, HeroState, ProjectileState, WardState, SimEvent } from './state';

// ── Client → Server ──────────────────────────────────────────────────

export interface JoinMessage {
  type: 'join';
  name: string;
}

export interface InputMessage {
  type: 'input';
  /** Monotonic sequence number so the server can detect gaps. */
  seq: number;
  cmd: Command;
}

export type ClientMessage = JoinMessage | InputMessage;

// ── Server → Client ──────────────────────────────────────────────────

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  tickRate: number;
  /** Initial full state so the client can start rendering immediately. */
  snapshot: Snapshot;
}

export interface SnapshotMessage {
  type: 'snapshot';
  tick: number;
  heroes: HeroState[];
  projectiles: ProjectileState[];
  wards: WardState[];
}

export interface EventMessage {
  type: 'event';
  event: SimEvent;
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
  | EventMessage
  | PeerJoinedMessage
  | PeerLeftMessage;

// ── Snapshot (full state at a tick) ──────────────────────────────────

export interface Snapshot {
  tick: number;
  heroes: HeroState[];
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
