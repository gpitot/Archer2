/**
 * Tiny synthetic debug map, built entirely in code — no WC3 binaries.
 *
 * 16×16 tiles (2048×2048 world units) containing one of everything the
 * gameplay systems care about, so changes can be exercised on a map small
 * enough to reason about at a glance:
 *
 *  - flat layer-2 ground with a layer-3 cliff plateau in the north-east
 *  - one 2-tile-wide walkable ramp onto the plateau (south edge)
 *  - a 3-tree cluster (blocks pathing + sight, not arrows)
 *  - one solid rock (blocks pathing, sight, and arrows)
 *  - a shallow pond in the south-west (water rendering + height dip)
 *  - two fixed hero spawns on open ground
 *
 * The generator emits the exact same `MapData` shape the WC3 parsers
 * produce, so terrain meshing, pathing, fog, minimap, and the sim all
 * consume it unchanged. Node-safe: imports only pure modules (the vite
 * asset loader in wc3/MapData is imported type-only).
 */
import type { MapData, MapBounds, ArenaRect } from './wc3/MapData';
import type { W3ETerrain } from './wc3/W3EParser';
import { FLAG_RAMP, FLAG_WATER, TILE_SIZE } from './wc3/W3EParser';
import type { WpmPathing } from './wc3/WpmParser';
import { WPM_NO_WALK, PATH_CELL_SIZE } from './wc3/WpmParser';
import type { DoodadPlacement } from './wc3/DooParser';
import { tileIsCliff } from './wc3/terrainLevels';
import type { SimWorld } from '../sim/world';
import { buildSimWorld } from '../sim/buildWorld';

// ── Layout constants ──────────────────────────────────────────────────

/** Map size in tiles (tilepoints = +1). */
const TILES = 16;
const POINTS = TILES + 1;
/** WC3 south-west corner: map spans −1024..1024 on both axes. */
const OFFSET = -(TILES * TILE_SIZE) / 2;

/** Plateau: tilepoints with i ≥ 10 AND j ≥ 10 sit on cliff layer 3. */
const PLATEAU_MIN_I = 10;
const PLATEAU_MIN_J = 10;
/**
 * Ramp: the two transition tiles (12,9) and (13,9) on the plateau's south
 * edge. Ramp flags go on their shared middle tilepoint column only — that
 * gives both tiles the ≥2 flagged corners `tileIsRamp` needs while the
 * flanking cliff tiles (11,9) and (14,9) keep 0 and stay stepped.
 */
const RAMP_POINT_I = 13;
const RAMP_POINT_JS = [9, 10];

/** Pond: tilepoints 2..4 on both axes (2×2 tiles, SW quadrant). */
const POND_MIN = 2;
const POND_MAX = 4;

// Raw w3e height encoding: world = (raw − 8192) / 4 + (layer − 2) · 128.
const RAW_ZERO = 8192;
/** Pond floor: −64 world units. */
const RAW_POND_FLOOR = RAW_ZERO - 256;
/** Pond rim: −25 world units (above the water line → dry banks). */
const RAW_POND_RIM = RAW_ZERO - 100;
/** Water table: ≈ −30 world units (final = (raw − 8192)/4 − 89.6). */
const RAW_WATER = RAW_ZERO + 238;

// Ground texture indices (Ashenvale palette order, see GroundTextures).
const TEX_DIRT = 0;      // Adrt — ramp
const TEX_ROUGH = 1;     // Adrd — pond bed
const TEX_GRASS = 2;     // Agrs — low ground
const TEX_DARK_GRASS = 6; // Adrg — plateau

/** Playable arena: the map minus its blocked 1-tile boundary ring. */
export const TEST_MAP_ARENA: ArenaRect = {
  minX: OFFSET + TILE_SIZE,
  minZ: OFFSET + TILE_SIZE,
  maxX: -OFFSET - TILE_SIZE,
  maxZ: -OFFSET - TILE_SIZE,
  centerX: 0,
  centerZ: 0,
  width: -2 * OFFSET - 2 * TILE_SIZE,
  height: -2 * OFFSET - 2 * TILE_SIZE,
};

/** Fixed spawns (world coords): [0] player / first hero, [1] dummy / second. */
export const TEST_MAP_SPAWNS: { x: number; z: number }[] = [
  { x: -350, z: 420 },
  { x: 450, z: 450 },
];

/**
 * Doodads in WC3 coordinates (y north, wz = −y): a tree cluster NW of
 * center, one solid rock, and a cosmetic bush.
 */
const DOODADS: DoodadPlacement[] = [
  tree(-500, 100, 0.4),
  tree(-560, 210, 1.8),
  tree(-410, 220, 3.0),
  {
    typeId: 'ARrk', variation: 0, x: -200, y: 420, z: 0,
    angle: 0.7, scaleX: 1, scaleY: 1, scaleZ: 1, flags: 2, life: 100,
  },
  {
    typeId: 'ZPsh', variation: 0, x: 150, y: -350, z: 0,
    angle: 0, scaleX: 1, scaleY: 1, scaleZ: 1, flags: 2, life: 100,
  },
];

function tree(x: number, y: number, angle: number): DoodadPlacement {
  return {
    typeId: 'LTlt', variation: 0, x, y, z: 0,
    angle, scaleX: 1, scaleY: 1, scaleZ: 1, flags: 2, life: 100,
  };
}

/** The rock's projectile-blocking AABB half-extent (matches Doodads.ts). */
const ROCK_HALF = 40;

// ── Generator ─────────────────────────────────────────────────────────

export function buildTestMapData(): MapData {
  const terrain = buildTerrain();
  const pathing = buildPathing(terrain);

  const width = TILES * TILE_SIZE;
  const bounds: MapBounds = {
    minX: OFFSET,
    minZ: -(OFFSET + width),
    width,
    height: width,
    maxX: OFFSET + width,
    maxZ: -OFFSET,
    centerX: 0,
    centerZ: 0,
  };

  return { terrain, pathing, doodads: DOODADS.slice(), bounds };
}

function buildTerrain(): W3ETerrain {
  const count = POINTS * POINTS;
  const groundHeight = new Int16Array(count).fill(RAW_ZERO);
  const waterLevel = new Uint16Array(count).fill(RAW_ZERO);
  const texture = new Uint8Array(count).fill(TEX_GRASS);
  const flags = new Uint8Array(count);
  const variation = new Uint8Array(count);
  const cliffTexture = new Uint8Array(count);
  const layer = new Uint8Array(count).fill(2);
  const finalHeight = new Float32Array(count);
  const finalWaterHeight = new Float32Array(count);

  for (let j = 0; j < POINTS; j++) {
    for (let i = 0; i < POINTS; i++) {
      const k = j * POINTS + i;
      variation[k] = (i * 7 + j * 13) % 8;

      if (i >= PLATEAU_MIN_I && j >= PLATEAU_MIN_J) {
        layer[k] = 3;
        texture[k] = TEX_DARK_GRASS;
      }

      if (i >= POND_MIN && i <= POND_MAX && j >= POND_MIN && j <= POND_MAX) {
        flags[k] |= FLAG_WATER;
        waterLevel[k] = RAW_WATER;
        texture[k] = TEX_ROUGH;
        const interior = i > POND_MIN && i < POND_MAX && j > POND_MIN && j < POND_MAX;
        groundHeight[k] = interior ? RAW_POND_FLOOR : RAW_POND_RIM;
      }
    }
  }

  // Ramp flags + dirt texture on the ramp tiles' corner points.
  for (const j of RAMP_POINT_JS) {
    flags[j * POINTS + RAMP_POINT_I] |= FLAG_RAMP;
    for (let i = RAMP_POINT_I - 1; i <= RAMP_POINT_I + 1; i++) {
      texture[j * POINTS + i] = TEX_DIRT;
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
    width: POINTS,
    height: POINTS,
    offsetX: OFFSET,
    offsetY: OFFSET,
    groundHeight, waterLevel, texture, flags, variation, cliffTexture, layer,
    finalHeight, finalWaterHeight,
  };
}

/**
 * Bake the pathing map the way the WC3 editor would: cliff (non-ramp
 * transition) tiles, the map-edge boundary ring, and solid-rock footprints
 * are NO_WALK. Trees are NOT baked here — nav-grid builders stamp them via
 * treeFootprints, and Doodads.ts reads this map to classify solidity
 * (walkable cell under a tree ⇒ non-solid ⇒ arrows fly through).
 */
function buildPathing(terrain: W3ETerrain): WpmPathing {
  const cellsPerSide = TILES * 4;
  const cells = new Uint8Array(cellsPerSide * cellsPerSide);

  for (let row = 0; row < cellsPerSide; row++) {
    for (let col = 0; col < cellsPerSide; col++) {
      const ti = col >> 2;
      const tj = row >> 2;
      const boundary = ti === 0 || tj === 0 || ti === TILES - 1 || tj === TILES - 1;
      if (boundary || tileIsCliff(terrain, ti, tj)) {
        cells[row * cellsPerSide + col] |= WPM_NO_WALK;
      }
    }
  }

  // Solid rocks: block every cell whose center lies in the footprint.
  for (const d of DOODADS) {
    if (d.typeId !== 'ARrk') continue;
    for (let row = 0; row < cellsPerSide; row++) {
      for (let col = 0; col < cellsPerSide; col++) {
        const cx = OFFSET + (col + 0.5) * PATH_CELL_SIZE;
        const cy = OFFSET + (row + 0.5) * PATH_CELL_SIZE;
        if (Math.abs(cx - d.x) <= ROCK_HALF * d.scaleX && Math.abs(cy - d.y) <= ROCK_HALF * d.scaleY) {
          cells[row * cellsPerSide + col] |= WPM_NO_WALK;
        }
      }
    }
  }

  return { width: cellsPerSide, height: cellsPerSide, cells };
}

/**
 * Projectile-blocking AABBs (world space) — the solid rock. Mirrors what
 * the client derives from Doodads.projectileSolids so headless sims and
 * the server collide arrows identically.
 */
export function testMapObstacles(): { minX: number; minZ: number; maxX: number; maxZ: number }[] {
  return DOODADS
    .filter((d) => d.typeId === 'ARrk')
    .map((d) => ({
      minX: d.x - ROCK_HALF * d.scaleX,
      minZ: -d.y - ROCK_HALF * d.scaleY,
      maxX: d.x + ROCK_HALF * d.scaleX,
      maxZ: -d.y + ROCK_HALF * d.scaleY,
    }));
}

/**
 * Complete SimWorld for the test map (headless harness / scripts). The
 * client builds its copy from the same pieces in Game.init, so both sides
 * path and collide identically.
 */
export function buildTestSimWorld(): SimWorld {
  const map = buildTestMapData();
  const world = buildSimWorld(
    map.pathing,
    { minX: map.bounds.minX, minZ: map.bounds.minZ },
    { ...TEST_MAP_ARENA },
    map.doodads,
  );
  world.obstacles = testMapObstacles();
  // Place one healing fountain on open ground near the west side.
  world.fountains = [{
    pos: { x: -600, z: 200 },
    healRadius: 200,
    healPerSecond: 100,
  }];
  return world;
}
