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

/** One purchasable item. `apply` mutates the buyer's plain state. */
export interface ShopItemDef {
  id: string;
  name: string;
  cost: number;
  description: string;
  /** Stackable items (e.g. ward charges) can be re-bought while owned. */
  stackable?: boolean;
  apply: (hero: HeroState) => void;
}

export interface Shop {
  pos: Vec2;
  interactRadius: number;
  items: ShopItemDef[];
}

export interface SimWorld {
  navGrid: NavGrid;
  pathfinder: Pathfinder;
  obstacles: ObstacleAABB[];
  arena: Rect;
  shop: Shop;
}

/** True if a sphere at `pos` with `radius` overlaps any obstacle (2D). */
export function sphereHitsObstacle(world: SimWorld, pos: Vec2, radius: number): boolean {
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
  const { navGrid, pathfinder, arena, shop } = world;
  for (let attempt = 0; attempt < 500; attempt++) {
    const wx = arena.minX + rng() * arena.width;
    const wz = arena.minZ + rng() * arena.height;
    const { gx, gz } = navGrid.worldToGrid(wx, wz);
    if (navGrid.isWalkable(gx, gz) && pathfinder.isReachable(wx, wz, shop.pos.x, shop.pos.z)) {
      const { wx: cx, wz: cz } = navGrid.gridToWorld(gx, gz);
      return { x: cx, z: cz };
    }
  }
  return { x: arena.centerX, z: arena.centerZ };
}

/**
 * Nearest cell center to (wx, wz) that is walkable AND in the same connected
 * component as (fromX, fromZ) — so a click on a cliff or an isolated islet
 * resolves to a spot the mover can actually stand on. Null if the spiral
 * (radius 64 cells) finds nothing.
 */
export function findReachableNear(
  world: SimWorld,
  wx: number,
  wz: number,
  fromX: number,
  fromZ: number,
): Vec2 | null {
  const { navGrid, pathfinder } = world;
  const start = navGrid.worldToGrid(wx, wz);
  for (let radius = 0; radius < 64; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const gx = start.gx + dx;
        const gz = start.gz + dz;
        if (!navGrid.isWalkable(gx, gz)) continue;
        const { wx: cx, wz: cz } = navGrid.gridToWorld(gx, gz);
        if (pathfinder.isReachable(cx, cz, fromX, fromZ)) {
          return { x: cx, z: cz };
        }
      }
    }
  }
  return null;
}

/** Nearest walkable cell center to a world position (spiral search). */
export function findWalkableNear(world: SimWorld, wx: number, wz: number): Vec2 {
  const { navGrid } = world;
  const start = navGrid.worldToGrid(wx, wz);
  for (let radius = 0; radius < 64; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const gx = start.gx + dx;
        const gz = start.gz + dz;
        if (navGrid.isWalkable(gx, gz)) {
          const { wx: cx, wz: cz } = navGrid.gridToWorld(gx, gz);
          return { x: cx, z: cz };
        }
      }
    }
  }
  return { x: wx, z: wz };
}
