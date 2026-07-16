/**
 * Map registry: every playable map by name, plus URL-param resolution.
 *
 * Browser-only (the 'arena' loader fetches the WC3 binaries through vite);
 * headless code uses `buildTestSimWorld` / navdata directly.
 */
import { MapData, ArenaRect, loadMapData, ARENA_TERRAIN1 } from './wc3/MapData';
import { buildTestMapData, TEST_MAP_ARENA, TEST_MAP_SPAWNS } from './testMap';

export type MapName = 'arena' | 'test';

export const MAP_NAMES: readonly MapName[] = ['arena', 'test'];

export interface LoadedMap {
  name: MapName;
  data: MapData;
  arena: ArenaRect;
  /** Fixed spawn points (offline mode); null → random walkable spawns. */
  spawns: { x: number; z: number }[] | null;
}

/** Resolve a `?map=` URL value; unknown/absent falls back to the arena. */
export function resolveMapName(raw: string | null): MapName {
  return raw === 'test' ? 'test' : 'arena';
}

export async function loadMap(name: MapName): Promise<LoadedMap> {
  if (name === 'test') {
    return {
      name,
      data: buildTestMapData(),
      arena: { ...TEST_MAP_ARENA },
      spawns: TEST_MAP_SPAWNS.map((s) => ({ ...s })),
    };
  }
  return {
    name: 'arena',
    data: await loadMapData(),
    arena: ARENA_TERRAIN1,
    spawns: null,
  };
}
