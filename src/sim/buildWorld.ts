/**
 * Factories that build a `SimWorld` from either live `MapData` (client,
 * already parsed for rendering) or precomputed `navdata.json` (server /
 * headless).  Both paths produce identical nav grids and collision data so
 * the authoritative server sim and the client predictor agree exactly.
 */
import { NavGrid } from '../navigation/NavGrid';
import { Pathfinder } from '../navigation/Pathfinder';
import { PATH_CELL_SIZE, isCellWalkable, WpmPathing } from '../world/wc3/WpmParser';
import { SHOP_ITEMS } from './shopItems';
import { SimWorld, ObstacleAABB, Rect, Shop, findWalkableNearOnGrid } from './world';

export { findWalkableNearOnGrid } from './world';
import { TreeDoodadLike, stampTreeFootprints, treeFootprints } from './treeFootprints';

/**
 * Build a NavGrid from the WPM pathing map plus tree footprints.  Used by
 * the client world build and the navdata scripts so every serialized or
 * live grid blocks the exact same cells.
 */
export function buildNavGridFromWpm(
  pathing: WpmPathing,
  bounds: { minX: number; minZ: number },
  doodads?: readonly TreeDoodadLike[],
): NavGrid {
  const navGrid = new NavGrid(
    pathing.width,
    pathing.height,
    PATH_CELL_SIZE,
    bounds.minX,
    bounds.minZ,
  );
  // Copy pathing: WPM row 0 = south, NavGrid row 0 = north → invert
  for (let gz = 0; gz < pathing.height; gz++) {
    const wpmRow = pathing.height - 1 - gz;
    for (let gx = 0; gx < pathing.width; gx++) {
      navGrid.setWalkable(gx, gz, isCellWalkable(pathing, gx, wpmRow));
    }
  }
  if (doodads) stampTreeFootprints(navGrid, treeFootprints(doodads));
  return navGrid;
}

/**
 * Build a SimWorld from raw map components (client path).
 * Pass `pathing`, the world-space bounds of the nav grid, the arena rect,
 * and the doodad placements (trees are stamped into the nav grid).
 */
export function buildSimWorld(
  pathing: WpmPathing,
  bounds: { minX: number; minZ: number },
  arena: Rect,
  doodads?: readonly TreeDoodadLike[],
): SimWorld {
  const navGrid = buildNavGridFromWpm(pathing, bounds, doodads);
  const pathfinder = new Pathfinder(navGrid);

  // Obstacles — populated later via buildObstaclesFromSolids.
  const obstacles: ObstacleAABB[] = [];

  // Shop position — find walkable near arena centre
  const shopPos = findWalkableNearOnGrid(navGrid, arena.centerX, arena.centerZ);

  const shop: Shop = {
    pos: shopPos,
    interactRadius: 85,
    buyRadius: 400,
    items: SHOP_ITEMS,
  };

  return { navGrid, pathfinder, obstacles, arena, shop, fountains: [] };
}

/** Build a SimWorld from precomputed navdata.json (server path). */
export function buildSimWorldFromNavdata(navdata: {
  navGrid: { width: number; height: number; cellSize: number; originX: number; originZ: number; cells: boolean[] };
  obstacles: { minX: number; minZ: number; maxX: number; maxZ: number }[];
  arenas: { terrain1: Rect };
  shopPos: { x: number; z: number };
  fountains?: { x: number; z: number }[];
}): SimWorld {
  const ng = navdata.navGrid;
  const navGrid = new NavGrid(ng.width, ng.height, ng.cellSize, ng.originX, ng.originZ);
  // Navdata stores cells in WPM-native order (south-to-north).  NavGrid row 0
  // is north (max world Z), so we invert.
  for (let gz = 0; gz < ng.height; gz++) {
    const srcRow = ng.height - 1 - gz;
    for (let gx = 0; gx < ng.width; gx++) {
      navGrid.setWalkable(gx, gz, ng.cells[srcRow * ng.width + gx]);
    }
  }
  const pathfinder = new Pathfinder(navGrid);

  const obstacles: ObstacleAABB[] = navdata.obstacles.map((o) => ({ ...o }));

  const shop: Shop = {
    pos: { x: navdata.shopPos.x, z: navdata.shopPos.z },
    interactRadius: 85,
    buyRadius: 400,
    items: SHOP_ITEMS,
  };

  // Fountains: use authored positions or default to empty.
  const fountains: import('./world').FountainDef[] = (navdata.fountains ?? []).map((f) => ({
    pos: { x: f.x, z: f.z },
    healRadius: 200,
    healPerSecond: 100,
  }));

  return {
    navGrid,
    pathfinder,
    obstacles,
    arena: { ...navdata.arenas.terrain1 },
    shop,
    fountains,
  };
}

/** Populate the obstacle list from the Doodads' solid-footprint array. */
export function buildObstaclesFromSolids(
  solids: { x: number; z: number; halfW: number; halfD: number }[],
): ObstacleAABB[] {
  return solids.map((s) => ({
    minX: s.x - s.halfW,
    minZ: s.z - s.halfD,
    maxX: s.x + s.halfW,
    maxZ: s.z + s.halfD,
  }));
}

