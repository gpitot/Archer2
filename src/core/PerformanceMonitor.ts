/**
 * Lightweight in-console performance monitor for diagnosing frame-time
 * spikes, GPU load, and GC pressure during gameplay.
 *
 * Enable via URL param ?perf=1 or call `.enable()` at runtime.
 *
 * Logs:
 *  - 1 Hz summary: FPS, p50/p95/p99/max frame time, draw calls, triangles, heap
 *  - Instant warnings when a frame exceeds 50 ms (configurable)
 */

export interface RendererStats {
  drawCalls: number;
  triangles: number;
  points: number;
}

export class PerformanceMonitor {
  private _enabled = false;
  private _frameSamples: number[] = [];
  private _frameStart = 0;
  private _lastSummaryTime = 0;
  private _summaryInterval = 1000; // ms between periodic logs
  private _spikeThreshold = 50; // ms — warn on frames longer than this
  private _sampleCount = 0;

  /** Callback that returns current renderer.info stats. */
  getRendererStats: (() => RendererStats | null) | null = null;

  // ── Public API ────────────────────────────────────────────────────────

  enable(): void {
    if (this._enabled) return;
    this._enabled = true;
    this._lastSummaryTime = performance.now();
    this._frameSamples = [];
    this._sampleCount = 0;
    console.log(
      '%c[perf] monitor enabled – logging 1 Hz summaries + frame spikes >' +
        `${this._spikeThreshold}ms`,
      'color:#88ccff',
    );
  }

  disable(): void {
    this._enabled = false;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Call at the very top of rAF. */
  beginFrame(): void {
    if (!this._enabled) return;
    this._frameStart = performance.now();
  }

  /** Call at the very bottom of rAF (after renderer.render). */
  endFrame(): void {
    if (!this._enabled) return;
    const now = performance.now();
    const dt = now - this._frameStart;
    this._frameSamples.push(dt);
    this._sampleCount++;

    if (dt >= this._spikeThreshold) {
      const stats = this.getRendererStats?.();
      console.warn(
        `%c[perf] ⚡ SPIKE ${dt.toFixed(1)}ms` +
          (stats
            ? ` | drawCalls=${stats.drawCalls} tri=${stats.triangles}`
            : '') +
          ` | ${this._heapStr()}`,
        'color:#ff8844',
      );
    }

    if (now - this._lastSummaryTime >= this._summaryInterval) {
      this._printSummary(now);
      this._lastSummaryTime = now;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private _printSummary(now: number): void {
    const samples = this._frameSamples;
    if (samples.length === 0) return;

    // Sort a copy for percentiles
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;
    const fps = 1000 / avg;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const max = sorted[sorted.length - 1];

    const stats = this.getRendererStats?.();
    const statStr = stats
      ? `drawCalls=${stats.drawCalls} tri=${stats.triangles}`
      : '';

    const color = avg < 10 ? '#88cc88' : avg < 20 ? '#cccc88' : '#cc8888';
    console.log(
      `%c[perf] FPS=${fps.toFixed(0)} | ` +
        `avg=${avg.toFixed(1)}ms p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms` +
        (statStr ? ` | ${statStr}` : '') +
        ` | ${this._heapStr()}` +
        ` | samples=${samples.length}`,
      `color:${color}`,
    );

    this._frameSamples = [];
  }

  private _heapStr(): string {
    const mem = (performance as any).memory;
    if (!mem) return 'heap=N/A';
    const used = (mem.usedJSHeapSize / 1024 / 1024).toFixed(1);
    const total = (mem.totalJSHeapSize / 1024 / 1024).toFixed(0);
    const limit = (mem.jsHeapSizeLimit / 1024 / 1024).toFixed(0);
    return `heap=${used}/${total}MB (limit=${limit}MB)`;
  }
}

/** Convenience singleton so any module can access it. */
export const perf = new PerformanceMonitor();
