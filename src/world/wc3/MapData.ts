/**
 * Loads and assembles the original map data (terrain, pathing, doodads)
 * from the WC3 binary files shipped in `assets/`.
 *
 * ── Coordinate transform (WC3 → Three.js) ──
 * WC3 is x-east / y-north / z-up; our world is x-east / z-south / y-up with
 * the camera looking toward −Z (screen-up = north). So:
 *
 *     wx = x_wc3        wy = elevation        wz = −y_wc3
 *
 * The map is NOT centered on the origin — the w3e stores the world position
 * of its south-west corner, and all bounds below derive from it.
 */

import { parseW3E, W3ETerrain, TILE_SIZE } from './W3EParser';
import { parseWpm, WpmPathing, PATH_CELL_SIZE } from './WpmParser';
import { parseDoo, DoodadPlacement } from './DooParser';

import w3eUrl from '../../../assets/war3map.w3e?url';
import wpmUrl from '../../../assets/war3map.wpm?url';
import dooUrl from '../../../assets/war3map.doo?url';

export interface MapBounds {
  /** World-space minimum corner (west / north edge in Three.js coords). */
  minX: number;
  minZ: number;
  /** Full extent in world units. */
  width: number;
  height: number;
  maxX: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
}

export interface MapData {
  terrain: W3ETerrain;
  pathing: WpmPathing;
  doodads: DoodadPlacement[];
  bounds: MapBounds;
}

export { TILE_SIZE, PATH_CELL_SIZE };

export async function loadMapData(): Promise<MapData> {
  const [w3eBuf, wpmBuf, dooBuf] = await Promise.all([
    fetchBuffer(w3eUrl),
    fetchBuffer(wpmUrl),
    fetchBuffer(dooUrl),
  ]);

  const terrain = parseW3E(w3eBuf);
  const pathing = parseWpm(wpmBuf);
  const doodads = parseDoo(dooBuf);

  const tilesW = terrain.width - 1;
  const tilesH = terrain.height - 1;
  if (pathing.width !== tilesW * 4 || pathing.height !== tilesH * 4) {
    throw new Error(
      `pathing/terrain mismatch: wpm ${pathing.width}x${pathing.height}, ` +
      `w3e ${tilesW}x${tilesH} tiles`,
    );
  }

  const width = tilesW * TILE_SIZE;
  const height = tilesH * TILE_SIZE;
  // WC3 south-west corner (offsetX, offsetY) → Three.js: x unchanged; the
  // north edge (max WC3 y) becomes minZ.
  const minX = terrain.offsetX;
  const minZ = -(terrain.offsetY + height);
  const bounds: MapBounds = {
    minX, minZ, width, height,
    maxX: minX + width,
    maxZ: minZ + height,
    centerX: minX + width / 2,
    centerZ: minZ + height / 2,
  };

  console.info(
    `[map] tileset ${terrain.tileset}, ${tilesW}x${tilesH} tiles, ` +
    `world x ${bounds.minX}..${bounds.maxX}, z ${bounds.minZ}..${bounds.maxZ}, ` +
    `${doodads.length} visible doodads, ` +
    `pathing ${pathing.width}x${pathing.height}`,
  );

  return { terrain, pathing, doodads, bounds };
}

// ── Arenas ──────────────────────────────────────────────────────

/**
 * Axis-aligned world-space rectangle (Three.js coords). The original map
 * script defines one per selectable arena and confines camera bounds and
 * spawns to the host's pick.
 */
export interface ArenaRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  width: number;
  height: number;
}

function arenaFromWc3(minx: number, miny: number, maxx: number, maxy: number): ArenaRect {
  // z = −y flips the vertical min/max
  const minZ = -maxy;
  const maxZ = -miny;
  return {
    minX: minx, minZ, maxX: maxx, maxZ,
    centerX: (minx + maxx) / 2,
    centerZ: (minZ + maxZ) / 2,
    width: maxx - minx,
    height: maxZ - minZ,
  };
}

/** "Terrain 1" (by Devrak) — north-west arena, the original default. */
export const ARENA_TERRAIN1 = arenaFromWc3(-2784, -6720, 4416, 512);
/** "Terrain 2" (by Rei) — north-east arena. */
export const ARENA_TERRAIN2 = arenaFromWc3(6496, -8384, 16192, -96);
/** Large southern arena (not host-selectable in 1.4d). */
export const ARENA_SOUTH = arenaFromWc3(4192, -21216, 16288, -9056);

// ── Coordinate helpers ──────────────────────────────────────────

/** WC3 (x, y) → Three.js (wx, wz). */
export function wc3ToWorld(x: number, y: number): { wx: number; wz: number } {
  return { wx: x, wz: -y };
}

/**
 * Continuous tilepoint coordinates for a world position: u runs west→east
 * along tilepoint columns, v runs south→north along tilepoint rows —
 * matching the w3e storage order (row 0 = south).
 */
export function worldToTile(
  terrain: W3ETerrain, wx: number, wz: number,
): { u: number; v: number } {
  const u = (wx - terrain.offsetX) / TILE_SIZE;
  const v = (-wz - terrain.offsetY) / TILE_SIZE;
  return { u, v };
}

/** World position of tilepoint (i, j) — i west→east, j south→north. */
export function tileToWorld(
  terrain: W3ETerrain, i: number, j: number,
): { wx: number; wz: number } {
  return { wx: terrain.offsetX + i * TILE_SIZE, wz: -(terrain.offsetY + j * TILE_SIZE) };
}

/**
 * Bilinear sample of a per-tilepoint Float32Array at a world position
 * (clamped to the map edge).
 */
export function sampleTilepointGrid(
  terrain: W3ETerrain, grid: Float32Array, wx: number, wz: number,
): number {
  const { u, v } = worldToTile(terrain, wx, wz);
  const cu = Math.min(Math.max(u, 0), terrain.width - 1.001);
  const cv = Math.min(Math.max(v, 0), terrain.height - 1.001);
  const i = Math.floor(cu);
  const j = Math.floor(cv);
  const fu = cu - i;
  const fv = cv - j;
  const w = terrain.width;
  const h00 = grid[j * w + i];
  const h10 = grid[j * w + i + 1];
  const h01 = grid[(j + 1) * w + i];
  const h11 = grid[(j + 1) * w + i + 1];
  return (
    h00 * (1 - fu) * (1 - fv) +
    h10 * fu * (1 - fv) +
    h01 * (1 - fu) * fv +
    h11 * fu * fv
  );
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return res.arrayBuffer();
}
