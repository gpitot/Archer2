import { NavGrid } from './NavGrid';

interface PathNode {
  gx: number;
  gz: number;
  g: number;   // cost from start
  h: number;   // heuristic to goal
  f: number;   // g + h
  parent: PathNode | null;
}

/**
 * A* pathfinder operating on a NavGrid.
 *
 * Returns an array of grid positions from start to goal (inclusive),
 * or null if no path exists.
 */
export class Pathfinder {
  private _grid: NavGrid;

  constructor(grid: NavGrid) {
    this._grid = grid;
  }

  /**
   * Find a path from (startGX, startGZ) to (goalGX, goalGZ).
   * Returns grid positions (including start and goal) or null.
   */
  findPath(startGX: number, startGZ: number, goalGX: number, goalGZ: number): { gx: number; gz: number }[] | null {
    if (!this._grid.isWalkable(goalGX, goalGZ)) return null;
    if (!this._grid.isWalkable(startGX, startGZ)) return null;

    // If start == goal, return single point
    if (startGX === goalGX && startGZ === goalGZ) {
      return [{ gx: startGX, gz: startGZ }];
    }

    const open = new Map<string, PathNode>();
    const closed = new Set<string>();

    const key = (gx: number, gz: number) => `${gx},${gz}`;

    const startNode: PathNode = {
      gx: startGX,
      gz: startGZ,
      g: 0,
      h: heuristic(startGX, startGZ, goalGX, goalGZ),
      f: 0,
      parent: null,
    };
    startNode.f = startNode.g + startNode.h;
    open.set(key(startGX, startGZ), startNode);

    // Limit iterations to prevent infinite loops on large grids
    let iterations = 0;
    const maxIterations = this._grid.width * this._grid.height * 2;

    while (open.size > 0 && iterations < maxIterations) {
      iterations++;

      // Find node with lowest f (could use a priority queue; Map scan is fine for MVP)
      let current: PathNode | null = null;
      for (const node of open.values()) {
        if (!current || node.f < current.f || (node.f === current.f && node.h < current.h)) {
          current = node;
        }
      }
      if (!current) break;

      // Goal reached
      if (current.gx === goalGX && current.gz === goalGZ) {
        return this._reconstructPath(current);
      }

      const ck = key(current.gx, current.gz);
      open.delete(ck);
      closed.add(ck);

      // Explore neighbours
      const neighbors = this._grid.getNeighbors(current.gx, current.gz);
      for (const nb of neighbors) {
        const nk = key(nb.gx, nb.gz);
        if (closed.has(nk)) continue;

        const tentativeG = current.g + nb.cost;

        const existing = open.get(nk);
        if (existing && tentativeG >= existing.g) continue;

        const neighborNode: PathNode = {
          gx: nb.gx,
          gz: nb.gz,
          g: tentativeG,
          h: heuristic(nb.gx, nb.gz, goalGX, goalGZ),
          f: 0,
          parent: current,
        };
        neighborNode.f = neighborNode.g + neighborNode.h;
        open.set(nk, neighborNode);
      }
    }

    // No path found
    return null;
  }

  private _reconstructPath(node: PathNode): { gx: number; gz: number }[] {
    const path: { gx: number; gz: number }[] = [];
    let current: PathNode | null = node;
    while (current) {
      path.unshift({ gx: current.gx, gz: current.gz });
      current = current.parent;
    }
    return path;
  }
}

/** Octile distance heuristic (appropriate for 8-directional grids). */
function heuristic(x1: number, z1: number, x2: number, z2: number): number {
  const dx = Math.abs(x1 - x2);
  const dz = Math.abs(z1 - z2);
  // Cost: min(dx, dz) diagonals at √2 + |dx-dz| cardinals at 1
  return Math.min(dx, dz) * Math.SQRT2 + Math.abs(dx - dz);
}
