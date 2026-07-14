/**
 * 2D grid representing walkable / blocked cells on the arena floor.
 * No elevation — all cells are on the same Y plane.
 */
export class NavGrid {
  readonly cells: boolean[][];

  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;

  constructor(width: number, height: number, cellSize = 1, originX = 0, originZ = 0) {
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;

    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => true),
    );
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
