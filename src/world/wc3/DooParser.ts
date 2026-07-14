/**
 * Parser for Warcraft III `war3map.doo` doodad placement files
 * (version 8, subversion 11 — 50-byte records).
 *
 * Positions are absolute WC3 world coordinates (x east, y north, z up).
 * Angles are radians, counter-clockwise from east.
 */

export interface DoodadPlacement {
  /** Four-character type ID, e.g. 'ATtr'. */
  typeId: string;
  variation: number;
  x: number;
  y: number;
  z: number;
  /** Facing in radians (CCW from east). */
  angle: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /** 0 = invisible+nonsolid, 1 = visible+nonsolid, 2 = normal. */
  flags: number;
  /** Life percentage (0–100). */
  life: number;
}

const RECORD_SIZE = 50;

export function parseDoo(buffer: ArrayBuffer): DoodadPlacement[] {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (magic !== 'W3do') throw new Error(`doo: bad magic "${magic}"`);
  const version = view.getUint32(4, true);
  if (version !== 8) throw new Error(`doo: unsupported version ${version}`);
  const count = view.getUint32(12, true);
  if (16 + count * RECORD_SIZE > buffer.byteLength) {
    throw new Error(`doo: file too small for ${count} records`);
  }

  const doodads: DoodadPlacement[] = [];
  for (let k = 0; k < count; k++) {
    const o = 16 + k * RECORD_SIZE;
    const flags = view.getUint8(o + 40);
    if (flags === 0) continue; // invisible in-game

    doodads.push({
      typeId: String.fromCharCode(
        view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3),
      ),
      variation: view.getInt32(o + 4, true),
      x: view.getFloat32(o + 8, true),
      y: view.getFloat32(o + 12, true),
      z: view.getFloat32(o + 16, true),
      angle: view.getFloat32(o + 20, true),
      scaleX: view.getFloat32(o + 24, true),
      scaleY: view.getFloat32(o + 28, true),
      scaleZ: view.getFloat32(o + 32, true),
      flags,
      life: view.getUint8(o + 41),
    });
  }
  return doodads;
}
