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
import type { RunePlacement } from '../sim/runeRules';
import type { FountainDef } from '../sim/world';
import type { ShopSource } from './custom/mapSource';

export type MapName = string;

export const BUILTIN_MAP_NAMES = ['arena', 'test'] as const;

export interface LoadedMap {
  name: MapName;
  data: MapData;
  arena: ArenaRect;
  /** Fixed spawn points (offline mode); null → random walkable spawns. */
  spawns: { x: number; z: number }[] | null;
  /** Authored creep camps (custom maps); null → arena-fraction CAMP_DEFS. */
  camps: CampPlacement[] | null;
  /** Authored rune spots (custom maps); null → arena-fraction RUNE_SPOT_DEFS. */
  runes: RunePlacement[] | null;
  /** Authored fountain placements (custom maps); null → built-in placement. */
  fountains: FountainDef[] | null;
  /** Authored shop placements (custom maps); null → built-in placement. */
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
    return {
      name,
      data: buildTestMapData(),
      arena: { ...TEST_MAP_ARENA },
      spawns: TEST_MAP_SPAWNS.map((s) => ({ ...s })),
      camps: null,
      runes: null,
      fountains: null, // test map places fountains programmatically
      shops: null,
    };
  }
  if (name === 'arena') {
    return {
      name: 'arena',
      data: await loadMapData(),
      arena: ARENA_TERRAIN1,
      spawns: null,
      camps: null,
      runes: null,
      fountains: null, // arena map places fountains programmatically
      shops: null,
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
    runes: custom.runes.length > 0 ? custom.runes : null,
    fountains: custom.fountains.length > 0 ? custom.fountains : null,
    shops: custom.shops.length > 0 ? custom.shops : null,
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
