/**
 * Network-time helpers shared by Game.ts: snapshot-buffer management,
 * render-clock offset tracking, and generic entity interpolation.
 *
 * Prediction stays in Game.ts — this module only handles remote entities
 * that are lerped between server snapshots.
 */
import type { SnapshotMessage, SnapshotHero, SnapshotCreep } from '../sim/protocol';
import type { Vec2 } from '../sim/math';
import { clamp } from '../sim/math';

// ── Snapshot straddling ──────────────────────────────────────────────

export interface StraddlePair {
  prev: SnapshotMessage;
  next: SnapshotMessage;
  /** Interpolation factor 0–1 within the pair. */
  t: number;
}

/**
 * Find the snapshot pair that straddles `renderTime` (seconds on the server
 * tick timeline). Returns null when fewer than 2 snapshots are buffered.
 * Clamps t to [0,1] when renderTime falls outside the buffered range.
 */
export function findStraddlingPair(
  snapshots: readonly SnapshotMessage[],
  renderTime: number,
  tickDt: number,
): StraddlePair | null {
  if (snapshots.length < 2) return null;

  let prev = snapshots[0];
  let next = snapshots[1];
  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = snapshots[i];
    const b = snapshots[i + 1];
    if (a.tick * tickDt <= renderTime && renderTime <= b.tick * tickDt) {
      prev = a;
      next = b;
      break;
    }
    // renderTime is newer than everything buffered — use the newest pair.
    if (i === snapshots.length - 2) {
      prev = a;
      next = b;
    }
  }

  const prevTime = prev.tick * tickDt;
  const nextTime = next.tick * tickDt;
  const span = nextTime - prevTime;
  const t = span > 0 ? clamp((renderTime - prevTime) / span, 0, 1) : 0;
  return { prev, next, t };
}

/**
 * Prune snapshots that have fallen behind the straddling pair — keep at most
 * 2 for the next frame's interpolation.
 */
export function pruneSnapshots(
  snapshots: SnapshotMessage[],
  renderTime: number,
  tickDt: number,
): void {
  while (snapshots.length > 2 && snapshots[1].tick * tickDt <= renderTime) {
    snapshots.shift();
  }
}

// ── Render clock ──────────────────────────────────────────────────────

/**
 * Maintain a smoothed offset between server time and local time so the
 * render clock advances continuously between snapshot arrivals.
 */
export class RenderClock {
  /** Smoothed (serverTime − localTime); null until the first snapshot. */
  offset: number | null = null;
  localTime = 0;
  interpDelay: number;
  tickDt: number;

  constructor(tickDt: number, interpDelay: number) {
    this.tickDt = tickDt;
    this.interpDelay = interpDelay;
  }

  /** Advance local time and return the render time (server timeline, offset). */
  advance(dt: number): number | null {
    this.localTime += dt;
    if (this.offset === null) return null;
    return this.localTime + this.offset - this.interpDelay;
  }

  /** Feed a new (serverTime − localTime) sample; EMA-smooth unless grossly out of sync. */
  feedSample(serverTime: number): void {
    const sample = serverTime - this.localTime;
    if (this.offset === null || Math.abs(sample - this.offset) > 0.5) {
      this.offset = sample;
    } else {
      this.offset += (sample - this.offset) * 0.1;
    }
  }
}

// ── Generic entity interpolation ─────────────────────────────────────

/** An entity that can be interpolated. */
export interface LerpTarget {
  pos: Vec2;
  facing: number;
}

/** Lerp a hero entity from snapshot pair. */
export function lerpHero(
  target: LerpTarget,
  prev: SnapshotHero,
  next: SnapshotHero,
  t: number,
): void {
  target.pos.x = prev.pos.x + (next.pos.x - prev.pos.x) * t;
  target.pos.z = prev.pos.z + (next.pos.z - prev.pos.z) * t;
  target.facing = lerpAngle(prev.facing, next.facing, t);
}

/** Lerp a creep entity from snapshot pair. */
export function lerpCreep(
  target: LerpTarget,
  prev: SnapshotCreep,
  next: SnapshotCreep,
  t: number,
): void {
  target.pos.x = prev.pos.x + (next.pos.x - prev.pos.x) * t;
  target.pos.z = prev.pos.z + (next.pos.z - prev.pos.z) * t;
  target.facing = lerpAngle(prev.facing, next.facing, t);
}

/** Shortest-path angular lerp in radians. */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
