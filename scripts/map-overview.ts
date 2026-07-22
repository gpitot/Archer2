/**
 * Render a top-down PNG of a custom map from its *baked* data — nav-grid
 * walkability, cliff layers, water — with every placement marked. This is the
 * fastest way to eyeball whether a generated layout is actually symmetric,
 * since it draws what the sim sees rather than what the renderer shows.
 *
 * Usage:  pnpm tsx scripts/map-overview.ts <mapName> [out.png]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { parseMapJson, SRC_FLAG_WATER, pointsX } from '../src/world/custom/mapSource';
import { buildCustomMap, buildCustomSimWorld } from '../src/world/custom/buildCustomMap';

const NAME = process.argv[2] ?? 'pentad';
const OUT = process.argv[3] ?? `/tmp/overview-${NAME}.png`;

const src = parseMapJson(
  readFileSync(resolve(import.meta.dirname, '..', 'maps', `${NAME}.map.json`), 'utf8'),
);
const map = buildCustomMap(src);
const world = buildCustomSimWorld(src);
const grid = world.navGrid;

const W = grid.width;
const H = grid.height;
const SCALE = 3;
const IW = W * SCALE;
const IH = H * SCALE;
const px = new Uint8Array(IW * IH * 3);

const set = (x: number, y: number, c: [number, number, number]) => {
  if (x < 0 || y < 0 || x >= IW || y >= IH) return;
  const o = (y * IW + x) * 3;
  px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
};

// ── Terrain pass ──────────────────────────────────────────────────────

const pxs = pointsX(src);
const t = map.data.terrain;

for (let gz = 0; gz < H; gz++) {
  for (let gx = 0; gx < W; gx++) {
    const { wx, wz } = grid.gridToWorld(gx, gz);
    // Nearest tilepoint, for layer/water lookup.
    const i = Math.min(Math.max(Math.round((wx - t.offsetX) / 128), 0), pxs - 1);
    const j = Math.min(Math.max(Math.round((-wz - t.offsetY) / 128), 0), t.height - 1);
    const k = j * pxs + i;
    const layer = src.layer[k];
    const water = (src.flags[k] & SRC_FLAG_WATER) !== 0;

    let c: [number, number, number];
    if (!grid.isWalkable(gx, gz)) c = layer >= 4 ? [58, 52, 48] : [92, 82, 74]; // mountain / cliff
    else if (water) c = [70, 120, 160];
    else if (layer === 3) c = [150, 138, 106];   // plateau
    else c = [86, 128, 70];                      // grass
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) set(gx * SCALE + dx, gz * SCALE + dy, c);
  }
}

// ── Placement pass ────────────────────────────────────────────────────

function mark(p: { x: number; z: number }, c: [number, number, number], r: number): void {
  const g = grid.worldToGrid(p.x, p.z);
  const cx = g.gx * SCALE;
  const cy = g.gz * SCALE;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) set(cx + dx, cy + dy, c);
    }
  }
}

for (const c of map.camps) mark(c, [200, 60, 60], 4);                     // camps: red
for (const s of map.shops) mark(s, [235, 200, 60], 4);                    // shops: yellow
for (const f of map.fountains) mark(f.pos, [90, 220, 230], 4);            // fountains: cyan
for (const r of map.runes) mark(r, [210, 110, 235], 4);                   // runes: purple
for (const s of map.spawns) mark(s, [255, 255, 255], 6);                  // spawns: white

// ── PNG encode ────────────────────────────────────────────────────────

const raw = Buffer.alloc(IH * (IW * 3 + 1));
for (let y = 0; y < IH; y++) {
  raw[y * (IW * 3 + 1)] = 0;
  Buffer.from(px.subarray(y * IW * 3, (y + 1) * IW * 3)).copy(raw, y * (IW * 3 + 1) + 1);
}

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

let table: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(IW, 0);
ihdr.writeUInt32BE(IH, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]));

console.log(`${NAME}: ${IW}×${IH} → ${OUT}`);
console.log('  white=spawns  yellow=shops  cyan=fountains  purple=runes  red=camps');
