/**
 * Build-time script: reads the raw WC3 binary files from assets/, parses them,
 * and emits `assets/navdata.json` — a self-contained JSON bundle with
 * everything the headless simulation (and later the Durable Object server)
 * needs to construct a `SimWorld` without any Vite/browser APIs.
 *
 * Usage:  pnpm tsx scripts/build-navdata.ts
 *
 * Output: assets/navdata.json
 *   - navGrid: pathing dimensions, origin, cell size, flat walkable booleans
 *   - heightGrid: per-tilepoint final world heights + dimensions
 *   - obstacles: solid doodad 2D AABBs that block projectiles
 *   - arenas: the three pre-defined arena rectangles
 *   - shopPos: walkable position near the default arena centre
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseW3E } from '../src/world/wc3/W3EParser';
import { parseWpm, isCellWalkable, PATH_CELL_SIZE } from '../src/world/wc3/WpmParser';
import { parseDoo } from '../src/world/wc3/DooParser';
import { buildNavGridFromWpm, findWalkableNearOnGrid } from '../src/sim/buildWorld';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const OUT_PATH = path.resolve(ASSETS_DIR, 'navdata.json');

// ── Arena definitions (mirrors MapData.ts) ────────────────────────────

function arenaFromWc3(minx: number, miny: number, maxx: number, maxy: number) {
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

const ARENAS = {
  terrain1: arenaFromWc3(-2784, -6720, 4416, 512),
  terrain2: arenaFromWc3(6496, -8384, 16192, -96),
  south: arenaFromWc3(4192, -21216, 16288, -9056),
};

// ── Helpers ───────────────────────────────────────────────────────────

function readFile(name: string): ArrayBuffer {
  const p = path.join(ASSETS_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`missing asset: ${p}`);
  const buf = fs.readFileSync(p);
  // Convert Node Buffer to ArrayBuffer (copy into a new backing store)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** WC3 (x, y) → Three.js (wx, wz). */
function wc3ToWorld(x: number, y: number): { wx: number; wz: number } {
  return { wx: x, wz: -y };
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  console.log('[build-navdata] reading WC3 binaries...');

  const w3eBuf = readFile('war3map.w3e');
  const wpmBuf = readFile('war3map.wpm');
  const dooBuf = readFile('war3map.doo');

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

  // ── Height grid (full resolution, ready to sample) ──────────────
  const heightGrid = {
    width: terrain.width,
    height: terrain.height,
    offsetX: terrain.offsetX,
    offsetY: terrain.offsetY,
    /** Final world elevation per tilepoint, row-major (j south→north, i west→east). */
    heights: Array.from(terrain.finalHeight),
  };

  // ── Pathing grid (flattened row-major walkable booleans) ────────
  // Built through the same buildNavGridFromWpm path as the client (WPM +
  // tree footprints), then flattened back to WPM-native order (row 0 =
  // south) so `cells[row * width + col]` matches the file convention.
  const bounds = { minX: terrain.offsetX, minZ: -(terrain.offsetY + tilesH * 128) };
  const grid = buildNavGridFromWpm(pathing, bounds, doodads);

  const navGrid = {
    width: pathing.width,
    height: pathing.height,
    cellSize: PATH_CELL_SIZE,
    // Three.js world-space origin: minX = terrain.offsetX, minZ = -(offsetY + totalHeight)
    originX: bounds.minX,
    originZ: bounds.minZ,
    cells: new Array<boolean>(pathing.width * pathing.height),
  };

  for (let row = 0; row < pathing.height; row++) {
    for (let col = 0; col < pathing.width; col++) {
      navGrid.cells[row * pathing.width + col] = grid.isWalkable(col, pathing.height - 1 - row);
    }
  }

  // ── Note on grid row ordering ───────────────────────────────────
  // The WPM stores row 0 = south (minimum WC3 y).  In Three.js, south =
  // maximum Z.  When constructing a NavGrid from this data, the originZ
  // points to the min-Z (north) edge.  The map from grid-row gz to WPM row:
  //
  //   worldZ = originZ + (gz + 0.5) * cellSize
  //   –worldZ = –originZ – (gz + 0.5) * cellSize
  //   WC3 y  = –worldZ   (since wz = –y)
  //   WPM row = floor((WC3 y – terrain.offsetY) / cellSize)
  //           = floor((–originZ – (gz + 0.5) * cellSize – terrain.offsetY) / cellSize)
  //
  // With originZ = –(terrain.offsetY + totalHeightInCells * cellSize),
  // we get row = totalHeightInCells – 1 – gz.  So the navGrid row 0
  // corresponds to the WPM's top-most row (north edge).  The cells in
  // navdata.json are stored in WPM-native order (row 0 = south), and the
  // consumer must invert when building a NavGrid (just like Game.ts does
  // in _applyPathingToNav).  We document this here and let the client
  // handle the inversion.
  //
  // For simplicity and to avoid confusion, we store cells in the same order
  // as the WPM file (south-to-north).  The `buildSimWorld()` factory will
  // invert rows to match the NavGrid convention (row 0 = north/max-Z).

  // ── Solid doodad AABBs (projectile collision: rocks only) ──────
  // Trees block movement and sight but not arrows, so they are stamped
  // into the nav grid above and deliberately absent here.
  const obstacles: { minX: number; minZ: number; maxX: number; maxZ: number }[] = [];
  const ROCK_STYLES = new Set(['ARrk', 'LRrk', 'LPcr']);

  for (const d of doodads) {
    if (!ROCK_STYLES.has(d.typeId)) continue;
    const { wx, wz } = wc3ToWorld(d.x, d.y);

    // Check the pathing cell under the doodad's origin
    const col = Math.floor((d.x - terrain.offsetX) / PATH_CELL_SIZE);
    const row = Math.floor((d.y - terrain.offsetY) / PATH_CELL_SIZE);
    if (!isCellWalkable(pathing, col, row)) {
      const halfW = 40 * d.scaleX;
      const halfD = 40 * d.scaleY;
      obstacles.push({
        minX: wx - halfW,
        minZ: wz - halfD,
        maxX: wx + halfW,
        maxZ: wz + halfD,
      });
    }
  }

  // ── Shop position (walkable cell near the default arena centre) ─
  const defaultArena = ARENAS.terrain1;
  const shopPos = findWalkableNearOnGrid(grid, defaultArena.centerX, defaultArena.centerZ);

  // ── Assemble & write ───────────────────────────────────────────
  const navdata = {
    navGrid,
    heightGrid,
    obstacles,
    arenas: ARENAS,
    shopPos: { x: shopPos.x, z: shopPos.z },
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(navdata, null, 2), 'utf-8');
  console.log(
    `[build-navdata] wrote ${OUT_PATH}  ` +
    `(${navGrid.width}x${navGrid.height} pathing, ${heightGrid.width}x${heightGrid.height} heights, ` +
    `${obstacles.length} obstacles)`,
  );
}

main();
