/**
 * 2D grid representing walkable / blocked cells on the arena floor.
 * No elevation — all cells are on the same Y plane.
 */
export class NavGrid {
  /** Flat row-major walkability map (1 = walkable), indexed `gz * width + gx`. */
  readonly cells: Uint8Array;

  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;

  /** Bumped on every walkability change so consumers can cache derived data. */
  private _version = 0;

  get version(): number {
    return this._version;
  }

  constructor(width: number, height: number, cellSize = 1, originX = 0, originZ = 0) {
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;

    this.cells = new Uint8Array(width * height).fill(1);
  }

  // ── Coordinate conversion ────────────────────────────────

  worldToGrid(wx: number, wz: number): { gx: number; gz: number } {
    const gx = Math.floor((wx - this.originX) / this.cellSize);
    const gz = Math.floor((wz - this.originZ) / this.cellSize);
    return { gx, gz };
  }

  gridToWorld(gx: number, gz: number): { wx: number; wz: number } {
    const wx = this.originX + (gx + 0.5) * this.cellSize;
    const wz = this.originZ + (gz + 0.5) * this.cellSize;
    return { wx, wz };
  }

  // ── Queries ──────────────────────────────────────────────

  isInBounds(gx: number, gz: number): boolean {
    return gx >= 0 && gx < this.width && gz >= 0 && gz < this.height;
  }

  isWalkable(gx: number, gz: number): boolean {
    if (!this.isInBounds(gx, gz)) return false;
    return this.cells[gz * this.width + gx] !== 0;
  }

  setWalkable(gx: number, gz: number, walkable: boolean): void {
    if (!this.isInBounds(gx, gz)) return;
    const idx = gz * this.width + gx;
    const value = walkable ? 1 : 0;
    if (this.cells[idx] !== value) {
      this.cells[idx] = value;
      this._version++;
    }
  }

  blockRegion(wx: number, wz: number, halfWidth: number, halfDepth: number): void {
    const min = this.worldToGrid(wx - halfWidth, wz - halfDepth);
    const max = this.worldToGrid(wx + halfWidth, wz + halfDepth);
    for (let gz = min.gz; gz <= max.gz; gz++) {
      for (let gx = min.gx; gx <= max.gx; gx++) {
        this.setWalkable(gx, gz, false);
      }
    }
  }

  /**
   * True if the straight world-space segment from (wx0, wz0) to (wx1, wz1)
   * crosses only walkable cells. Uses a supercover grid traversal: when the
   * segment passes exactly through a cell corner, both adjacent cells must
   * be walkable (same no-corner-cutting rule as diagonal neighbours).
   */
  hasLineOfSight(wx0: number, wz0: number, wx1: number, wz1: number): boolean {
    // Continuous grid coordinates
    const x0 = (wx0 - this.originX) / this.cellSize;
    const z0 = (wz0 - this.originZ) / this.cellSize;
    const x1 = (wx1 - this.originX) / this.cellSize;
    const z1 = (wz1 - this.originZ) / this.cellSize;

    let gx = Math.floor(x0);
    let gz = Math.floor(z0);
    const goalGX = Math.floor(x1);
    const goalGZ = Math.floor(z1);

    if (!this.isWalkable(gx, gz)) return false;

    const dx = x1 - x0;
    const dz = z1 - z0;
    const stepX = Math.sign(dx);
    const stepZ = Math.sign(dz);

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

    // t at which the ray first crosses a vertical / horizontal cell boundary
    let tMaxX = stepX !== 0 ? (stepX > 0 ? gx + 1 - x0 : x0 - gx) * tDeltaX : Infinity;
    let tMaxZ = stepZ !== 0 ? (stepZ > 0 ? gz + 1 - z0 : z0 - gz) * tDeltaZ : Infinity;

    // Safety guard: a supercover traversal takes at most this many axis steps
    let guard = Math.abs(goalGX - gx) + Math.abs(goalGZ - gz) + 2;
    const EPS = 1e-9;

    while ((gx !== goalGX || gz !== goalGZ) && guard-- > 0) {
      if (Math.abs(tMaxX - tMaxZ) < EPS) {
        // Exact corner crossing — treat like a diagonal step
        if (!this.isWalkable(gx + stepX, gz) || !this.isWalkable(gx, gz + stepZ)) {
          return false;
        }
        gx += stepX;
        gz += stepZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      } else if (tMaxX < tMaxZ) {
        gx += stepX;
        tMaxX += tDeltaX;
      } else {
        gz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (!this.isWalkable(gx, gz)) return false;
    }

    return true;
  }

  // ── Neighbours (flat, no slope) ──────────────────────────

  getNeighbors(gx: number, gz: number): { gx: number; gz: number; cost: number }[] {
    const neighbors: { gx: number; gz: number; cost: number }[] = [];

    // Cardinals — cost 1
    const cardinals: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of cardinals) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (this.isWalkable(nx, nz)) {
        neighbors.push({ gx: nx, gz: nz, cost: 1 });
      }
    }

    // Diagonals — cost √2, with corner-cutting prevention
    const diagonals: [number, number, number, number, number, number][] = [
      [1, 1, 1, 0, 0, 1],
      [-1, 1, -1, 0, 0, 1],
      [1, -1, 1, 0, 0, -1],
      [-1, -1, -1, 0, 0, -1],
    ];
    for (const [dx, dz, ax, az, bx, bz] of diagonals) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (
        this.isWalkable(nx, nz) &&
        this.isWalkable(gx + ax, gz + az) &&
        this.isWalkable(gx + bx, gz + bz)
      ) {
        neighbors.push({ gx: nx, gz: nz, cost: Math.SQRT2 });
      }
    }

    return neighbors;
  }
}
