/**
 * Generate `maps/pentad.map.json` — the 5-player map.
 *
 * Five players cannot be laid out fairly on a rectangular grid: any square or
 * lane-based plan gives someone a corner and someone else a middle. So this map
 * is built radially and generated rather than hand-drawn, because the balance
 * property we want is exact:
 *
 *   Every feature is placed at (angleOffset, radius) inside one 72° sector and
 *   then rotated by k · 72°, and every terrain tilepoint is classified by a
 *   function of (radius, angle-folded-into-one-sector). The map is therefore
 *   invariant under a 72° rotation, so all five starts are the *same position*
 *   up to rotation — not merely similar ones.
 *
 * The square map's corners fall outside the playable disc and become the
 * impassable mountain rim, which is what buys the symmetry.
 *
 * Usage:  pnpm tsx scripts/gen-pentad-map.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  MapSource, CampSource, DoodadSource, SRC_FLAG_RAMP, SRC_FLAG_WATER,
  BASE_LAYER, serializeMapJson,
} from '../src/world/custom/mapSource';
import type { CreepTypeId } from '../src/sim/creepRules';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILE = 128;

// ── Dimensions ────────────────────────────────────────────────────────
// 32×32 tiles ⇒ ±2048 world units. The playable disc (r ≤ R_OUT) is
// ~677 tiles² ≈ 135 tiles per player, in line with 1v1's ~98 for a mode
// where five players need room to disengage.
const TILES = 32;
const HALF = (TILES * TILE) / 2;
/** Radius of the playable disc; beyond it is layer-4 mountain. */
const R_OUT = 1880;

// ── Radial layout, one 72° sector ─────────────────────────────────────
// Angle offsets are degrees from the sector's own axis; 0° is the spawn
// corridor, ±36° is the boundary lane shared with a neighbour.
const SECTORS = 5;
/** Sector 0's axis points north (world −z). */
const BASE_ANGLE = -90;

const SPAWN = { a: 0, r: 1500 };
const SHOP = { a: 0, r: 1700 };
/** Rock outcrop in front of each base: cover, and it must be walked around. */
const MESA = { a: 0, r: 1120, radius: 200 };
const POND = { a: -18, r: 1350, radius: 220 };
const RUNE = { a: 18, r: 1350 };
/** On the boundary axis: equidistant from two spawns, so genuinely contested. */
const MEDIUM_CAMP = { a: 36, r: 1150 };
const FOUNTAIN = { a: 36, r: 1700 };
const EASY_CAMP = { a: 0, r: 700 };

/** Central high ground: the one thing all five players are equally far from. */
const PLATEAU_R = 430;
/** Ramp wedge onto the plateau, one per sector, on each player's own axis. */
const RAMP_HALF_ANGLE = 20;
const RAMP_R0 = 340;
const RAMP_R1 = 580;

// Ashenvale palette indices (see buildTerrain's groundTiles).
const TEX_DIRT = 0;
const TEX_GRASS = 2;
const TEX_ROCK = 3;
const TEX_ROUGH = 6;

// ── Polar helpers ─────────────────────────────────────────────────────

const rad = (deg: number) => (deg * Math.PI) / 180;

/** World point at `r` along sector `k`'s axis, offset `a` degrees. */
function polar(a: number, r: number, k: number): { x: number; z: number } {
  const th = rad(BASE_ANGLE + k * (360 / SECTORS) + a);
  return { x: Math.round(r * Math.cos(th)), z: Math.round(r * Math.sin(th)) };
}

/** Every rotation of one sector-local placement. */
function ring(a: number, r: number): { x: number; z: number }[] {
  return Array.from({ length: SECTORS }, (_, k) => polar(a, r, k));
}

/** Angle of (x, z) folded into (−36°, +36°] of the nearest sector axis. */
function foldAngle(x: number, z: number): number {
  const sector = 360 / SECTORS;
  let d = ((Math.atan2(z, x) * 180) / Math.PI) - BASE_ANGLE;
  d = ((d % sector) + sector) % sector;
  return d > sector / 2 ? d - sector : d;
}

const MESA_CENTERS = ring(MESA.a, MESA.r);
const POND_CENTERS = ring(POND.a, POND.r);

function nearestBlob(x: number, z: number, centers: { x: number; z: number }[]): number {
  let best = Infinity;
  for (const c of centers) best = Math.min(best, Math.hypot(x - c.x, z - c.z));
  return best;
}

// ── Terrain classification ────────────────────────────────────────────

function layerAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r > R_OUT) return 4;                                        // mountain rim
  if (nearestBlob(x, z, MESA_CENTERS) < MESA.radius) return 3;    // rock outcrop
  if (r < PLATEAU_R) return 3;                                    // centre plateau
  return BASE_LAYER;
}

function isRamp(x: number, z: number): boolean {
  const r = Math.hypot(x, z);
  return r > RAMP_R0 && r < RAMP_R1 && Math.abs(foldAngle(x, z)) <= RAMP_HALF_ANGLE;
}

function isWater(x: number, z: number): boolean {
  return nearestBlob(x, z, POND_CENTERS) < POND.radius;
}

function textureAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r > R_OUT) return TEX_ROUGH;
  if (nearestBlob(x, z, MESA_CENTERS) < MESA.radius + TILE) return TEX_ROCK;
  if (isWater(x, z)) return TEX_DIRT;
  if (r < PLATEAU_R || isRamp(x, z)) return TEX_DIRT;
  if (r > R_OUT - 180) return TEX_ROUGH;
  // Worn lane down each player's own axis: makes the five corridors readable.
  if (Math.abs(foldAngle(x, z)) < 6 && r < SPAWN.r) return TEX_DIRT;
  return TEX_GRASS;
}

// ── Doodads ───────────────────────────────────────────────────────────
//
// Authored once in sector-local (angle, radius) and rotated, so the tree
// cover in front of one base is the tree cover in front of every base.

interface LocalDoodad {
  kind: DoodadSource['kind'];
  a: number;
  r: number;
  scale?: number;
}

function sectorDoodads(): LocalDoodad[] {
  const out: LocalDoodad[] = [];

  // Treeline hugging the mountain rim, one sector's worth (72° at 6° steps).
  for (let a = -36; a < 36; a += 6) {
    out.push({ kind: a % 12 === 0 ? 'treeDark' : 'treeGreen', a, r: 1790 });
  }

  // Flanking cover beside the outcrop in front of the base.
  out.push({ kind: 'rock', a: -16, r: 1180, scale: 1.1 });
  out.push({ kind: 'rock', a: 16, r: 1180, scale: 1.1 });

  // Loose trees on the outer face of the outcrop — cover, with gaps to run.
  for (const a of [-9, 9]) out.push({ kind: 'treeDark', a, r: 1345 });

  // Copse screening the boundary lane's contested camp.
  for (const a of [30, 42]) out.push({ kind: 'treeTeal', a, r: 960 });

  // Bank dressing round the pond and undergrowth elsewhere.
  out.push({ kind: 'bush', a: -18, r: 1600 });
  out.push({ kind: 'bush', a: -24, r: 1120 });
  out.push({ kind: 'flower', a: 8, r: 900 });
  out.push({ kind: 'mushroom', a: -30, r: 780 });
  out.push({ kind: 'flower', a: 26, r: 1520 });

  return out;
}

function buildDoodads(): DoodadSource[] {
  const out: DoodadSource[] = [];
  const local = sectorDoodads();
  for (let k = 0; k < SECTORS; k++) {
    for (const d of local) {
      const { x, z } = polar(d.a, d.r, k);
      out.push({
        kind: d.kind,
        x,
        z,
        // Face outward, so rotated copies look rotated rather than cloned.
        angle: rad(BASE_ANGLE + k * (360 / SECTORS) + d.a),
        scale: d.scale ?? 1,
      });
    }
  }
  return out;
}

// ── Assembly ──────────────────────────────────────────────────────────

function build(): MapSource {
  const px = TILES + 1;
  const pz = TILES + 1;
  const count = px * pz;
  const layer = new Uint8Array(count);
  const texture = new Uint8Array(count);
  const flags = new Uint8Array(count);

  for (let j = 0; j < pz; j++) {
    for (let i = 0; i < px; i++) {
      const k = j * px + i;
      // Tilepoint (i, j) in world space: i east, j north (world z decreases).
      const x = -HALF + i * TILE;
      const z = HALF - j * TILE;
      layer[k] = layerAt(x, z);
      texture[k] = textureAt(x, z);
      if (isRamp(x, z)) flags[k] |= SRC_FLAG_RAMP;
      if (isWater(x, z)) flags[k] |= SRC_FLAG_WATER;
    }
  }

  const camp = (units: CreepTypeId[], a: number, r: number): CampSource[] =>
    ring(a, r).map((p) => ({ x: p.x, z: p.z, units: units.slice() }));

  const camps: CampSource[] = [
    // Centre plateau: the map's richest camp, guarding the high ground.
    { x: 0, z: 0, units: ['orc', 'orc', 'dino', 'dragon'] },
    ...camp(['ghoul', 'ghoul', 'ghoul'], EASY_CAMP.a, EASY_CAMP.r),
    ...camp(['cactoro', 'cactoro', 'ghost'], MEDIUM_CAMP.a, MEDIUM_CAMP.r),
  ];

  return {
    name: 'pentad',
    tilesX: TILES,
    tilesZ: TILES,
    layer,
    texture,
    flags,
    doodads: buildDoodads(),
    camps,
    spawns: ring(SPAWN.a, SPAWN.r),
    runes: ring(RUNE.a, RUNE.r),
    fountains: ring(FOUNTAIN.a, FOUNTAIN.r),
    shops: ring(SHOP.a, SHOP.r),
    castles: [],
  };
}

const src = build();
const outPath = path.resolve(__dirname, '..', 'maps', 'pentad.map.json');
fs.writeFileSync(outPath, serializeMapJson(src));
console.log(
  `pentad: ${TILES}×${TILES} tiles, ${src.spawns.length} spawns, ${src.camps.length} camps, ` +
  `${src.runes.length} runes, ${src.fountains.length} fountains, ${src.shops.length} shops, ` +
  `${src.doodads.length} doodads → ${outPath}`,
);
