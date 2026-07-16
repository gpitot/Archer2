import { W3ETerrain, TILE_SIZE, FLAG_RAMP } from './W3EParser';

/**
 * Discrete WC3 terrain-level model, shared by the cliff mesher (Wc3Terrain)
 * and the gameplay samplers so the rendered stepped cliffs and the sampled
 * heights cannot drift apart.
 *
 * A tile classifies as:
 *  - uniform — all 4 corner tilepoints on one cliff layer → smooth bilinear
 *    surface (keeps WC3's intra-level rolling height noise);
 *  - ramp — mixed layers with ≥2 FLAG_RAMP corners → smooth bilinear surface
 *    (WC3's walkable ramps between levels);
 *  - cliff — mixed layers otherwise → stepped: plateau over the high corners,
 *    floor over the low corners, vertical wall along the contour through the
 *    tile-edge midpoints.
 */

/** Vertex of a plateau/floor polygon. `k` is the source tilepoint index. */
export interface CliffPoint {
  x: number;
  z: number;
  h: number;
  k: number;
}

/** Where the high/low contour crosses a tile edge (at its midpoint). */
export interface CliffCrossing {
  x: number;
  z: number;
  /** Plateau height at the crossing (steps against cliff neighbors, tapers to the midpoint against ramps). */
  topH: number;
  /** Floor height at the crossing. */
  botH: number;
  /** Walk-order edge index: 0=S, 1=E, 2=N, 3=W. */
  edge: number;
  hiK: number;
  loK: number;
}

export interface CliffTileGeometry {
  /** Bit c set ⇔ corner c is above the tile's lowest layer (walk order SW, SE, NE, NW). */
  mask: number;
  /** Two opposite high corners (0b0101 / 0b1010): two plateau triangles + hexagon floor. */
  diagonal: boolean;
  /** Plateau polygon in walk order (empty when diagonal). */
  polyHigh: CliffPoint[];
  /** Floor polygon in walk order (hexagon when diagonal). */
  polyLow: CliffPoint[];
  crossings: CliffCrossing[];
  /** Diagonal tiles only: [corner, next crossing, prev crossing] per high corner. */
  highTris: [CliffPoint, CliffPoint, CliffPoint][];
}

/** Tile (i, j) containing a world position, clamped like sampleTilepointGrid. */
export function tileIndexAt(t: W3ETerrain, wx: number, wz: number): { i: number; j: number } {
  const u = (wx - t.offsetX) / TILE_SIZE;
  const v = (-wz - t.offsetY) / TILE_SIZE;
  const cu = Math.min(Math.max(u, 0), t.width - 1.001);
  const cv = Math.min(Math.max(v, 0), t.height - 1.001);
  return { i: Math.floor(cu), j: Math.floor(cv) };
}

/** Corner layer spread and ramp-flag count of tile (i, j); null out of bounds. */
function tileCornerStats(t: W3ETerrain, i: number, j: number): { mixed: boolean; ramps: number } | null {
  if (i < 0 || j < 0 || i >= t.width - 1 || j >= t.height - 1) return null;
  const kSW = j * t.width + i;
  const ks = [kSW, kSW + 1, kSW + t.width, kSW + t.width + 1];
  let minL = 15;
  let maxL = 0;
  let ramps = 0;
  for (const k of ks) {
    const l = t.layer[k];
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
    if ((t.flags[k] & FLAG_RAMP) !== 0) ramps++;
  }
  return { mixed: minL !== maxL, ramps };
}

/** True when tile (i, j) is a walkable ramp (mixed layers, ≥2 ramp corners). */
export function tileIsRamp(t: W3ETerrain, i: number, j: number): boolean {
  const s = tileCornerStats(t, i, j);
  return s !== null && s.mixed && s.ramps >= 2;
}

/** True when tile (i, j) is a stepped cliff (mixed layers, not a ramp). */
export function tileIsCliff(t: W3ETerrain, i: number, j: number): boolean {
  const s = tileCornerStats(t, i, j);
  return s === null || (s.mixed && s.ramps < 2);
}

/** Discrete cliff layer at a world position (nearest tilepoint). */
export function layerAt(t: W3ETerrain, wx: number, wz: number): number {
  const u = (wx - t.offsetX) / TILE_SIZE;
  const v = (-wz - t.offsetY) / TILE_SIZE;
  const i = Math.min(Math.max(Math.round(u), 0), t.width - 1);
  const j = Math.min(Math.max(Math.round(v), 0), t.height - 1);
  return t.layer[j * t.width + i];
}

/**
 * How far up its slope a ramp position must be before it counts as the upper
 * layer for vision. WC3 flips the cliff level near the top of a ramp, so from
 * below you can see most of the ramp, and a unit climbing gains high-ground
 * vision just before cresting.
 */
export const RAMP_UPPER_FRACTION = 0.7;

/**
 * Cliff layer for *vision* purposes. Same as `layerAt` everywhere except on
 * ramp tiles, where nearest-tilepoint sampling flips to the upper layer far
 * too early (making the whole ramp read as high ground from below). Here a
 * ramp position belongs to the lower layer until its interpolated height
 * crosses RAMP_UPPER_FRACTION of the slope.
 */
export function visionLayerAt(t: W3ETerrain, wx: number, wz: number): number {
  const { i, j } = tileIndexAt(t, wx, wz);
  if (!tileIsRamp(t, i, j)) return layerAt(t, wx, wz);

  const w = t.width;
  const kSW = j * w + i;
  const corners = [kSW, kSW + 1, kSW + w, kSW + w + 1];
  let lowL = 15;
  let highL = 0;
  for (const k of corners) {
    const l = t.layer[k];
    if (l < lowL) lowL = l;
    if (l > highL) highL = l;
  }

  // Average corner finalHeights per layer so WC3's rolling height noise
  // doesn't skew the slope fraction.
  let hLow = 0;
  let nLow = 0;
  let hHigh = 0;
  let nHigh = 0;
  for (const k of corners) {
    if (t.layer[k] === lowL) {
      hLow += t.finalHeight[k];
      nLow++;
    } else if (t.layer[k] === highL) {
      hHigh += t.finalHeight[k];
      nHigh++;
    }
  }
  hLow /= nLow;
  hHigh /= nHigh;

  const h = bilinearHeightAt(t, wx, wz);
  const frac = (h - hLow) / Math.max(hHigh - hLow, 1e-6);
  return frac >= RAMP_UPPER_FRACTION ? highL : lowL;
}

/**
 * Plateau/floor polygons and wall crossings for a cliff tile. The mesher
 * emits exactly these polygons (fan-triangulated from vertex 0), so
 * `steppedHeightAt` below samples the same surface the player sees.
 */
export function cliffTileGeometry(t: W3ETerrain, i: number, j: number): CliffTileGeometry {
  const w = t.width;
  const H = t.finalHeight;

  // Corner tilepoints in boundary-walk order: SW, SE, NE, NW
  // (j grows northward; north edge has smaller world z).
  const kSW = j * w + i;
  const corners = [kSW, kSW + 1, kSW + w + 1, kSW + w];

  const x0 = t.offsetX + i * TILE_SIZE;
  const zS = -(t.offsetY + j * TILE_SIZE);
  const zN = zS - TILE_SIZE;
  const xs = [x0, x0 + TILE_SIZE, x0 + TILE_SIZE, x0];
  const zs = [zS, zS, zN, zN];

  const layers = corners.map((k) => t.layer[k]);
  const minL = Math.min(...layers);
  const isHigh = layers.map((l) => l > minL);
  let mask = 0;
  for (let c = 0; c < 4; c++) if (isHigh[c]) mask |= 1 << c;

  // Neighbor tile across each edge in walk order S, E, N, W.
  const neighborIsCliff = [
    tileIsCliff(t, i, j - 1),
    tileIsCliff(t, i + 1, j),
    tileIsCliff(t, i, j + 1),
    tileIsCliff(t, i - 1, j),
  ];

  const polyHigh: CliffPoint[] = [];
  const polyLow: CliffPoint[] = [];
  const crossings: CliffCrossing[] = [];

  for (let c = 0; c < 4; c++) {
    const k = corners[c];
    const pt: CliffPoint = { x: xs[c], z: zs[c], h: H[k], k };
    (isHigh[c] ? polyHigh : polyLow).push(pt);

    const nc = (c + 1) & 3;
    if (isHigh[c] !== isHigh[nc]) {
      const hiK = corners[isHigh[c] ? c : nc];
      const loK = corners[isHigh[c] ? nc : c];
      // When the tile across this edge is another cliff tile, it emits the
      // same stepped midpoint profile — keep the full step. Against a
      // smooth ramp (or the map border) taper to the edge's straight-line
      // midpoint so the surfaces meet without a gap.
      const step = neighborIsCliff[c];
      const avg = (H[hiK] + H[loK]) / 2;
      const cross: CliffCrossing = {
        x: (xs[c] + xs[nc]) / 2,
        z: (zs[c] + zs[nc]) / 2,
        topH: step ? H[hiK] : avg,
        botH: step ? H[loK] : avg,
        edge: c,
        hiK,
        loK,
      };
      crossings.push(cross);
      polyHigh.push({ x: cross.x, z: cross.z, h: cross.topH, k: hiK });
      polyLow.push({ x: cross.x, z: cross.z, h: cross.botH, k: loK });
    }
  }

  const diagonal = mask === 0b0101 || mask === 0b1010;
  const highTris: [CliffPoint, CliffPoint, CliffPoint][] = [];
  if (diagonal) {
    for (let c = 0; c < 4; c++) {
      if (!isHigh[c]) continue;
      const k = corners[c];
      const prev = crossings.find((cr) => cr.edge === ((c + 3) & 3))!;
      const next = crossings.find((cr) => cr.edge === c)!;
      highTris.push([
        { x: xs[c], z: zs[c], h: H[k], k },
        { x: next.x, z: next.z, h: next.topH, k },
        { x: prev.x, z: prev.z, h: prev.topH, k },
      ]);
    }
  }

  return { mask, diagonal, polyHigh, polyLow, crossings, highTris };
}

/** Smooth bilinear height over finalHeight (same math as sampleTilepointGrid). */
export function bilinearHeightAt(t: W3ETerrain, wx: number, wz: number): number {
  const u = (wx - t.offsetX) / TILE_SIZE;
  const v = (-wz - t.offsetY) / TILE_SIZE;
  const cu = Math.min(Math.max(u, 0), t.width - 1.001);
  const cv = Math.min(Math.max(v, 0), t.height - 1.001);
  const i = Math.floor(cu);
  const j = Math.floor(cv);
  const fu = cu - i;
  const fv = cv - j;
  const w = t.width;
  const H = t.finalHeight;
  const h00 = H[j * w + i];
  const h10 = H[j * w + i + 1];
  const h01 = H[(j + 1) * w + i];
  const h11 = H[(j + 1) * w + i + 1];
  return (
    h00 * (1 - fu) * (1 - fv) +
    h10 * fu * (1 - fv) +
    h01 * (1 - fu) * fv +
    h11 * fu * fv
  );
}

/**
 * Height of the stepped terrain surface: bilinear on uniform/ramp tiles,
 * the mesher's plateau/floor surface on cliff tiles. Points on the contour
 * resolve to the high side; the vertical wall face itself has no thickness.
 */
export function steppedHeightAt(t: W3ETerrain, wx: number, wz: number): number {
  const { i, j } = tileIndexAt(t, wx, wz);
  if (!tileIsCliff(t, i, j)) return bilinearHeightAt(t, wx, wz);

  const g = cliffTileGeometry(t, i, j);
  if (g.diagonal) {
    for (const tri of g.highTris) {
      const h = triHeight(tri[0], tri[1], tri[2], wx, wz);
      if (h !== null) return h;
    }
    return fanHeight(g.polyLow, wx, wz);
  }
  if (g.polyHigh.length >= 3) {
    const h = fanHeightInside(g.polyHigh, wx, wz);
    if (h !== null) return h;
  }
  return fanHeight(g.polyLow, wx, wz);
}

// Slightly permissive so contour/edge points land in a triangle instead of
// falling through to the nearest-vertex fallback.
const BARY_EPS = -1e-4;

/** Barycentric height inside triangle abc, or null when (x, z) is outside. */
function triHeight(a: CliffPoint, b: CliffPoint, c: CliffPoint, x: number, z: number): number | null {
  const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (d === 0) return null;
  const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
  const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
  const wc = 1 - wa - wb;
  if (wa < BARY_EPS || wb < BARY_EPS || wc < BARY_EPS) return null;
  return wa * a.h + wb * b.h + wc * c.h;
}

/** Height from the polygon's fan triangulation (0, f, f+1), or null when outside. */
function fanHeightInside(poly: CliffPoint[], x: number, z: number): number | null {
  for (let f = 1; f < poly.length - 1; f++) {
    const h = triHeight(poly[0], poly[f], poly[f + 1], x, z);
    if (h !== null) return h;
  }
  return null;
}

/** Like fanHeightInside, but falls back to the nearest vertex for FP edge cases. */
function fanHeight(poly: CliffPoint[], x: number, z: number): number {
  const h = fanHeightInside(poly, x, z);
  if (h !== null) return h;
  let best = poly[0].h;
  let bestD = Infinity;
  for (const p of poly) {
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bestD) {
      bestD = d;
      best = p.h;
    }
  }
  return best;
}
