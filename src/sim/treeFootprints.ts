/**
 * Tree pathing footprints, shared by every nav-grid producer (client world
 * build, navdata build scripts) so all grids block the exact same cells.
 *
 * Trees block movement and line-of-sight but not projectiles; rocks keep
 * their editor-baked behavior (solid rocks block arrows and sight).
 */
import { NavGrid } from '../navigation/NavGrid';

/** Doodad type IDs rendered (and pathed) as trees. */
export const TREE_TYPE_IDS: ReadonlySet<string> = new Set(['ATtr', 'LTlt', 'YTpb', 'YTfc']);

/** Half-extent of an unscaled tree footprint, world units (matches the tree AABB). */
export const TREE_HALF_EXTENT = 48;

/**
 * Half-extent of a tree's *sight-blocking* footprint. Narrower than the
 * pathing footprint so a lone tree shadows roughly its visual canopy width
 * instead of a multi-cell wall of fog.
 */
export const TREE_SIGHT_HALF_EXTENT = 32;

/** World-space (XZ) footprint of one tree. */
export interface TreeFootprint {
  x: number;
  z: number;
  halfW: number;
  halfD: number;
}

/** Minimal doodad shape needed to derive footprints (WC3 coords: wz = -y). */
export interface TreeDoodadLike {
  typeId: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/** Footprints of all tree-type doodads, in world space. */
export function treeFootprints(doodads: readonly TreeDoodadLike[]): TreeFootprint[] {
  const out: TreeFootprint[] = [];
  for (const d of doodads) {
    if (!TREE_TYPE_IDS.has(d.typeId)) continue;
    out.push({
      x: d.x,
      z: -d.y,
      halfW: TREE_HALF_EXTENT * d.scaleX,
      halfD: TREE_HALF_EXTENT * d.scaleY,
    });
  }
  return out;
}

/**
 * Mark unwalkable every cell whose *center* falls inside a footprint.
 * Center-in-AABB (rather than any-overlap) keeps a 48-half tree at ~2-3
 * blocked cells per axis, close to WC3's 2x2 tree footprint, so tree lines
 * don't seal off corridors the original map leaves open.
 */
export function stampTreeFootprints(navGrid: NavGrid, footprints: readonly TreeFootprint[]): void {
  for (const f of footprints) {
    const min = navGrid.worldToGrid(f.x - f.halfW, f.z - f.halfD);
    const max = navGrid.worldToGrid(f.x + f.halfW, f.z + f.halfD);
    for (let gz = min.gz; gz <= max.gz; gz++) {
      for (let gx = min.gx; gx <= max.gx; gx++) {
        const { wx, wz } = navGrid.gridToWorld(gx, gz);
        if (Math.abs(wx - f.x) <= f.halfW && Math.abs(wz - f.z) <= f.halfD) {
          navGrid.setWalkable(gx, gz, false);
        }
      }
    }
  }
}
