/**
 * Custom-map source format: the author's intent and nothing else.
 *
 * A `MapSource` stores per-tilepoint cliff layers, ground textures, and
 * ramp/water flags, plus doodad/camp/spawn placements. Everything the game
 * needs beyond that — ground heights, water heights, the pathing grid,
 * texture variation — is derived at load time by `buildCustomMap`, so the
 * files stay tiny and client, sim, and server can never disagree.
 *
 * Two on-disk encodings share this in-memory shape:
 *  - `.map.json` (jsonCodec below): the editor's working format, git-diffable
 *    (grids as rows of characters, north row first, so the file reads like
 *    the map on screen).
 *  - `.amap` (amapCodec.ts): the published binary — bit-packed + deflated.
 *
 * Heights come only from cliff layers and pond dips (see map-editor-plan.md):
 * there is no stored height data of any kind.
 */
import type { CreepTypeId } from '../../sim/creepRules';

// ── Types ─────────────────────────────────────────────────────────────

/** Source flags (NOT w3e flag bits — those are derived). */
export const SRC_FLAG_RAMP = 1;
export const SRC_FLAG_WATER = 2;

/** Editor-facing doodad kinds, mapped to representative WC3 type ids. */
export const DOODAD_KINDS = [
  'treeDark', 'treeGreen', 'treeTeal', 'rock', 'bush', 'flower', 'mushroom',
] as const;
export type DoodadKind = (typeof DOODAD_KINDS)[number];

/** WC3 type id per kind — must stay within the sets Doodads.ts and
 * treeFootprints.ts already classify (trees path-block, ARrk is solid). */
export const TYPE_ID_BY_KIND: Record<DoodadKind, string> = {
  treeDark: 'ATtr',
  treeGreen: 'LTlt',
  treeTeal: 'YTpb',
  rock: 'ARrk',
  bush: 'ZPsh',
  flower: 'AWfl',
  mushroom: 'APms',
};

export interface DoodadSource {
  kind: DoodadKind;
  /** World coords (Three.js: x east, z south). */
  x: number;
  z: number;
  /** Radians. */
  angle: number;
  /** Uniform scale, 1 = default. */
  scale: number;
}

export interface CampSource {
  x: number;
  z: number;
  units: CreepTypeId[];
}

export interface SpawnSource {
  x: number;
  z: number;
}

/** A rune spot (power-up rune spawn location). */
export interface RuneSource {
  x: number;
  z: number;
}

/** A healing fountain placement. */
export interface FountainSource {
  x: number;
  z: number;
}

/** A shop placement. */
export interface ShopSource {
  x: number;
  z: number;
}

/** A castle placement — the Defenders-mode objective creeps besiege. */
export interface CastleSource {
  x: number;
  z: number;
}

export interface MapSource {
  name: string;
  /** Size in tiles (tilepoint grids are +1 per axis). */
  tilesX: number;
  tilesZ: number;
  /**
   * Per-tilepoint grids in w3e order: index = j * (tilesX + 1) + i,
   * i west→east, j south→north.
   */
  layer: Uint8Array;
  texture: Uint8Array;
  /** SRC_FLAG_* bits. */
  flags: Uint8Array;
  doodads: DoodadSource[];
  camps: CampSource[];
  spawns: SpawnSource[];
  runes: RuneSource[];
  fountains: FountainSource[];
  shops: ShopSource[];
  castles: CastleSource[];
}

export const MAP_FORMAT = 'archer-map';
/** v5 added castle placements (older files load fine — no castles). */
export const MAP_VERSION = 5;
export const MIN_TILES = 8;
export const MAX_TILES = 128;
/** Ground layer new maps start on (WC3 convention: layer 2 = height 0). */
export const BASE_LAYER = 2;

// Authorable base (tier-0) unit types. Camps climb their ladders on respawn
// (see `campComposition`), so only the entry rungs need to be placeable.
export const CREEP_TYPE_IDS: readonly CreepTypeId[] = [
  'ghoul',
  'cactoro',
  'orc',
  'dino',
  'yeti',
  'ghost',
  'dragon',
];

export function pointsX(src: { tilesX: number }): number {
  return src.tilesX + 1;
}
export function pointsZ(src: { tilesZ: number }): number {
  return src.tilesZ + 1;
}

/** Flat empty map: grass on BASE_LAYER, no flags, nothing placed. */
export function createEmptyMapSource(name: string, tilesX: number, tilesZ: number): MapSource {
  validateDims(tilesX, tilesZ);
  const count = (tilesX + 1) * (tilesZ + 1);
  return {
    name,
    tilesX,
    tilesZ,
    layer: new Uint8Array(count).fill(BASE_LAYER),
    texture: new Uint8Array(count).fill(2), // Agrs grass
    flags: new Uint8Array(count),
    doodads: [],
    camps: [],
    spawns: [],
    runes: [],
    fountains: [],
    shops: [],
    castles: [],
  };
}

export function cloneMapSource(src: MapSource): MapSource {
  return {
    name: src.name,
    tilesX: src.tilesX,
    tilesZ: src.tilesZ,
    layer: src.layer.slice(),
    texture: src.texture.slice(),
    flags: src.flags.slice(),
    doodads: src.doodads.map((d) => ({ ...d })),
    camps: src.camps.map((c) => ({ ...c, units: c.units.slice() })),
    spawns: src.spawns.map((s) => ({ ...s })),
    runes: src.runes.map((r) => ({ ...r })),
    fountains: src.fountains.map((f) => ({ ...f })),
    shops: src.shops.map((s) => ({ ...s })),
    castles: src.castles.map((c) => ({ ...c })),
  };
}

function validateDims(tilesX: number, tilesZ: number): void {
  for (const t of [tilesX, tilesZ]) {
    if (!Number.isInteger(t) || t < MIN_TILES || t > MAX_TILES) {
      throw new Error(`map size must be ${MIN_TILES}..${MAX_TILES} tiles, got ${tilesX}x${tilesZ}`);
    }
  }
}

/** Names are also URL path segments and file names — keep them boring. */
export function validateMapName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(`bad map name "${name}" (want [a-z0-9_-], 1..32 chars)`);
  }
}

// ── JSON codec (.map.json, the editor's working format) ──────────────
//
// Grids are arrays of row strings listed NORTH FIRST (row 0 = north edge,
// j = tilesZ), chars west→east, so the file reads like the map on screen:
//  - layers:   hex digit per tilepoint (cliff layer, usually 2/3/4)
//  - textures: hex digit per tilepoint (index into the Ashenvale palette)
//  - flags:    '.' none, 'r' ramp, 'w' water
// Doodads are compact tuples [kind, x, z, angleDeg, scalePct].

interface MapJson {
  format: string;
  version: number;
  name: string;
  tilesX: number;
  tilesZ: number;
  layers: string[];
  textures: string[];
  flags: string[];
  doodads: [string, number, number, number, number][];
  camps: { x: number; z: number; units: string[] }[];
  spawns: { x: number; z: number }[];
  /** Rune spots — absent in v1 files. */
  runes?: { x: number; z: number }[];
  /** Fountain placements — absent in v1–v2 files. */
  fountains?: { x: number; z: number }[];
  /** Shop placements — absent in v1–v3 files. */
  shops?: { x: number; z: number }[];
  /** Castle placements (Defenders objectives) — absent in v1–v4 files. */
  castles?: { x: number; z: number }[];
}

const FLAG_CHARS: Record<number, string> = {
  0: '.',
  [SRC_FLAG_RAMP]: 'r',
  [SRC_FLAG_WATER]: 'w',
  [SRC_FLAG_RAMP | SRC_FLAG_WATER]: 'W',
};
const FLAG_BY_CHAR: Record<string, number> = { '.': 0, r: SRC_FLAG_RAMP, w: SRC_FLAG_WATER, W: SRC_FLAG_RAMP | SRC_FLAG_WATER };

function gridToRows(src: MapSource, grid: Uint8Array, char: (v: number) => string): string[] {
  const px = pointsX(src);
  const pz = pointsZ(src);
  const rows: string[] = [];
  for (let j = pz - 1; j >= 0; j--) {
    let row = '';
    for (let i = 0; i < px; i++) row += char(grid[j * px + i]);
    rows.push(row);
  }
  return rows;
}

function rowsToGrid(rows: string[], px: number, pz: number, val: (c: string) => number, what: string): Uint8Array {
  if (rows.length !== pz) throw new Error(`${what}: expected ${pz} rows, got ${rows.length}`);
  const grid = new Uint8Array(px * pz);
  for (let r = 0; r < pz; r++) {
    const row = rows[r];
    if (row.length !== px) throw new Error(`${what} row ${r}: expected ${px} chars, got ${row.length}`);
    const j = pz - 1 - r;
    for (let i = 0; i < px; i++) grid[j * px + i] = val(row[i]);
  }
  return grid;
}

export function serializeMapJson(src: MapSource): string {
  validateMapName(src.name);
  const json: MapJson = {
    format: MAP_FORMAT,
    version: MAP_VERSION,
    name: src.name,
    tilesX: src.tilesX,
    tilesZ: src.tilesZ,
    layers: gridToRows(src, src.layer, (v) => v.toString(16)),
    textures: gridToRows(src, src.texture, (v) => v.toString(16)),
    flags: gridToRows(src, src.flags, (v) => FLAG_CHARS[v] ?? '.'),
    doodads: src.doodads.map((d) => [
      d.kind,
      Math.round(d.x),
      Math.round(d.z),
      Math.round(((d.angle * 180) / Math.PI) % 360),
      Math.round(d.scale * 100),
    ]),
    camps: src.camps.map((c) => ({ x: Math.round(c.x), z: Math.round(c.z), units: c.units.slice() })),
    spawns: src.spawns.map((s) => ({ x: Math.round(s.x), z: Math.round(s.z) })),
    runes: src.runes.map((r) => ({ x: Math.round(r.x), z: Math.round(r.z) })),
    fountains: src.fountains.map((f) => ({ x: Math.round(f.x), z: Math.round(f.z) })),
    shops: src.shops.map((s) => ({ x: Math.round(s.x), z: Math.round(s.z) })),
    castles: src.castles.map((c) => ({ x: Math.round(c.x), z: Math.round(c.z) })),
  };
  // Hand-rolled layout: one grid row / doodad per line so diffs stay readable.
  const rows = (a: string[]) => a.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  const items = (a: unknown[]) => a.map((d) => `    ${JSON.stringify(d)}`).join(',\n');
  return `{
  "format": ${JSON.stringify(json.format)},
  "version": ${json.version},
  "name": ${JSON.stringify(json.name)},
  "tilesX": ${json.tilesX},
  "tilesZ": ${json.tilesZ},
  "layers": [
${rows(json.layers)}
  ],
  "textures": [
${rows(json.textures)}
  ],
  "flags": [
${rows(json.flags)}
  ],
  "doodads": [
${items(json.doodads)}
  ],
  "camps": [
${items(json.camps)}
  ],
  "spawns": [
${items(json.spawns)}
  ],
  "runes": [
${items(json.runes ?? [])}
  ],
  "fountains": [
${items(json.fountains ?? [])}
  ],
  "shops": [
${items(json.shops ?? [])}
  ],
  "castles": [
${items(json.castles ?? [])}
  ]
}
`;
}

export function parseMapJson(text: string): MapSource {
  const json = JSON.parse(text) as MapJson;
  if (json.format !== MAP_FORMAT) throw new Error(`not an archer map (format=${json.format})`);
  if (!Number.isInteger(json.version) || json.version < 1 || json.version > MAP_VERSION) {
    throw new Error(`unsupported map version ${json.version}`);
  }
  validateMapName(json.name);
  validateDims(json.tilesX, json.tilesZ);
  const px = json.tilesX + 1;
  const pz = json.tilesZ + 1;

  const hex = (what: string) => (c: string) => {
    const v = parseInt(c, 16);
    if (Number.isNaN(v)) throw new Error(`${what}: bad char "${c}"`);
    return v;
  };
  const flag = (c: string) => {
    const v = FLAG_BY_CHAR[c];
    if (v === undefined) throw new Error(`flags: bad char "${c}"`);
    return v;
  };

  const doodads: DoodadSource[] = (json.doodads ?? []).map((t, idx) => {
    const [kind, x, z, angleDeg, scalePct] = t;
    if (!DOODAD_KINDS.includes(kind as DoodadKind)) {
      throw new Error(`doodad ${idx}: unknown kind "${kind}"`);
    }
    return {
      kind: kind as DoodadKind,
      x, z,
      angle: (angleDeg * Math.PI) / 180,
      scale: scalePct / 100,
    };
  });

  const camps: CampSource[] = (json.camps ?? []).map((c, idx) => {
    for (const u of c.units) {
      if (!CREEP_TYPE_IDS.includes(u as CreepTypeId)) {
        throw new Error(`camp ${idx}: unknown creep type "${u}"`);
      }
    }
    return { x: c.x, z: c.z, units: c.units.slice() as CreepTypeId[] };
  });

  return {
    name: json.name,
    tilesX: json.tilesX,
    tilesZ: json.tilesZ,
    layer: rowsToGrid(json.layers, px, pz, hex('layers'), 'layers'),
    texture: rowsToGrid(json.textures, px, pz, hex('textures'), 'textures'),
    flags: rowsToGrid(json.flags, px, pz, flag, 'flags'),
    doodads,
    camps,
    spawns: (json.spawns ?? []).map((s) => ({ x: s.x, z: s.z })),
    runes: (json.runes ?? []).map((r) => ({ x: r.x, z: r.z })),
    fountains: (json.fountains ?? []).map((f) => ({ x: f.x, z: f.z })),
    shops: (json.shops ?? []).map((s) => ({ x: s.x, z: s.z })),
    castles: (json.castles ?? []).map((c) => ({ x: c.x, z: c.z })),
  };
}
