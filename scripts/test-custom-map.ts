/**
 * Custom-map format test: parses the committed example map, checks the
 * derived terrain/pathing against the rules the game plays by, round-trips
 * both codecs, and reports encoded sizes.
 *
 * Usage:  pnpm tsx scripts/test-custom-map.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseMapJson, serializeMapJson, MapSource } from '../src/world/custom/mapSource';
import { encodeAmap, decodeAmap } from '../src/world/custom/amapCodec';
import { buildCustomMap, buildCustomSimWorld } from '../src/world/custom/buildCustomMap';
import { tileIsRamp, tileIsCliff } from '../src/world/wc3/terrainLevels';
import { isCellWalkable } from '../src/world/wc3/WpmParser';
import { createMatchState } from '../src/sim/state';
import { spawnCamps } from '../src/sim/stepCreeps';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.resolve(__dirname, '..', 'maps', 'glade.map.json');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function gridsEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function main(): Promise<void> {
  const jsonText = fs.readFileSync(MAP_PATH, 'utf8');
  const src = parseMapJson(jsonText);

  // ── JSON round-trip ──
  const src2 = parseMapJson(serializeMapJson(src));
  check('json round-trip: grids', gridsEqual(src.layer, src2.layer) &&
    gridsEqual(src.texture, src2.texture) && gridsEqual(src.flags, src2.flags));
  check('json round-trip: placements', JSON.stringify(src2.doodads) === JSON.stringify(src.doodads) &&
    JSON.stringify(src2.camps) === JSON.stringify(src.camps) &&
    JSON.stringify(src2.spawns) === JSON.stringify(src.spawns));

  // ── Binary round-trip (positions within quantization tolerance) ──
  const bin = await encodeAmap(src);
  const src3 = await decodeAmap(bin);
  check('amap round-trip: header', src3.name === src.name &&
    src3.tilesX === src.tilesX && src3.tilesZ === src.tilesZ);
  check('amap round-trip: grids', gridsEqual(src.layer, src3.layer) &&
    gridsEqual(src.texture, src3.texture) && gridsEqual(src.flags, src3.flags));

  const posTol = (src.tilesX * 128) / 65535 + 1e-6;
  let worstPos = 0;
  let worstAngle = 0;
  const placementsOk =
    src3.doodads.length === src.doodads.length &&
    src.doodads.every((d, i) => {
      const e = src3.doodads[i];
      worstPos = Math.max(worstPos, Math.abs(e.x - d.x), Math.abs(e.z - d.z));
      const da = Math.abs((((e.angle - d.angle) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      worstAngle = Math.max(worstAngle, da);
      return e.kind === d.kind &&
        Math.abs(e.x - d.x) <= posTol && Math.abs(e.z - d.z) <= posTol &&
        da <= (Math.PI / 256) + 1e-6 && Math.abs(e.scale - d.scale) <= 0.005;
    }) &&
    src.camps.every((c, i) => Math.abs(src3.camps[i].x - c.x) <= posTol &&
      Math.abs(src3.camps[i].z - c.z) <= posTol &&
      JSON.stringify(src3.camps[i].units) === JSON.stringify(c.units)) &&
    src.spawns.every((s, i) => Math.abs(src3.spawns[i].x - s.x) <= posTol &&
      Math.abs(src3.spawns[i].z - s.z) <= posTol);
  check('amap round-trip: placements', placementsOk,
    `worst pos err ${worstPos.toFixed(3)}u, angle err ${(worstAngle * 180 / Math.PI).toFixed(2)}°`);

  // ── Derived map ──
  const custom = buildCustomMap(src);
  const t = custom.data.terrain;
  check('bounds', custom.data.bounds.minX === -1536 && custom.data.bounds.maxZ === 1536 &&
    t.width === 25 && t.height === 25);

  // Plateau/ramp classification: ramp tiles walkable, flanking cliffs not.
  check('ramp tiles classify as ramps', tileIsRamp(t, 18, 15) && tileIsRamp(t, 19, 15));
  check('flanking plateau edge is cliff', tileIsCliff(t, 17, 15) && tileIsCliff(t, 20, 15));

  const p = custom.data.pathing;
  const cellOf = (ti: number, tj: number) => ({ col: ti * 4 + 2, row: tj * 4 + 2 });
  const ramp = cellOf(18, 15);
  const cliff = cellOf(17, 15);
  check('pathing: ramp open, cliff blocked, boundary blocked',
    isCellWalkable(p, ramp.col, ramp.row) &&
    !isCellWalkable(p, cliff.col, cliff.row) &&
    !isCellWalkable(p, 0, 0));

  // Pond: interior floor below rim, water level above both, dry land dry.
  const k = (i: number, j: number) => j * t.width + i;
  check('pond heights', t.finalHeight[k(4, 4)] === -64 && t.finalHeight[k(3, 3)] === -25 &&
    t.finalWaterHeight[k(4, 4)] > t.finalHeight[k(4, 4)] &&
    t.finalHeight[k(12, 12)] === 0);
  check('plateau height', t.finalHeight[k(20, 20)] === 128);

  check('rock obstacles', custom.obstacles.length === 2 &&
    custom.obstacles[0].maxX - custom.obstacles[0].minX === 80);

  // ── SimWorld: spawns reach every camp (the plateau one via the ramp) ──
  const world = buildCustomSimWorld(src);
  for (const [i, camp] of custom.camps.entries()) {
    const path01 = world.pathfinder.findSmoothedPath(
      custom.spawns[0].x, custom.spawns[0].z, camp.x, camp.z);
    check(`path spawn0 → ${camp.id}`, path01 !== null,
      path01 ? `${path01.length} waypoints` : 'unreachable');
    void i;
  }

  // ── Camps spawn creeps at authored positions ──
  const state = createMatchState();
  spawnCamps(state, world, custom.camps);
  const units = custom.camps.reduce((n, c) => n + c.units.length, 0);
  check('spawnCamps: unit count', state.creeps.length === units,
    `${state.creeps.length}/${units}`);
  const near = state.creeps.every((c) => {
    const camp = custom.camps.find((x) => x.id === c.campId)!;
    return Math.hypot(c.pos.x - camp.x, c.pos.z - camp.z) < 300;
  });
  check('spawnCamps: creeps near authored centers', near);

  // ── Sizes ──
  const wc3Bytes = ['war3map.w3e', 'war3map.wpm', 'war3map.doo']
    .map((f) => fs.statSync(path.resolve(__dirname, '..', 'assets', f)).size)
    .reduce((a, b) => a + b, 0);
  console.log(`\nsizes: .map.json ${jsonText.length} B, .amap ${bin.length} B ` +
    `(wc3 arena binaries: ${(wc3Bytes / 1024).toFixed(0)} KB)`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
