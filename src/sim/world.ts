/**
 * Static, per-match world data the simulation reads but never mutates:
 * navigation grid, pathfinder, solid obstacle footprints (for projectile
 * collision), the arena rectangle, and the shop. Built once when a match
 * starts — on the server from `navdata.json`, on the client from the same
 * data — so both sides path and collide identically.
 */
import { NavGrid } from '../navigation/NavGrid';
import { Pathfinder } from '../navigation/Pathfinder';
import { Vec2 } from './math';
import { HeroState } from './state';

/** Axis-aligned world-space rectangle (XZ plane). */
export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  width: number;
  height: number;
}

/** A solid doodad footprint (2D AABB) that blocks projectiles. */
export interface ObstacleAABB {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

// Item defs live in the registry (shopItems.ts); re-exported for compat.
import type { ShopItemDef } from './shopItems';
export { type ShopItemDef };

export interface Shop {
  pos: Vec2;
  /** Radius for clicking to open the shop UI (should match the mesh size). */
  interactRadius: number;
  /** Radius for being in range to buy items. */
  buyRadius: number;
  items: ShopItemDef[];
}

/** A healing fountain: heroes standing within `healRadius` recharge HP at `healPerSecond`. */
export interface FountainDef {
  pos: Vec2;
  healRadius: number;
  healPerSecond: number;
}

export interface SimWorld {
  navGrid: NavGrid;
  pathfinder: Pathfinder;
  obstacles: ObstacleAABB[];
  arena: Rect;
  shops: Shop[];
  /** Static healing fountains placed on the map. */
  fountains: FountainDef[];
  /**
   * Authored hero spawn points (empty when the map has none). Defenders mode
   * respawns heroes here instead of at random walkable positions, so the
   * defenders always come back at their base.
   */
  spawns: Vec2[];
}

/** True if a sphere at `pos` with `radius` overlaps any obstacle (2D). */
export function sphereHitsObstacle(world: { obstacles: ObstacleAABB[] }, pos: Vec2, radius: number): boolean {
  const r2 = radius * radius;
  for (const o of world.obstacles) {
    const cx = pos.x < o.minX ? o.minX : pos.x > o.maxX ? o.maxX : pos.x;
    const cz = pos.z < o.minZ ? o.minZ : pos.z > o.maxZ ? o.maxZ : pos.z;
    const dx = cx - pos.x;
    const dz = cz - pos.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

/**
 * A random walkable position inside the arena, restricted to the main
 * walkable area reachable from the shop (so heroes never spawn on isolated
 * cliff tops or islets). Falls back to the arena center.
 */
export function findRespawnPosition(world: SimWorld, rng: () => number = Math.random): Vec2 {
  const { navGrid, pathfinder, arena, shops } = world;
  const anchor = shops.length > 0 ? shops[0].pos : { x: arena.centerX, z: arena.centerZ };
  for (let attempt = 0; attempt < 500; attempt++) {
    const wx = arena.minX + rng() * arena.width;
    const wz = arena.minZ + rng() * arena.height;
    const { gx, gz } = navGrid.worldToGrid(wx, wz);
    if (navGrid.isWalkable(gx, gz) && pathfinder.isReachable(wx, wz, anchor.x, anchor.z)) {
      const { wx: cx, wz: cz } = navGrid.gridToWorld(gx, gz);
      return { x: cx, z: cz };
    }
  }
  return { x: arena.centerX, z: arena.centerZ };
}

/**
 * The one spiral-search core behind every "nearest walkable cell" helper.
 * Visits walkable cell centers in expanding Chebyshev rings around (wx, wz)
 * — scan order (ring radius, then dz, then dx) is load-bearing: all peers
 * must resolve the same cell. Returns the first cell `accept` approves, or
 * null if the spiral (radius 64 cells) finds nothing.
 */
function spiralSearch(
  navGrid: NavGrid,
  wx: number,
  wz: number,
  accept: (cx: number, cz: number) => boolean,
): Vec2 | null {
  const start = navGrid.worldToGrid(wx, wz);
  for (let radius = 0; radius < 64; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const gx = start.gx + dx;
        const gz = start.gz + dz;
        if (!navGrid.isWalkable(gx, gz)) continue;
        const { wx: cx, wz: cz } = navGrid.gridToWorld(gx, gz);
        if (accept(cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  return null;
}

/**
 * Nearest cell center to (wx, wz) that is walkable AND in the same connected
 * component as (fromX, fromZ) — so a click on a cliff or an isolated islet
 * resolves to a spot the mover can actually stand on. Null if nothing found.
 */
export function findReachableNear(
  world: SimWorld,
  wx: number,
  wz: number,
  fromX: number,
  fromZ: number,
): Vec2 | null {
  const { navGrid, pathfinder } = world;
  return spiralSearch(navGrid, wx, wz, (cx, cz) => pathfinder.isReachable(cx, cz, fromX, fromZ));
}

/** Nearest walkable cell center to a world position (spiral search). */
export function findWalkableNear(world: SimWorld, wx: number, wz: number): Vec2 {
  return findWalkableNearOnGrid(world.navGrid, wx, wz);
}

/**
 * Nearest walkable cell center on a bare NavGrid — for callers that have no
 * SimWorld yet (world building, navdata baking, client spawn helpers). Falls
 * back to the query point itself if the spiral finds nothing.
 */
export function findWalkableNearOnGrid(navGrid: NavGrid, wx: number, wz: number): Vec2 {
  return findWalkableCellNear(navGrid, wx, wz) ?? { x: wx, z: wz };
}

/** Like `findWalkableNearOnGrid`, but null (no fallback) when nothing is found. */
export function findWalkableCellNear(navGrid: NavGrid, wx: number, wz: number): Vec2 | null {
  return spiralSearch(navGrid, wx, wz, () => true);
}
