/**
 * Parser for Warcraft III `war3map.w3e` terrain files (version 11).
 *
 * The file is a grid of "tilepoints" (tile corners): a map that is W×H tiles
 * has (W+1)×(H+1) tilepoints. Rows are stored bottom-to-top (south to north),
 * columns left-to-right (west to east).
 */

export interface W3ETerrain {
  /** Main tileset letter (e.g. 'A' = Ashenvale). */
  tileset: string;
  /** Ground tile type IDs, e.g. 'Agrs'. Tilepoint texture index points here. */
  groundTiles: string[];
  /** Cliff tile type IDs, e.g. 'CAgr'. */
  cliffTiles: string[];
  /** Tilepoints per row (map width in tiles + 1). */
  width: number;
  /** Tilepoints per column (map height in tiles + 1). */
  height: number;
  /** World-space offset of the bottom-left (south-west) tilepoint. */
  offsetX: number;
  offsetY: number;

  // Per-tilepoint arrays, length = width * height, index = j * width + i
  // where i runs west→east and j runs south→north.
  /** Raw ground height (world = (raw − 8192) / 4 + (layer − 2) · 128). */
  groundHeight: Int16Array;
  /** Raw water level with boundary bit masked off. */
  waterLevel: Uint16Array;
  /** Ground texture index (0–15) into `groundTiles`. */
  texture: Uint8Array;
  /** Flag bits: 0x10 ramp, 0x20 blight, 0x40 water, 0x80 boundary. */
  flags: Uint8Array;
  /** Ground texture variation. */
  variation: Uint8Array;
  /** Cliff texture index (into `cliffTiles`). */
  cliffTexture: Uint8Array;
  /** Cliff layer (0–15); ground world height adds (layer − 2) · 128. */
  layer: Uint8Array;

  /** Final ground elevation in world units (ready to render). */
  finalHeight: Float32Array;
  /** Water elevation in world units (WC3 subtracts a fixed 89.6 offset). */
  finalWaterHeight: Float32Array;
}

export const TILE_SIZE = 128;
export const FLAG_RAMP = 0x10;
export const FLAG_BLIGHT = 0x20;
export const FLAG_WATER = 0x40;
export const FLAG_BOUNDARY = 0x80;

const HEIGHT_ZERO = 8192;
const HEIGHT_SCALE = 4;
const LAYER_HEIGHT = 128;
const WATER_OFFSET = 89.6;

export function parseW3E(buffer: ArrayBuffer): W3ETerrain {
  const view = new DataView(buffer);
  const magic = readChars(view, 0, 4);
  if (magic !== 'W3E!') throw new Error(`w3e: bad magic "${magic}"`);
  const version = view.getUint32(4, true);
  if (version !== 11) throw new Error(`w3e: unsupported version ${version}`);

  const tileset = String.fromCharCode(view.getUint8(8));
  let offset = 9 + 4; // skip custom-tileset flag

  const nGround = view.getUint32(offset, true);
  offset += 4;
  const groundTiles: string[] = [];
  for (let i = 0; i < nGround; i++, offset += 4) {
    groundTiles.push(readChars(view, offset, 4));
  }

  const nCliff = view.getUint32(offset, true);
  offset += 4;
  const cliffTiles: string[] = [];
  for (let i = 0; i < nCliff; i++, offset += 4) {
    cliffTiles.push(readChars(view, offset, 4));
  }

  const width = view.getUint32(offset, true);
  const height = view.getUint32(offset + 4, true);
  const offsetX = view.getFloat32(offset + 8, true);
  const offsetY = view.getFloat32(offset + 12, true);
  offset += 16;

  const count = width * height;
  if (offset + count * 7 > buffer.byteLength) {
    throw new Error(`w3e: file too small for ${width}x${height} tilepoints`);
  }

  const groundHeight = new Int16Array(count);
  const waterLevel = new Uint16Array(count);
  const texture = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const variation = new Uint8Array(count);
  const cliffTexture = new Uint8Array(count);
  const layer = new Uint8Array(count);
  const finalHeight = new Float32Array(count);
  const finalWaterHeight = new Float32Array(count);

  for (let k = 0; k < count; k++) {
    const o = offset + k * 7;
    const gh = view.getInt16(o, true);
    const wlRaw = view.getUint16(o + 2, true);
    const texFlags = view.getUint8(o + 4);
    const cliffByte = view.getUint8(o + 6);

    const lay = cliffByte & 0x0f;
    groundHeight[k] = gh;
    waterLevel[k] = wlRaw & 0x7fff; // hi bit = boundary marker
    texture[k] = texFlags & 0x0f;
    flags[k] = texFlags & 0xf0;
    variation[k] = view.getUint8(o + 5);
    cliffTexture[k] = (cliffByte & 0xf0) >> 4;
    layer[k] = lay;

    finalHeight[k] = (gh - HEIGHT_ZERO) / HEIGHT_SCALE + (lay - 2) * LAYER_HEIGHT;
    finalWaterHeight[k] = (waterLevel[k] - HEIGHT_ZERO) / HEIGHT_SCALE - WATER_OFFSET;
  }

  return {
    tileset, groundTiles, cliffTiles,
    width, height, offsetX, offsetY,
    groundHeight, waterLevel, texture, flags, variation, cliffTexture, layer,
    finalHeight, finalWaterHeight,
  };
}

function readChars(view: DataView, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}
