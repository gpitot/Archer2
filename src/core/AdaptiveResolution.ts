/**
 * Dynamic-resolution controller.
 *
 * Fragment cost is the dominant term on weak GPUs — the terrain covers the
 * screen with a PBR material, and MSAA plus a 2× device pixel ratio can mean
 * eight shaded samples per CSS pixel. Rendering to a smaller buffer and letting
 * the browser scale it up is the one dial that buys frames without changing
 * what is on screen.
 *
 * The canvas's CSS size never changes, so the DOM HUD, the minimap, and mouse
 * picking are all unaffected; only the WebGL drawing buffer shrinks.
 *
 * Two guards keep this from making things worse:
 *  - a cooldown between steps, so it can't oscillate frame to frame;
 *  - a CPU-bound detector — if two consecutive downsteps don't actually improve
 *    p75 frame time, the bottleneck isn't fragments and stepping further would
 *    only cost image quality for nothing.
 */
import { perf } from './PerformanceMonitor';
import { quality } from './qualitySettings';

/** Render scales, worst last. The controller walks this ladder one rung at a time. */
const LADDER = [1.0, 0.875, 0.75, 0.625, 0.5];

/** p75 frame time above which we shed resolution (≈42 fps). */
const DOWN_MS = 24;
/** p75 frame time below which we try to win it back (≈83 fps). */
const UP_MS = 12;
/** Seconds of sustained headroom required before stepping back up. */
const UP_HOLD_S = 4;
/** Seconds to wait after any step before considering another. */
const COOLDOWN_S = 3;
/** How long the floor must be held on High before we persist the Low tier. */
const DEMOTE_AFTER_S = 30;

export class AdaptiveResolution {
  private _apply: (scale: number) => void;
  private _index = 0;
  private _floorIndex: number;
  private _cooldown = 0;
  private _headroom = 0;
  private _evalAccum = 0;
  /** p75 measured just before the last downstep, for the CPU-bound check. */
  private _p75BeforeDown = 0;
  private _uselessDownsteps = 0;
  private _atFloorFor = 0;
  /** Called once if the floor is held long enough to suggest a tier demotion. */
  private _onSustainedFloor: (() => void) | null;
  private _demoted = false;

  constructor(apply: (scale: number) => void, onSustainedFloor: (() => void) | null = null) {
    this._apply = apply;
    this._onSustainedFloor = onSustainedFloor;
    const floor = quality().renderScaleFloor;
    // Deepest rung not below the tier's floor.
    let idx = LADDER.length - 1;
    while (idx > 0 && LADDER[idx] < floor) idx--;
    this._floorIndex = idx;
  }

  /** Current render scale, 1 = native. */
  get scale(): number {
    return LADDER[this._index];
  }

  /** Call once per rendered frame with the frame delta in seconds. */
  update(dt: number): void {
    if (this._cooldown > 0) this._cooldown -= dt;

    // Evaluate at 1 Hz: the frame-time window needs to refill after a step
    // before its p75 means anything.
    this._evalAccum += dt;
    if (this._evalAccum < 1) return;
    this._evalAccum = 0;

    const p75 = perf.p75();
    if (p75 === null) return; // not enough samples yet

    if (this._index >= this._floorIndex) {
      this._atFloorFor += 1;
      if (!this._demoted && this._onSustainedFloor && p75 > DOWN_MS && this._atFloorFor >= DEMOTE_AFTER_S) {
        this._demoted = true;
        this._onSustainedFloor();
      }
    } else {
      this._atFloorFor = 0;
    }

    if (this._cooldown > 0) return;

    if (p75 > DOWN_MS) {
      this._headroom = 0;
      // A downstep that didn't help means we're CPU-bound, not fill-bound.
      if (this._p75BeforeDown > 0 && p75 >= this._p75BeforeDown * 0.95) {
        this._uselessDownsteps++;
      } else {
        this._uselessDownsteps = 0;
      }
      if (this._uselessDownsteps >= 2) return; // stop shedding pixels for nothing
      if (this._index < this._floorIndex) {
        this._p75BeforeDown = p75;
        this._step(this._index + 1);
      }
      return;
    }

    if (p75 < UP_MS && this._index > 0) {
      this._headroom += 1;
      if (this._headroom >= UP_HOLD_S) {
        // Stepping back up invalidates the CPU-bound evidence.
        this._uselessDownsteps = 0;
        this._p75BeforeDown = 0;
        this._step(this._index - 1);
      }
      return;
    }

    this._headroom = 0;
  }

  private _step(index: number): void {
    this._index = index;
    this._headroom = 0;
    this._cooldown = COOLDOWN_S;
    this._apply(LADDER[index]);
    if (perf.enabled) {
      console.log(`%c[perf] render scale → ${LADDER[index].toFixed(3)}`, 'color:#88ccff');
    }
  }
}
