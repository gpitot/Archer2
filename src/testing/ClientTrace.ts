/**
 * Per-frame state recorder for the live client, enabled with `?debug=1`.
 *
 * Each update tick, `Game` records one line: the sim-side position (`x`/`z`)
 * *and* the view-mesh position (`vx`/`vz`) of every hero, projectile, and
 * cosmetic projectile, plus which server snapshots arrived and which events
 * fired that frame. `dump()` returns the buffer as JSONL — the same shape the
 * headless SimHarness writes — so `pnpm trace` can inspect either.
 *
 * Browser-safe: no Node imports. Kept as a ring buffer so it can stay on for
 * long sessions.
 */
import { SimEvent } from '../sim/state';

export interface ClientTraceLine {
  frame: number;
  /** Seconds since the trace started (wall clock). */
  t: number;
  /** Client-side match tick (the latest adopted snapshot's tick). */
  tick: number;
  /** Ticks of server snapshots that arrived during this frame, if any. */
  snapTicks?: number[];
  heroes: { id: string; x: number; z: number; vx: number; vz: number; hp: number; alive: boolean }[];
  projectiles: { id: string; x: number; z: number; vx: number; vz: number; traveled: number; visible: boolean }[];
  cosmetic: { id: string; x: number; z: number; vx: number; vz: number }[];
  events?: SimEvent[];
}

const MAX_FRAMES = 36_000; // ~10 minutes at 60 Hz

export class ClientTrace {
  private _lines: ClientTraceLine[] = [];
  private _frame = 0;
  private _t0 = performance.now();

  get length(): number {
    return this._lines.length;
  }

  record(line: Omit<ClientTraceLine, 'frame' | 't'>): void {
    this._lines.push({
      frame: this._frame++,
      t: +((performance.now() - this._t0) / 1000).toFixed(4),
      ...line,
    });
    if (this._lines.length > MAX_FRAMES) this._lines.shift();
  }

  /** The whole buffer as JSONL (one frame per line). */
  dump(): string {
    return this._lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  clear(): void {
    this._lines = [];
  }
}
