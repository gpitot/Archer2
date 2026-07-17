import { Clock } from './Clock';
import { perf } from './PerformanceMonitor';

export type UpdateCallback = (delta: number) => void;
export type RenderCallback = (interpolation: number) => void;

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

    // Cap accumulated time to avoid spiral of death after tab switch
    if (this._accumulator > 0.2) {
      this._accumulator = 0.2;
    }

    perf.beginFrame();

    // Fixed timestep updates
    while (this._accumulator >= this.fixedDelta) {
      this.updateCb?.(this.fixedDelta);
      this._accumulator -= this.fixedDelta;
    }

    // Render with interpolation factor [0, 1)
    const interpolation = this._accumulator / this.fixedDelta;
    this.renderCb?.(interpolation);

    perf.endFrame();

    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }
}
