/**
 * Parser for Warcraft III `war3map.wpm` pathing maps.
 *
 * One byte per 32×32-unit cell (4×4 cells per terrain tile), rows stored
 * bottom-to-top like the w3e. This is the editor-baked ground truth for
 * walkability — cliffs, deep water, map boundary, and doodad footprints
 * are already stamped in.
 */

export interface WpmPathing {
  /** Cells per row (map width in tiles × 4). */
  width: number;
  /** Cells per column (map height in tiles × 4). */
  height: number;
  /** Raw flag byte per cell, index = row * width + col (row 0 = south). */
  cells: Uint8Array;
}

export const WPM_NO_WALK = 0x02;
export const WPM_NO_FLY = 0x04;
export const WPM_NO_BUILD = 0x08;

export const PATH_CELL_SIZE = 32;

export function parseWpm(buffer: ArrayBuffer): WpmPathing {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (magic !== 'MP3W') throw new Error(`wpm: bad magic "${magic}"`);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  if (16 + width * height !== buffer.byteLength) {
    throw new Error(`wpm: size mismatch (${width}x${height} vs ${buffer.byteLength} bytes)`);
  }
  return { width, height, cells: new Uint8Array(buffer, 16, width * height) };
}

export function isCellWalkable(pathing: WpmPathing, col: number, row: number): boolean {
  if (col < 0 || col >= pathing.width || row < 0 || row >= pathing.height) return false;
  return (pathing.cells[row * pathing.width + col] & WPM_NO_WALK) === 0;
}
