/**
 * Editor persistence: talks to the dev-server's /maps API (vite.config.ts
 * mapsPlugin). Saving writes BOTH encodings — the git-diffable .map.json
 * working file and the compact .amap the game prefers — so a published
 * binary can never go stale.
 */
import { MapSource, parseMapJson, serializeMapJson } from '../world/custom/mapSource';
import { encodeAmap, decodeAmap } from '../world/custom/amapCodec';

export async function listMaps(): Promise<string[]> {
  const res = await fetch('/maps/index.json');
  if (!res.ok) return [];
  return (await res.json()) as string[];
}

export async function loadMapSource(name: string): Promise<MapSource> {
  const jsonRes = await fetch(`/maps/${name}.map.json`);
  if (jsonRes.ok) {
    const text = await jsonRes.text();
    if (text.trimStart().startsWith('{')) return parseMapJson(text);
  }
  const binRes = await fetch(`/maps/${name}.amap`);
  if (binRes.ok) return decodeAmap(await binRes.arrayBuffer());
  throw new Error(`map '${name}' not found`);
}

export async function saveMapSource(src: MapSource): Promise<{ jsonBytes: number; amapBytes: number }> {
  const json = serializeMapJson(src);
  const bin = await encodeAmap(src);
  const putJson = await fetch(`/maps/${src.name}.map.json`, { method: 'PUT', body: json });
  const putBin = await fetch(`/maps/${src.name}.amap`, { method: 'PUT', body: bin.slice().buffer as ArrayBuffer });
  if (!putJson.ok || !putBin.ok) {
    throw new Error(`save failed (${putJson.status}/${putBin.status}) — is this the vite dev server?`);
  }
  return { jsonBytes: json.length, amapBytes: bin.length };
}

const LAST_MAP_KEY = 'archer-editor-last-map';

export function rememberLastMap(name: string): void {
  try {
    localStorage.setItem(LAST_MAP_KEY, name);
  } catch { /* private mode etc. */ }
}

export function lastMapName(): string | null {
  try {
    return localStorage.getItem(LAST_MAP_KEY);
  } catch {
    return null;
  }
}
