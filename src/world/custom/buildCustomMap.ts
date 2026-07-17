/**
 * MapSource → runtime map: derives everything `.amap`/`.map.json` files
 * deliberately do not store. Generalizes `testMap.ts` (same height math,
 * same pathing bake) to arbitrary sizes and authored content:
 *
 *  - ground heights: cliff layer × 128, with the fixed pond floor/rim dip
 *    on water tilepoints (floor when every neighbor is also water)
 *  - water table at the same constant level testMap uses
 *  - texture variation from the deterministic (i·7 + j·13) % 8 hash
 *  - pathing: map-edge boundary ring + cliff (non-ramp) tiles + solid-rock
 *    footprints are NO_WALK; trees are stamped later via treeFootprints
 *
 * Node-safe: imports only pure modules, like testMap.
 */
import type { MapData, MapBounds, ArenaRect } from '../wc3/MapData';
import type { W3ETerrain } from '../wc3/W3EParser';
import { FLAG_RAMP, FLAG_WATER, TILE_SIZE } from '../wc3/W3EParser';
import type { WpmPathing } from '../wc3/WpmParser';
import { WPM_NO_WALK, PATH_CELL_SIZE } from '../wc3/WpmParser';
import type { DoodadPlacement } from '../wc3/DooParser';
import { tileIsCliff } from '../wc3/terrainLevels';
import type { SimWorld, ObstacleAABB } from '../../sim/world';
import { buildSimWorld } from '../../sim/buildWorld';
import type { CampPlacement } from '../../sim/creepRules';
import type { RunePlacement } from '../../sim/runeRules';
import {
  MapSource, SpawnSource, SRC_FLAG_RAMP, SRC_FLAG_WATER, TYPE_ID_BY_KIND, pointsX, pointsZ,
} from './mapSource';

// Raw w3e height encoding (see testMap.ts): world = (raw − 8192) / 4 + (layer − 2) · 128.
const RAW_ZERO = 8192;
/** Pond floor: −64 world units. */
const RAW_POND_FLOOR = RAW_ZERO - 256;
/** Pond rim: −25 world units (above the water line → dry banks). */
const RAW_POND_RIM = RAW_ZERO - 100;
/** Water table: ≈ −30 world units (final = (raw − 8192)/4 − 89.6). */
const RAW_WATER = RAW_ZERO + 238;

/** The solid rock's projectile-blocking AABB half-extent (matches Doodads.ts). */
const ROCK_HALF = 40;

/** Everything the game needs from one custom map. */
export interface CustomMap {
  data: MapData;
  /** Playable arena: the map minus its blocked 1-tile boundary ring. */
  arena: ArenaRect;
  spawns: SpawnSource[];
  camps: CampPlacement[];
  /** Authored rune spots, world space. */
  runes: RunePlacement[];
  /** Projectile-blocking AABBs (solid rocks), world space. */
  obstacles: ObstacleAABB[];
}

export function buildCustomMap(src: MapSource): CustomMap {
  const terrain = buildTerrain(src);
  const pathing = buildPathing(src, terrain);
  const doodads = buildDoodads(src);

  const width = src.tilesX * TILE_SIZE;
  const height = src.tilesZ * TILE_SIZE;
  // Centered on the origin: WC3 south-west corner at (−w/2, −h/2).
  const bounds: MapBounds = {
    minX: -width / 2,
    minZ: -height / 2,
    width,
    height,
    maxX: width / 2,
    maxZ: height / 2,
    centerX: 0,
    centerZ: 0,
  };

  const arena: ArenaRect = {
    minX: bounds.minX + TILE_SIZE,
    minZ: bounds.minZ + TILE_SIZE,
    maxX: bounds.maxX - TILE_SIZE,
    maxZ: bounds.maxZ - TILE_SIZE,
    centerX: 0,
    centerZ: 0,
    width: width - 2 * TILE_SIZE,
    height: height - 2 * TILE_SIZE,
  };

  return {
    data: { terrain, pathing, doodads, bounds },
    arena,
    spawns: src.spawns.map((s) => ({ ...s })),
    camps: src.camps.map((c, idx) => ({
      id: `camp_${idx + 1}`,
      x: c.x,
      z: c.z,
      units: c.units.slice(),
    })),
    runes: src.runes.map((r) => ({ x: r.x, z: r.z })),
    obstacles: buildObstacles(src),
  };
}

/** Complete SimWorld (headless harness / server bake / editor overlay). */
export function buildCustomSimWorld(src: MapSource): SimWorld {
  const map = buildCustomMap(src);
  const world = buildSimWorld(
    map.data.pathing,
    { minX: map.data.bounds.minX, minZ: map.data.bounds.minZ },
    { ...map.arena },
    map.data.doodads,
  );
  world.obstacles = map.obstacles;
  return world;
}

// ── Terrain ───────────────────────────────────────────────────────────

function buildTerrain(src: MapSource): W3ETerrain {
  const px = pointsX(src);
  const pz = pointsZ(src);
  const count = px * pz;
  const offsetX = -(src.tilesX * TILE_SIZE) / 2;
  const offsetY = -(src.tilesZ * TILE_SIZE) / 2;

  const groundHeight = new Int16Array(count).fill(RAW_ZERO);
  const waterLevel = new Uint16Array(count).fill(RAW_ZERO);
  const texture = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const variation = new Uint8Array(count);
  const cliffTexture = new Uint8Array(count);
  const layer = new Uint8Array(count);
  const finalHeight = new Float32Array(count);
  const finalWaterHeight = new Float32Array(count);

  const isWater = (i: number, j: number) =>
    i >= 0 && j >= 0 && i < px && j < pz && (src.flags[j * px + i] & SRC_FLAG_WATER) !== 0;

  for (let j = 0; j < pz; j++) {
    for (let i = 0; i < px; i++) {
      const k = j * px + i;
      layer[k] = src.layer[k];
      texture[k] = src.texture[k];
      variation[k] = (i * 7 + j * 13) % 8;

      if (src.flags[k] & SRC_FLAG_RAMP) flags[k] |= FLAG_RAMP;

      if (src.flags[k] & SRC_FLAG_WATER) {
        flags[k] |= FLAG_WATER;
        waterLevel[k] = RAW_WATER;
        // Floor when fully surrounded by water, rim on the pond's edge —
        // the generalization of testMap's interior/rim split.
        let interior = true;
        for (let dj = -1; dj <= 1 && interior; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!isWater(i + di, j + dj)) {
              interior = false;
              break;
            }
          }
        }
        groundHeight[k] = interior ? RAW_POND_FLOOR : RAW_POND_RIM;
      }
    }
  }

  for (let k = 0; k < count; k++) {
    finalHeight[k] = (groundHeight[k] - RAW_ZERO) / 4 + (layer[k] - 2) * 128;
    finalWaterHeight[k] = (waterLevel[k] - RAW_ZERO) / 4 - 89.6;
  }

  return {
    tileset: 'A',
    groundTiles: ['Adrt', 'Adrd', 'Agrs', 'Arck', 'Agrd', 'Avin', 'Adrg', 'Alvd'],
    cliffTiles: ['CAgr', 'CAdi'],
    width: px,
    height: pz,
    offsetX,
    offsetY,
    groundHeight, waterLevel, texture, flags, variation, cliffTexture, layer,
    finalHeight, finalWaterHeight,
  };
}

// ── Pathing ───────────────────────────────────────────────────────────

function buildPathing(src: MapSource, terrain: W3ETerrain): WpmPathing {
  const cellsX = src.tilesX * 4;
  const cellsZ = src.tilesZ * 4;
  const cells = new Uint8Array(cellsX * cellsZ);

  for (let row = 0; row < cellsZ; row++) {
    for (let col = 0; col < cellsX; col++) {
      const ti = col >> 2;
      const tj = row >> 2;
      const boundary = ti === 0 || tj === 0 || ti === src.tilesX - 1 || tj === src.tilesZ - 1;
      if (boundary || tileIsCliff(terrain, ti, tj)) {
        cells[row * cellsX + col] |= WPM_NO_WALK;
      }
    }
  }

  // Solid rocks: block every cell whose center lies in the footprint.
  // Cell (col, row) center in WC3 coords, like testMap.
  for (const d of src.doodads) {
    if (d.kind !== 'rock') continue;
    const half = ROCK_HALF * d.scale;
    const wcY = -d.z;
    const minCol = Math.max(0, Math.floor((d.x - half - terrain.offsetX) / PATH_CELL_SIZE - 0.5));
    const maxCol = Math.min(cellsX - 1, Math.ceil((d.x + half - terrain.offsetX) / PATH_CELL_SIZE));
    const minRow = Math.max(0, Math.floor((wcY - half - terrain.offsetY) / PATH_CELL_SIZE - 0.5));
    const maxRow = Math.min(cellsZ - 1, Math.ceil((wcY + half - terrain.offsetY) / PATH_CELL_SIZE));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cx = terrain.offsetX + (col + 0.5) * PATH_CELL_SIZE;
        const cy = terrain.offsetY + (row + 0.5) * PATH_CELL_SIZE;
        if (Math.abs(cx - d.x) <= half && Math.abs(cy - wcY) <= half) {
          cells[row * cellsX + col] |= WPM_NO_WALK;
        }
      }
    }
  }

  return { width: cellsX, height: cellsZ, cells };
}

// ── Placements ────────────────────────────────────────────────────────

function buildDoodads(src: MapSource): DoodadPlacement[] {
  return src.doodads.map((d, idx) => ({
    typeId: TYPE_ID_BY_KIND[d.kind],
    variation: idx % 8,
    x: d.x,
    y: -d.z,
    z: 0,
    angle: d.angle,
    scaleX: d.scale,
    scaleY: d.scale,
    scaleZ: d.scale,
    flags: 2,
    life: 100,
  }));
}

function buildObstacles(src: MapSource): ObstacleAABB[] {
  return src.doodads
    .filter((d) => d.kind === 'rock')
    .map((d) => ({
      minX: d.x - ROCK_HALF * d.scale,
      minZ: d.z - ROCK_HALF * d.scale,
      maxX: d.x + ROCK_HALF * d.scale,
      maxZ: d.z + ROCK_HALF * d.scale,
    }));
}
