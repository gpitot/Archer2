/**
 * Phase-0 orientation proof: bake a minimap from the parsed w3e/wpm/doo data
 * and decode the original war3mapPreview.tga, writing both as PNGs for a
 * side-by-side comparison. If the row-order assumption (row 0 = south) is
 * wrong, the two images will be mirrored north–south.
 *
 * Usage: pnpm tsx scripts/minimap-check.ts <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { parseW3E, FLAG_WATER } from '../src/world/wc3/W3EParser';
import { parseWpm, isCellWalkable } from '../src/world/wc3/WpmParser';
import { parseDoo } from '../src/world/wc3/DooParser';

main();

function main(): void {
const outDir = resolve(process.argv[2] ?? '.');
mkdirSync(outDir, { recursive: true });
const asset = (name: string) =>
  readFileSync(resolve(import.meta.dirname, '../assets', name));
const toArrayBuffer = (b: Buffer) =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

// ── Parse map data ──────────────────────────────────────────────
const terrain = parseW3E(toArrayBuffer(asset('war3map.w3e')));
const pathing = parseWpm(toArrayBuffer(asset('war3map.wpm')));
const doodads = parseDoo(toArrayBuffer(asset('war3map.doo')));
console.log(`w3e ${terrain.width}x${terrain.height} tilepoints, tiles ${terrain.groundTiles.join(',')}`);
console.log(`wpm ${pathing.width}x${pathing.height}, doodads ${doodads.length}`);

// Ground colors per tile type (rough Ashenvale palette, minimap only)
const TILE_COLORS: Record<string, [number, number, number]> = {
  Adrt: [122, 90, 58],   // dirt
  Adrd: [100, 72, 46],   // rough dirt
  Agrs: [74, 122, 48],   // grass
  Arck: [128, 124, 116], // rock
  Agrd: [96, 106, 50],   // grassy dirt
  Avin: [52, 84, 44],    // vines
  Adrg: [42, 74, 52],    // dark grass (dominant)
  Alvd: [86, 76, 40],    // leaves
};

// ── Bake minimap: 4 px per tile (one per pathing cell) ─────────
// Image row 0 = north (top). Data row 0 = south → py = (H-1) - row.
const W = pathing.width;   // 640
const H = pathing.height;  // 768
const img = new Uint8Array(W * H * 3);

for (let row = 0; row < H; row++) {
  for (let col = 0; col < W; col++) {
    // Pathing cell → nearest tilepoint (4 cells per tile)
    const ti = Math.min(Math.round(col / 4), terrain.width - 1);
    const tj = Math.min(Math.round(row / 4), terrain.height - 1);
    const k = tj * terrain.width + ti;

    let [r, g, b] = TILE_COLORS[terrain.groundTiles[terrain.texture[k]]] ?? [255, 0, 255];

    // Cliff layer shading (higher = brighter)
    const shade = 0.75 + 0.13 * (terrain.layer[k] - 1);
    r *= shade; g *= shade; b *= shade;

    // Water where the table is above ground
    const depth = terrain.finalWaterHeight[k] - terrain.finalHeight[k];
    if ((terrain.flags[k] & FLAG_WATER) && depth > 0) {
      const deep = Math.min(depth / 128, 1);
      r = 40 - 15 * deep; g = 90 - 30 * deep; b = 120 - 20 * deep;
    } else if (!isCellWalkable(pathing, col, row)) {
      r *= 0.55; g *= 0.55; b *= 0.55; // blocked (doodads, boundary, cliffs)
    }

    const py = H - 1 - row;
    const o = (py * W + col) * 3;
    img[o] = r; img[o + 1] = g; img[o + 2] = b;
  }
}

// Tree doodads as dark green dots
for (const d of doodads) {
  const col = Math.round((d.x - terrain.offsetX) / 32);
  const row = Math.round((d.y - terrain.offsetY) / 32);
  if (col < 0 || col >= W || row < 0 || row >= H) continue;
  const py = H - 1 - row;
  const o = (py * W + col) * 3;
  img[o] = 20; img[o + 1] = 46; img[o + 2] = 24;
}

writeFileSync(join(outDir, 'minimap-baked.png'), encodePng(W, H, img));
console.log(`wrote ${join(outDir, 'minimap-baked.png')}`);

// ── Decode war3mapPreview.tga (uncompressed 32-bit BGRA) ───────
const tga = asset('war3mapPreview.tga');
const tgaW = tga.readUInt16LE(12);
const tgaH = tga.readUInt16LE(14);
const bpp = tga[16];
const descriptor = tga[17];
const topDown = (descriptor & 0x20) !== 0;
if (tga[2] !== 2 || bpp !== 32) throw new Error(`unexpected TGA format: type ${tga[2]}, ${bpp}bpp`);
const prev = new Uint8Array(tgaW * tgaH * 3);
for (let y = 0; y < tgaH; y++) {
  for (let x = 0; x < tgaW; x++) {
    const src = 18 + (y * tgaW + x) * 4;
    const py = topDown ? y : tgaH - 1 - y;
    const o = (py * tgaW + x) * 3;
    prev[o] = tga[src + 2];     // R (TGA stores BGRA)
    prev[o + 1] = tga[src + 1]; // G
    prev[o + 2] = tga[src];     // B
  }
}
writeFileSync(join(outDir, 'preview-original.png'), encodePng(tgaW, tgaH, prev));
console.log(`wrote ${join(outDir, 'preview-original.png')} (${tgaW}x${tgaH}, topDown=${topDown})`);
}

// ── Minimal PNG encoder (RGB8, no filtering) ───────────────────
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    rgb.subarray(y * width * 3, (y + 1) * width * 3)
      .forEach((v, i) => { raw[y * (1 + width * 3) + 1 + i] = v; });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat(chunks);
}

function chunk(type: string, data: Buffer): Buffer {
  const buf = Buffer.alloc(12 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.write(type, 4, 'ascii');
  data.copy(buf, 8);
  buf.writeUInt32BE(crc32(buf.subarray(4, 8 + data.length)), 8 + data.length);
  return buf;
}

function crc32(data: Buffer): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
