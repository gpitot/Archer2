import { NavGrid } from './NavGrid';

/**
 * A* pathfinder operating on a NavGrid.
 *
 * Internals are typed-array based (indexed binary heap, flat g-score /
 * came-from arrays, generation-stamped visit marks) so a search over the
 * full 640×768 map grid stays well under a frame. Arrays are allocated
 * once and reused across searches; a generation counter avoids clearing
 * them between calls.
 */
export class Pathfinder {
  private _grid: NavGrid;

  // Per-cell state, index = gz * width + gx
  private _g: Float32Array;
  private _cameFrom: Int32Array;
  private _openMark: Uint32Array;   // == _generation if in open set
  private _closedMark: Uint32Array; // == _generation if expanded
  private _heapIndex: Int32Array;   // position of a cell in the heap
  private _generation = 0;

  // Binary min-heap of cell indices ordered by f (then h as tiebreak)
  private _heap: Int32Array;
  private _f: Float32Array;
  private _h: Float32Array;
  private _heapSize = 0;

  // Cached view of the grid, rebuilt lazily when NavGrid.version changes:
  // a flat walkability snapshot (fast, allocation-free neighbor checks) and
  // connected-component labels so unreachable goals fail in O(1) instead of
  // exhausting the whole component.
  private _navVersion = -1;
  private _walkable: Uint8Array;
  private _component: Int32Array;

  constructor(grid: NavGrid) {
    this._grid = grid;
    const n = grid.width * grid.height;
    this._g = new Float32Array(n);
    this._f = new Float32Array(n);
    this._h = new Float32Array(n);
    this._cameFrom = new Int32Array(n);
    this._openMark = new Uint32Array(n);
    this._closedMark = new Uint32Array(n);
    this._heapIndex = new Int32Array(n);
    this._heap = new Int32Array(n);
    this._walkable = new Uint8Array(n);
    this._component = new Int32Array(n);
  }

  /** Rebuild the walkability snapshot + component labels if the grid changed. */
  private _sync(): void {
    if (this._navVersion === this._grid.version) return;
    this._navVersion = this._grid.version;

    const w = this._grid.width;
    const h = this._grid.height;
    const cells = this._grid.cells;
    const walk = this._walkable;
    for (let gz = 0; gz < h; gz++) {
      const row = cells[gz];
      const base = gz * w;
      for (let gx = 0; gx < w; gx++) {
        walk[base + gx] = row[gx] ? 1 : 0;
      }
    }

    // 4-neighbor flood fill. Diagonal moves forbid corner cutting (both
    // cardinals must be open), so 4-connectivity equals 8-connectivity here.
    const comp = this._component;
    comp.fill(-1);
    const queue = this._heap; // reuse as BFS queue between searches
    let label = 0;
    for (let seed = 0; seed < walk.length; seed++) {
      if (!walk[seed] || comp[seed] !== -1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      comp[seed] = label;
      while (head < tail) {
        const idx = queue[head++];
        const gx = idx % w;
        if (gx + 1 < w && walk[idx + 1] && comp[idx + 1] === -1) { comp[idx + 1] = label; queue[tail++] = idx + 1; }
        if (gx > 0 && walk[idx - 1] && comp[idx - 1] === -1) { comp[idx - 1] = label; queue[tail++] = idx - 1; }
        if (idx + w < walk.length && walk[idx + w] && comp[idx + w] === -1) { comp[idx + w] = label; queue[tail++] = idx + w; }
        if (idx - w >= 0 && walk[idx - w] && comp[idx - w] === -1) { comp[idx - w] = label; queue[tail++] = idx - w; }
      }
      label++;
    }
  }

  /**
   * Find a path from (startGX, startGZ) to (goalGX, goalGZ).
   * Returns grid positions (including start and goal) or null.
   */
  findPath(startGX: number, startGZ: number, goalGX: number, goalGZ: number): { gx: number; gz: number }[] | null {
    if (!this._grid.isWalkable(goalGX, goalGZ)) return null;
    if (!this._grid.isWalkable(startGX, startGZ)) return null;
    if (startGX === goalGX && startGZ === goalGZ) {
      return [{ gx: startGX, gz: startGZ }];
    }

    this._sync();

    const w = this._grid.width;
    const h = this._grid.height;
    const startIdx = startGZ * w + startGX;
    const goalIdx = goalGZ * w + goalGX;

    // Different connected components can never reach each other.
    if (this._component[startIdx] !== this._component[goalIdx]) return null;

    this._generation++;
    this._heapSize = 0;

    this._g[startIdx] = 0;
    this._h[startIdx] = heuristic(startGX, startGZ, goalGX, goalGZ);
    this._f[startIdx] = this._h[startIdx];
    this._cameFrom[startIdx] = -1;
    this._heapPush(startIdx);

    const walk = this._walkable;

    while (this._heapSize > 0) {
      const current = this._heapPop();
      if (current === goalIdx) return this._reconstructPath(current);
      this._closedMark[current] = this._generation;

      const cgx = current % w;
      const cgz = (current - cgx) / w;

      // Inline 8-neighbor expansion over the flat snapshot (no allocations).
      const canE = cgx + 1 < w && walk[current + 1] === 1;
      const canW = cgx > 0 && walk[current - 1] === 1;
      const canS = cgz + 1 < h && walk[current + w] === 1;
      const canN = cgz > 0 && walk[current - w] === 1;

      if (canE) this._relax(current, current + 1, cgx + 1, cgz, 1, goalGX, goalGZ);
      if (canW) this._relax(current, current - 1, cgx - 1, cgz, 1, goalGX, goalGZ);
      if (canS) this._relax(current, current + w, cgx, cgz + 1, 1, goalGX, goalGZ);
      if (canN) this._relax(current, current - w, cgx, cgz - 1, 1, goalGX, goalGZ);

      // Diagonals — cost √2, no corner cutting (both cardinals must be open).
      if (canE && canS && walk[current + w + 1] === 1) this._relax(current, current + w + 1, cgx + 1, cgz + 1, Math.SQRT2, goalGX, goalGZ);
      if (canW && canS && walk[current + w - 1] === 1) this._relax(current, current + w - 1, cgx - 1, cgz + 1, Math.SQRT2, goalGX, goalGZ);
      if (canE && canN && walk[current - w + 1] === 1) this._relax(current, current - w + 1, cgx + 1, cgz - 1, Math.SQRT2, goalGX, goalGZ);
      if (canW && canN && walk[current - w - 1] === 1) this._relax(current, current - w - 1, cgx - 1, cgz - 1, Math.SQRT2, goalGX, goalGZ);
    }

    return null;
  }

  /** A* edge relaxation for one neighbor cell. */
  private _relax(current: number, nIdx: number, ngx: number, ngz: number, cost: number, goalGX: number, goalGZ: number): void {
    if (this._closedMark[nIdx] === this._generation) return;

    const tentativeG = this._g[current] + cost;
    const inOpen = this._openMark[nIdx] === this._generation;
    if (inOpen && tentativeG >= this._g[nIdx]) return;

    this._g[nIdx] = tentativeG;
    this._h[nIdx] = heuristic(ngx, ngz, goalGX, goalGZ);
    this._f[nIdx] = tentativeG + this._h[nIdx];
    this._cameFrom[nIdx] = current;
    if (inOpen) {
      this._heapUpdate(nIdx);
    } else {
      this._heapPush(nIdx);
    }
  }

  /**
   * True when both world positions sit on walkable cells of the same
   * connected component (i.e. a path exists between them). O(1) after the
   * lazily-built component labeling.
   */
  isReachable(startWX: number, startWZ: number, goalWX: number, goalWZ: number): boolean {
    const start = this._grid.worldToGrid(startWX, startWZ);
    const goal = this._grid.worldToGrid(goalWX, goalWZ);
    if (!this._grid.isWalkable(start.gx, start.gz)) return false;
    if (!this._grid.isWalkable(goal.gx, goal.gz)) return false;
    this._sync();
    const w = this._grid.width;
    return this._component[start.gz * w + start.gx] === this._component[goal.gz * w + goal.gx];
  }

  /**
   * Find a path between two world positions and smooth it with
   * line-of-sight string pulling (the approach WC3/LoL-style games use):
   * the raw grid path zig-zags through cell centers, so we drop every
   * waypoint that is directly visible from an earlier one, leaving turns
   * only at obstacle corners.
   *
   * Returns world positions starting at the exact start position and
   * ending at the exact goal position, or null if no path exists.
   */
  findSmoothedPath(
    startWX: number,
    startWZ: number,
    goalWX: number,
    goalWZ: number,
  ): { wx: number; wz: number }[] | null {
    const start = this._grid.worldToGrid(startWX, startWZ);
    const goal = this._grid.worldToGrid(goalWX, goalWZ);

    const gridPath = this.findPath(start.gx, start.gz, goal.gx, goal.gz);
    if (!gridPath) return null;

    const points = gridPath.map((p) => this._grid.gridToWorld(p.gx, p.gz));
    // Use the exact start/goal positions instead of cell centers. Both lie
    // inside walkable cells already on the path, so this is always safe.
    points[0] = { wx: startWX, wz: startWZ };
    if (points.length === 1) {
      points.push({ wx: goalWX, wz: goalWZ });
    } else {
      points[points.length - 1] = { wx: goalWX, wz: goalWZ };
    }

    // String pulling: from each anchor, jump to the farthest visible point.
    const smoothed: { wx: number; wz: number }[] = [points[0]];
    let anchor = 0;
    while (anchor < points.length - 1) {
      let next = anchor + 1;
      for (let j = points.length - 1; j > anchor + 1; j--) {
        const a = points[anchor];
        const b = points[j];
        if (this._grid.hasLineOfSight(a.wx, a.wz, b.wx, b.wz)) {
          next = j;
          break;
        }
      }
      smoothed.push(points[next]);
      anchor = next;
    }
    return smoothed;
  }

  private _reconstructPath(idx: number): { gx: number; gz: number }[] {
    const w = this._grid.width;
    const path: { gx: number; gz: number }[] = [];
    let current = idx;
    while (current !== -1) {
      const gx = current % w;
      path.push({ gx, gz: (current - gx) / w });
      current = this._cameFrom[current];
    }
    path.reverse();
    return path;
  }

  // ── Binary min-heap on f (h as tiebreak) ─────────────────────────

  private _less(a: number, b: number): boolean {
    return this._f[a] < this._f[b] || (this._f[a] === this._f[b] && this._h[a] < this._h[b]);
  }

  private _heapPush(idx: number): void {
    this._openMark[idx] = this._generation;
    this._heap[this._heapSize] = idx;
    this._heapIndex[idx] = this._heapSize;
    this._heapSize++;
    this._siftUp(this._heapSize - 1);
  }

  private _heapPop(): number {
    const top = this._heap[0];
    this._heapSize--;
    if (this._heapSize > 0) {
      this._heap[0] = this._heap[this._heapSize];
      this._heapIndex[this._heap[0]] = 0;
      this._siftDown(0);
    }
    this._openMark[top] = 0; // no longer open
    return top;
  }

  /** Re-sort a cell whose f-score decreased (it can only move up). */
  private _heapUpdate(idx: number): void {
    this._siftUp(this._heapIndex[idx]);
  }

  private _siftUp(pos: number): void {
    const heap = this._heap;
    const item = heap[pos];
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (!this._less(item, heap[parent])) break;
      heap[pos] = heap[parent];
      this._heapIndex[heap[pos]] = pos;
      pos = parent;
    }
    heap[pos] = item;
    this._heapIndex[item] = pos;
  }

  private _siftDown(pos: number): void {
    const heap = this._heap;
    const item = heap[pos];
    const half = this._heapSize >> 1;
    while (pos < half) {
      let child = pos * 2 + 1;
      const right = child + 1;
      if (right < this._heapSize && this._less(heap[right], heap[child])) {
        child = right;
      }
      if (!this._less(heap[child], item)) break;
      heap[pos] = heap[child];
      this._heapIndex[heap[pos]] = pos;
      pos = child;
    }
    heap[pos] = item;
    this._heapIndex[item] = pos;
  }
}

/** Octile distance heuristic (appropriate for 8-directional grids). */
function heuristic(x1: number, z1: number, x2: number, z2: number): number {
  const dx = Math.abs(x1 - x2);
  const dz = Math.abs(z1 - z2);
  // Cost: min(dx, dz) diagonals at √2 + |dx-dz| cardinals at 1
  return Math.min(dx, dz) * Math.SQRT2 + Math.abs(dx - dz);
}
