/**
 * Publish a custom map: encode `maps/<name>.map.json` into the compact
 * `maps/<name>.amap` binary that players actually download.
 *
 * Usage:  pnpm tsx scripts/publish-map.ts <name> | --all
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseMapJson } from '../src/world/custom/mapSource';
import { encodeAmap } from '../src/world/custom/amapCodec';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_DIR = path.resolve(__dirname, '..', 'maps');

async function publish(name: string): Promise<void> {
  const jsonPath = path.join(MAPS_DIR, `${name}.map.json`);
  const src = parseMapJson(fs.readFileSync(jsonPath, 'utf8'));
  const bin = await encodeAmap(src);
  const outPath = path.join(MAPS_DIR, `${name}.amap`);
  fs.writeFileSync(outPath, bin);
  console.log(`${name}: ${fs.statSync(jsonPath).size} B json → ${bin.length} B amap`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: pnpm tsx scripts/publish-map.ts <name> | --all');
    process.exit(1);
  }
  const names = arg === '--all'
    ? fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.map.json')).map((f) => f.replace('.map.json', ''))
    : [arg];
  for (const name of names) await publish(name);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
