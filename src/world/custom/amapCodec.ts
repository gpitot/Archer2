/**
 * `.amap` — the published binary encoding of a MapSource.
 *
 * Layout: 4-byte magic "AMAP", u8 version, then a deflate-raw stream of:
 *
 *   u8  name length, utf8 name
 *   u16 tilesX, u16 tilesZ
 *   terrain, (tilesX+1)·(tilesZ+1) tilepoints:
 *     1 byte/point: layer << 4 | texture   (w3e order, south row first)
 *     flags packed 4 points/byte (2 bits each)
 *   u16 doodad count, then per doodad:
 *     u8 kind, u16 qx, u16 qz, u8 angle (×256/2π), u8 scale (×100)
 *   u8  camp count, then per camp: u16 qx, u16 qz, u8 n, n × u8 creep type
 *   u8 spawn count, then per spawn: u16 qx, u16 qz
 *   u8 rune count, then per rune: u16 qx, u16 qz   (v2+; absent in v1)
 *   u8 fountain count, then per fountain: u16 qx, u16 qz   (v3+; absent in v1–v2)
 *   u8 shop count, then per shop: u16 qx, u16 qz   (v4+; absent in v1–v3)
 *
 * Positions are quantized to u16 across the map extent (≤0.25 world units
 * of error at the 128-tile maximum). Compression uses the platform-native
 * CompressionStream — same API in browsers and Node ≥18 — so encode/decode
 * are async. Typical result: a 64×64 map lands well under 4 KB.
 */
import {
  MapSource, DOODAD_KINDS, DoodadKind, CREEP_TYPE_IDS, MAP_VERSION,
  validateMapName, pointsX, pointsZ,
} from './mapSource';
import { TILE_SIZE } from '../wc3/W3EParser';
import type { CreepTypeId } from '../../sim/creepRules';

const MAGIC = 'AMAP';

export async function encodeAmap(src: MapSource): Promise<Uint8Array> {
  validateMapName(src.name);
  const w = new ByteWriter();

  const name = new TextEncoder().encode(src.name);
  w.u8(name.length);
  w.bytes(name);
  w.u16(src.tilesX);
  w.u16(src.tilesZ);

  const count = pointsX(src) * pointsZ(src);
  for (let k = 0; k < count; k++) {
    w.u8(((src.layer[k] & 0xf) << 4) | (src.texture[k] & 0xf));
  }
  for (let k = 0; k < count; k += 4) {
    let b = 0;
    for (let n = 0; n < 4 && k + n < count; n++) b |= (src.flags[k + n] & 0x3) << (n * 2);
    w.u8(b);
  }

  const q = quantizer(src);
  w.u16(src.doodads.length);
  for (const d of src.doodads) {
    w.u8(DOODAD_KINDS.indexOf(d.kind));
    w.u16(q.qx(d.x));
    w.u16(q.qz(d.z));
    w.u8(Math.round((((d.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 256) & 0xff);
    w.u8(clamp(Math.round(d.scale * 100), 25, 255));
  }

  w.u8(src.camps.length);
  for (const c of src.camps) {
    w.u16(q.qx(c.x));
    w.u16(q.qz(c.z));
    w.u8(c.units.length);
    for (const u of c.units) w.u8(CREEP_TYPE_IDS.indexOf(u));
  }

  w.u8(src.spawns.length);
  for (const s of src.spawns) {
    w.u16(q.qx(s.x));
    w.u16(q.qz(s.z));
  }

  w.u8(src.runes.length);
  for (const r of src.runes) {
    w.u16(q.qx(r.x));
    w.u16(q.qz(r.z));
  }

  // Fountains (v3+)
  w.u8(src.fountains.length);
  for (const f of src.fountains) {
    w.u16(q.qx(f.x));
    w.u16(q.qz(f.z));
  }

  // Shops (v4+)
  w.u8(src.shops.length);
  for (const s of src.shops) {
    w.u16(q.qx(s.x));
    w.u16(q.qz(s.z));
  }

  const compressed = await deflate(w.finish());
  const out = new Uint8Array(5 + compressed.length);
  out[0] = MAGIC.charCodeAt(0);
  out[1] = MAGIC.charCodeAt(1);
  out[2] = MAGIC.charCodeAt(2);
  out[3] = MAGIC.charCodeAt(3);
  out[4] = MAP_VERSION;
  out.set(compressed, 5);
  return out;
}

export async function decodeAmap(buf: ArrayBuffer | Uint8Array): Promise<MapSource> {
  const raw = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic !== MAGIC) throw new Error(`amap: bad magic "${magic}"`);
  const version = raw[4];
  if (version !== MAP_VERSION && version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`amap: unsupported version ${version}`);
  }

  const r = new ByteReader(await inflate(raw.subarray(5)));

  const nameLen = r.u8();
  const name = new TextDecoder().decode(r.bytes(nameLen));
  validateMapName(name);
  const tilesX = r.u16();
  const tilesZ = r.u16();
  const px = tilesX + 1;
  const pz = tilesZ + 1;
  const count = px * pz;

  const layer = new Uint8Array(count);
  const texture = new Uint8Array(count);
  const flags = new Uint8Array(count);
  for (let k = 0; k < count; k++) {
    const b = r.u8();
    layer[k] = b >> 4;
    texture[k] = b & 0xf;
  }
  for (let k = 0; k < count; k += 4) {
    const b = r.u8();
    for (let n = 0; n < 4 && k + n < count; n++) flags[k + n] = (b >> (n * 2)) & 0x3;
  }

  const q = dequantizer(tilesX, tilesZ);
  const nDoodads = r.u16();
  const doodads = [];
  for (let i = 0; i < nDoodads; i++) {
    const kind = DOODAD_KINDS[r.u8()] as DoodadKind | undefined;
    if (!kind) throw new Error('amap: bad doodad kind');
    doodads.push({
      kind,
      x: q.x(r.u16()),
      z: q.z(r.u16()),
      angle: (r.u8() / 256) * 2 * Math.PI,
      scale: r.u8() / 100,
    });
  }

  const nCamps = r.u8();
  const camps = [];
  for (let i = 0; i < nCamps; i++) {
    const x = q.x(r.u16());
    const z = q.z(r.u16());
    const n = r.u8();
    const units: CreepTypeId[] = [];
    for (let u = 0; u < n; u++) {
      const t = CREEP_TYPE_IDS[r.u8()];
      if (!t) throw new Error('amap: bad creep type');
      units.push(t);
    }
    camps.push({ x, z, units });
  }

  const nSpawns = r.u8();
  const spawns = [];
  for (let i = 0; i < nSpawns; i++) spawns.push({ x: q.x(r.u16()), z: q.z(r.u16()) });

  // Rune spots — v2+; v1 files simply have none.
  const runes = [];
  if (version >= 2) {
    const nRunes = r.u8();
    for (let i = 0; i < nRunes; i++) runes.push({ x: q.x(r.u16()), z: q.z(r.u16()) });
  }

  // Fountains — v3+; earlier files simply have none.
  const fountains = [];
  if (version >= 3) {
    const nFountains = r.u8();
    for (let i = 0; i < nFountains; i++) fountains.push({ x: q.x(r.u16()), z: q.z(r.u16()) });
  }

  // Shops — v4+; earlier files simply have none.
  const shops = [];
  if (version >= 4) {
    const nShops = r.u8();
    for (let i = 0; i < nShops; i++) shops.push({ x: q.x(r.u16()), z: q.z(r.u16()) });
  }

  return { name, tilesX, tilesZ, layer, texture, flags, doodads, camps, spawns, runes, fountains, shops };
}

// ── Quantization ──────────────────────────────────────────────────────
// Maps are origin-centered (see buildCustomMap), extent tiles × TILE_SIZE.

function quantizer(src: { tilesX: number; tilesZ: number }) {
  const w = src.tilesX * TILE_SIZE;
  const h = src.tilesZ * TILE_SIZE;
  return {
    qx: (x: number) => clamp(Math.round(((x + w / 2) / w) * 65535), 0, 65535),
    qz: (z: number) => clamp(Math.round(((z + h / 2) / h) * 65535), 0, 65535),
  };
}

function dequantizer(tilesX: number, tilesZ: number) {
  const w = tilesX * TILE_SIZE;
  const h = tilesZ * TILE_SIZE;
  return {
    x: (q: number) => (q / 65535) * w - w / 2,
    z: (q: number) => (q / 65535) * h - h / 2,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// ── Bytes ─────────────────────────────────────────────────────────────

class ByteWriter {
  private _buf = new Uint8Array(16384);
  private _len = 0;

  u8(v: number): void {
    this._ensure(1);
    this._buf[this._len++] = v & 0xff;
  }

  u16(v: number): void {
    this._ensure(2);
    this._buf[this._len++] = v & 0xff;
    this._buf[this._len++] = (v >> 8) & 0xff;
  }

  bytes(b: Uint8Array): void {
    this._ensure(b.length);
    this._buf.set(b, this._len);
    this._len += b.length;
  }

  finish(): Uint8Array {
    return this._buf.subarray(0, this._len);
  }

  private _ensure(n: number): void {
    if (this._len + n <= this._buf.length) return;
    const grown = new Uint8Array(Math.max(this._buf.length * 2, this._len + n));
    grown.set(this._buf);
    this._buf = grown;
  }
}

class ByteReader {
  private _pos = 0;
  constructor(private _buf: Uint8Array) {}

  u8(): number {
    if (this._pos >= this._buf.length) throw new Error('amap: truncated');
    return this._buf[this._pos++];
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  bytes(n: number): Uint8Array {
    if (this._pos + n > this._buf.length) throw new Error('amap: truncated');
    const out = this._buf.subarray(this._pos, this._pos + n);
    this._pos += n;
    return out;
  }
}

async function pipe(data: Uint8Array, stream: { readable: ReadableStream; writable: WritableStream }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(data.slice());
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate-raw'));
}

function inflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate-raw'));
}
