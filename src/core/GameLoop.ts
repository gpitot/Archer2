import { Clock } from './Clock';
import { perf } from './PerformanceMonitor';

export type UpdateCallback = (delta: number) => void;
/**
 * @param interpolation Fraction of a fixed step left in the accumulator, [0,1).
 * @param frameDelta    Wall-clock seconds since the previous rendered frame —
 *                      what per-frame visual animation must advance by, since
 *                      the render callback runs once per frame regardless of
 *                      how many fixed updates preceded it.
 */
export type RenderCallback = (interpolation: number, frameDelta: number) => void;

/**
 * A fixed-timestep game loop.
 *
 * Simulation (update) runs at a fixed rate defined by `tickRate`.
 * Rendering runs as fast as requestAnimationFrame allows and receives
 * an interpolation factor so visual positions can be smoothed between ticks.
 */
export class GameLoop {
  private _running = false;
  private _rafId = 0;
  private _clock = new Clock();
  private _accumulator = 0;

  readonly tickRate: number;
  readonly fixedDelta: number;

  updateCb: UpdateCallback | null = null;
  renderCb: RenderCallback | null = null;

  constructor(tickRate = 60) {
    this.tickRate = tickRate;
    this.fixedDelta = 1 / tickRate;
  }

  get running(): boolean {
    return this._running;
  }

  get elapsed(): number {
    return this._clock.elapsed;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._accumulator = 0;
    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }

  stop(): void {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  }

  private _firstFrame = true;

  private _loop(currentTime: number): void {
    if (!this._running) return;

    if (this._firstFrame) {
      this._clock.start(currentTime);
      this._firstFrame = false;
    }

    this._clock.tick(currentTime);
    this._accumulator += this._clock.delta;

    // Cap accumulated time to avoid a spiral of death after a tab switch or a
    // long frame. 0.1 s = at most 6 catch-up substeps per frame: past that the
    // extra sim work costs more than the missed time is worth, and it lands
    // precisely on the frames that are already slow. Network mode reconciles
    // from server snapshots, and offline the hero is only ever a fraction of a
    // second behind, so dropping the surplus is invisible.
    if (this._accumulator > 0.1) {
      this._accumulator = 0.1;
    }

    perf.beginFrame();

    // Fixed timestep updates
    while (this._accumulator >= this.fixedDelta) {
      this.updateCb?.(this.fixedDelta);
      this._accumulator -= this.fixedDelta;
    }

    // Render with interpolation factor [0, 1)
    const interpolation = this._accumulator / this.fixedDelta;
    this.renderCb?.(interpolation, this._clock.delta);

    perf.endFrame();

    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }
}
