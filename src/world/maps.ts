/**
 * Map registry: every playable map by name, plus URL-param resolution.
 *
 * Three kinds of map resolve here:
 *  - 'arena': the original WC3 map (binaries fetched through vite)
 *  - 'test':  the tiny generated debug map
 *  - anything else: a custom editor-made map fetched from `/maps/<name>`
 *    (compact `.amap` binary first, `.map.json` working file as fallback)
 *
 * Browser-only; headless code uses `buildTestSimWorld` / `buildCustomSimWorld`
 * / navdata directly.
 */
import { MapData, ArenaRect, loadMapData, ARENA_TERRAIN1 } from './wc3/MapData';
import { buildTestMapData, TEST_MAP_ARENA, TEST_MAP_SPAWNS } from './testMap';
import { parseMapJson } from './custom/mapSource';
import { decodeAmap } from './custom/amapCodec';
import { buildCustomMap } from './custom/buildCustomMap';
import type { CampPlacement } from '../sim/creepRules';
import { CAMP_DEFS } from '../sim/creepRules';
import type { RunePlacement } from '../sim/runeRules';
import { RUNE_SPOT_DEFS } from '../sim/runeRules';
import type { FountainDef } from '../sim/world';
import { FOUNTAIN } from '../sim/rules';
import type { ShopSource } from './custom/mapSource';

export type MapName = string;

export const BUILTIN_MAP_NAMES = ['arena', 'test'] as const;

export interface LoadedMap {
  name: MapName;
  data: MapData;
  arena: ArenaRect;
  /** Fixed spawn points (offline mode); null → random walkable spawns. */
  spawns: { x: number; z: number }[] | null;
  /** Authored creep camps (null → none). */
  camps: CampPlacement[] | null;
  /** Authored rune spots (null → none). */
  runes: RunePlacement[] | null;
  /** Authored fountain placements (null → none). */
  fountains: FountainDef[] | null;
  /** Authored shop placements (null → none). */
  shops: ShopSource[] | null;
}

/**
 * Resolve a `?map=` URL value. 'arena'/'test' are built in; any other
 * well-formed name is treated as a custom map; junk falls back to the arena.
 */
export function resolveMapName(raw: string | null): MapName {
  if (raw === null || raw === 'arena') return 'arena';
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(raw) ? raw : 'arena';
}

export async function loadMap(name: MapName): Promise<LoadedMap> {
  if (name === 'test') {
    const a = TEST_MAP_ARENA;
    return {
      name,
      data: buildTestMapData(),
      arena: { ...a },
      spawns: TEST_MAP_SPAWNS.map((s) => ({ ...s })),
      camps: CAMP_DEFS.map((def) => ({
        id: def.id,
        x: a.minX + def.fx * a.width,
        z: a.minZ + def.fz * a.height,
        units: def.units,
      })),
      runes: RUNE_SPOT_DEFS.map((def) => ({
        x: a.minX + def.fx * a.width,
        z: a.minZ + def.fz * a.height,
      })),
      fountains: [{ pos: { x: -600, z: 200 }, healRadius: 200, healPerSecond: 100 }],
      shops: [{ x: a.centerX, z: a.centerZ }],
    };
  }
  if (name === 'arena') {
    const a = ARENA_TERRAIN1;
    return {
      name: 'arena',
      data: await loadMapData(),
      arena: a,
      spawns: null,
      camps: CAMP_DEFS.map((def) => ({
        id: def.id,
        x: a.minX + def.fx * a.width,
        z: a.minZ + def.fz * a.height,
        units: def.units,
      })),
      runes: RUNE_SPOT_DEFS.map((def) => ({
        x: a.minX + def.fx * a.width,
        z: a.minZ + def.fz * a.height,
      })),
      fountains: [0.25, 0.75].map((fx) => ({
        pos: { x: a.minX + fx * a.width, z: a.centerZ },
        healRadius: FOUNTAIN.healRadius,
        healPerSecond: FOUNTAIN.healPerSecond,
      })),
      shops: [{ x: a.centerX, z: a.centerZ }],
    };
  }
  return loadCustomMap(name);
}

async function loadCustomMap(name: MapName): Promise<LoadedMap> {
  const src = await fetchMapSource(name);
  const custom = buildCustomMap(src);
  console.info(
    `[map] custom '${name}': ${src.tilesX}x${src.tilesZ} tiles, ` +
    `${src.doodads.length} doodads, ${src.camps.length} camps, ${src.spawns.length} spawns, ` +
    `${src.runes.length} runes`,
  );
  return {
    name,
    data: custom.data,
    arena: custom.arena,
    spawns: custom.spawns.length > 0 ? custom.spawns : null,
    camps: custom.camps,
    runes: custom.runes,
    fountains: custom.fountains,
    shops: custom.shops,
  };
}

/**
 * Fetch a custom map, preferring the compact binary. Static hosts with an
 * SPA fallback answer missing files with 200 + index.html, so besides HTTP
 * status both branches sniff the payload before trusting it.
 */
async function fetchMapSource(name: MapName) {
  const binRes = await fetch(`/maps/${name}.amap`);
  if (binRes.ok) {
    const buf = await binRes.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    if (String.fromCharCode(...head) === 'AMAP') return decodeAmap(buf);
  }
  const jsonRes = await fetch(`/maps/${name}.map.json`);
  if (jsonRes.ok) {
    const text = await jsonRes.text();
    if (text.trimStart().startsWith('{')) return parseMapJson(text);
  }
  throw new Error(`custom map '${name}' not found (${binRes.status}/${jsonRes.status})`);
}
