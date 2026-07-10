import { HeightMap } from '../world/HeightMap';

/**
 * 2D grid representing walkable / blocked cells on the terrain,
 * with elevation-aware slope checks.
 */
export class NavGrid {
  readonly cells: boolean[][];

  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;

  private _heightMap: HeightMap | null = null;
  private _maxSlope: number;

  constructor(
    width: number,
    height: number,
    cellSize = 1,
    originX = 0,
    originZ = 0,
    maxSlope = 1.5,
  ) {
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;
    this._maxSlope = maxSlope;

    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => true),
    );
  }

  /** Attach a height map for slope-based walkability checks. */
  setHeightMap(hm: HeightMap): void {
    this._heightMap = hm;
  }

  // ── Coordinate conversion ──────────────────────────────────────

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

  // ── Queries ─────────────────────────────────────────────────────

  isInBounds(gx: number, gz: number): boolean {
    return gx >= 0 && gx < this.width && gz >= 0 && gz < this.height;
  }

  /** Check if a cell is walkable (not blocked by obstacles or steep slope). */
  isWalkable(gx: number, gz: number): boolean {
    if (!this.isInBounds(gx, gz)) return false;
    return this.cells[gz][gx];
  }

  setWalkable(gx: number, gz: number, walkable: boolean): void {
    if (!this.isInBounds(gx, gz)) return;
    this.cells[gz][gx] = walkable;
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

  /** Get the center height of a cell, or 0 if no height map. */
  getCellHeight(gx: number, gz: number): number {
    return this._heightMap?.getCellCenterHeight(gx, gz) ?? 0;
  }

  /**
   * Check if moving from cell (gx, gz) to neighbour (ngx, ngz) is allowed
   * based on slope. Too steep = blocked.
   */
  private _isSlopeWalkable(gx: number, gz: number, ngx: number, ngz: number): boolean {
    if (!this._heightMap) return true;
    const h1 = this._heightMap.getCellCenterHeight(gx, gz);
    const h2 = this._heightMap.getCellCenterHeight(ngx, ngz);
    return Math.abs(h2 - h1) <= this._maxSlope;
  }

  // ── Neighbours ──────────────────────────────────────────────────

  getNeighbors(gx: number, gz: number): { gx: number; gz: number; cost: number }[] {
    const neighbors: { gx: number; gz: number; cost: number }[] = [];

    // Cardinals (cost 1 × slope factor)
    const cardinals: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of cardinals) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (this.isWalkable(nx, nz) && this._isSlopeWalkable(gx, gz, nx, nz)) {
        const slopeCost = this._slopeCost(gx, gz, nx, nz);
        neighbors.push({ gx: nx, gz: nz, cost: 1 + slopeCost });
      }
    }

    // Diagonals (corner-cutting prevention + slope)
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
        this.isWalkable(gx + bx, gz + bz) &&
        this._isSlopeWalkable(gx, gz, nx, nz)
      ) {
        const slopeCost = this._slopeCost(gx, gz, nx, nz);
        neighbors.push({ gx: nx, gz: nz, cost: Math.SQRT2 + slopeCost });
      }
    }

    return neighbors;
  }

  /** Additional cost for moving up/down slopes (penalizes steep terrain). */
  private _slopeCost(gx: number, gz: number, ngx: number, ngz: number): number {
    if (!this._heightMap) return 0;
    const h1 = this._heightMap.getCellCenterHeight(gx, gz);
    const h2 = this._heightMap.getCellCenterHeight(ngx, ngz);
    const diff = Math.abs(h2 - h1);
    // Small penalty: 0.5 extra cost per unit of height difference
    return diff * 0.5;
  }
}
