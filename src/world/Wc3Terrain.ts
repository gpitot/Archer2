import * as THREE from 'three';
import { MapData, TILE_SIZE, sampleTilepointGrid } from './wc3/MapData';
import { FLAG_WATER } from './wc3/W3EParser';
import { createGroundAtlas, GroundAtlas, CLIFF_CELL_GRASS, CLIFF_CELL_DIRT } from './wc3/GroundTextures';
import { tileIsCliff, cliffTileGeometry, steppedHeightAt, layerAt, visionLayerAt } from './wc3/terrainLevels';

const CHUNK_TILES = 32;

/** Bounds for terrain construction. */
export interface TerrainBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * Renders the original map's terrain: one textured, vertex-colored mesh per
 * 32×32-tile chunk (frustum-culled individually). Every tile gets 4 unique
 * vertices at its corner elevations, textured by the tile's dominant ground
 * type from the procedural atlas.
 *
 * `heightAt` is the single source of truth for ground elevation — it drives
 * hero/projectile Y, camera framing, and prop placement. It samples the same
 * discrete-level model the mesh renders (via wc3/terrainLevels): stepped on
 * cliff tiles, smooth bilinear within a level and on walkable ramps.
 * `smoothHeightAt` keeps the old fully-bilinear sample for consumers that
 * must not step (camera focus).
 */
export class Wc3Terrain {
  readonly group: THREE.Group;
  /** Kept as `mesh` alias so existing call sites (raycast, fog) keep working. */
  get mesh(): THREE.Object3D {
    return this.group;
  }

  private readonly _map: MapData;
  private readonly _atlas: GroundAtlas;

  /**
   * @param map        Full WC3 map data.
   * @param bounds     If provided, only build chunks that intersect this
   *                   world-space rectangle (plus `margin`). The rest of the
   *                   map is skipped entirely, which dramatically reduces
   *                   triangle count on large maps.
   * @param margin     World-space padding added to each side of `bounds`.
   *                   Defaults to 4500 (roughly the fog start distance).
   */
  constructor(map: MapData, bounds?: TerrainBounds, margin = 4500) {
    this._map = map;
    this._atlas = createGroundAtlas();
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this._buildChunks(bounds, margin);
  }

  // ── Sampling ───────────────────────────────────────────────────

  /**
   * Terrain height at a world XZ position. Matches the rendered mesh:
   * stepped on cliff tiles, bilinear elsewhere.
   */
  heightAt(wx: number, wz: number): number {
    return steppedHeightAt(this._map.terrain, wx, wz);
  }

  /** Old fully-bilinear height — smooth across cliffs (camera focus etc.). */
  smoothHeightAt(wx: number, wz: number): number {
    return sampleTilepointGrid(this._map.terrain, this._map.terrain.finalHeight, wx, wz);
  }

  /** Discrete cliff layer at a world XZ position (nearest tilepoint). */
  layerAt(wx: number, wz: number): number {
    return layerAt(this._map.terrain, wx, wz);
  }

  /** Cliff layer for vision: like layerAt, but ramps stay on the lower layer until near the top. */
  visionLayerAt(wx: number, wz: number): number {
    return visionLayerAt(this._map.terrain, wx, wz);
  }

  /** Gradient magnitude (rise/run) of the smooth field at a world XZ position. */
  slopeAt(wx: number, wz: number): number {
    const e = 8;
    const hx = (this.smoothHeightAt(wx + e, wz) - this.smoothHeightAt(wx - e, wz)) / (2 * e);
    const hz = (this.smoothHeightAt(wx, wz + e) - this.smoothHeightAt(wx, wz - e)) / (2 * e);
    return Math.sqrt(hx * hx + hz * hz);
  }

  /** Surface normal of the smooth field at a world XZ position. */
  normalAt(wx: number, wz: number): THREE.Vector3 {
    const e = 8;
    const hx = (this.smoothHeightAt(wx + e, wz) - this.smoothHeightAt(wx - e, wz)) / (2 * e);
    const hz = (this.smoothHeightAt(wx, wz + e) - this.smoothHeightAt(wx, wz - e)) / (2 * e);
    return new THREE.Vector3(-hx, 1, -hz).normalize();
  }

  // ── Mesh construction ──────────────────────────────────────────

  private _buildChunks(bounds?: TerrainBounds, margin = 0): void {
    const t = this._map.terrain;
    const tilesW = t.width - 1;
    const tilesH = t.height - 1;
    const chunksX = Math.ceil(tilesW / CHUNK_TILES);
    const chunksZ = Math.ceil(tilesH / CHUNK_TILES);
    let skipped = 0;

    const material = new THREE.MeshStandardMaterial({
      map: this._atlas.texture,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });

    for (let cj = 0; cj < chunksZ; cj++) {
      for (let ci = 0; ci < chunksX; ci++) {
        const ti0 = ci * CHUNK_TILES;
        const tj0 = cj * CHUNK_TILES;
        const tw = Math.min(CHUNK_TILES, tilesW - ti0);
        const th = Math.min(CHUNK_TILES, tilesH - tj0);

        // Skip chunks outside the arena + margin
        if (bounds && !this._chunkIntersects(bounds, margin, ti0, tj0, tw, th)) {
          skipped++;
          continue;
        }

        const mesh = this._buildChunk(ti0, tj0, tw, th, material);
        this.group.add(mesh);
      }
    }

    const total = chunksX * chunksZ;
    console.log(
      `[terrain] built ${total - skipped}/${total} chunks (skipped ${skipped})` +
      (bounds ? ` within arena bounds + ${margin}u margin` : ' (full map)'),
    );
  }

  /** True if the tile-aligned rectangle [ti0, ti0+tw) × [tj0, tj0+th) intersects bounds + margin. */
  private _chunkIntersects(bounds: TerrainBounds, margin: number, ti0: number, tj0: number, tw: number, th: number): boolean {
    const t = this._map.terrain;
    const x0 = t.offsetX + ti0 * TILE_SIZE;
    const zMax = -(t.offsetY + tj0 * TILE_SIZE);
    const x1 = x0 + tw * TILE_SIZE;
    const zMin = zMax - th * TILE_SIZE;

    return (
      x1 >= bounds.minX - margin &&
      x0 <= bounds.maxX + margin &&
      zMax >= bounds.minZ - margin &&
      zMin <= bounds.maxZ + margin
    );
  }

  /** Build one chunk starting at tile (ti0, tj0), size tw×th tiles. */
  private _buildChunk(ti0: number, tj0: number, tw: number, th: number, material: THREE.Material): THREE.Mesh {
    const t = this._map.terrain;
    const w = t.width;
    const builder = new ChunkBuilder();

    for (let dj = 0; dj < th; dj++) {
      for (let di = 0; di < tw; di++) {
        const i = ti0 + di;
        const j = tj0 + dj;

        // Corner tilepoints in boundary-walk order: SW, SE, NE, NW
        // (j grows northward; north edge has smaller world z).
        const kSW = j * w + i;
        const kSE = kSW + 1;
        const kNW = kSW + w;
        const kNE = kNW + 1;
        const corners = [kSW, kSE, kNE, kNW];

        const x0 = t.offsetX + i * TILE_SIZE;
        const zS = -(t.offsetY + j * TILE_SIZE);
        const zN = zS - TILE_SIZE;
        const xs = [x0, x0 + TILE_SIZE, x0 + TILE_SIZE, x0];
        const zs = [zS, zS, zN, zN];

        if (!tileIsCliff(t, i, j)) {
          // Uniform tile or walkable ramp: smooth quad at corner heights.
          this._emitGroundTile(builder, corners, xs, zs);
        } else {
          // Layer transition without a ramp: stepped WC3-style cliff.
          this._emitCliffTile(builder, i, j, corners, xs, zs);
        }
      }
    }

    const mesh = new THREE.Mesh(builder.toGeometry(), material);
    mesh.name = `terrain-chunk-${ti0}-${tj0}`;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Smooth ground/ramp quad: 4 unique verts at corner heights. */
  private _emitGroundTile(builder: ChunkBuilder, corners: number[], xs: number[], zs: number[]): void {
    const t = this._map.terrain;
    const H = t.finalHeight;
    const tex = this._dominantTexture(corners);
    const { u0, v0, u1, v1 } = this._atlas.uvRect(tex);

    // Variation-driven 90° UV rotation breaks up repetition. The four
    // rotations permute which UV corner each vertex gets.
    // UV corners at rot 0 in walk order SW, SE, NE, NW.
    const rot = t.variation[corners[0]] & 3;
    const uvCorners = [
      [u0, v0], [u1, v0], [u1, v1], [u0, v1],
    ];

    const idx: number[] = [];
    for (let c = 0; c < 4; c++) {
      const k = corners[c];
      const n = this._tilepointNormal(k);
      const shade = this._tilepointShade(k);
      const [u, v] = uvCorners[(c + rot) & 3];
      idx.push(builder.vertex(xs[c], H[k], zs[c], n.x, n.y, n.z, u, v, shade));
    }
    // (SW, SE, NE) + (SW, NE, NW): front face up
    builder.tri(idx[0], idx[1], idx[2]);
    builder.tri(idx[0], idx[2], idx[3]);
  }

  /**
   * Stepped cliff tile: flat top plateau over the high corners, flat bottom
   * over the low corners, and a vertical wall along the contour through the
   * tile-edge midpoints. Adjacent cliff tiles emit matching midpoint
   * vertices, so plateaus stay watertight; walls extend a short skirt below
   * the low plateau to mask ramp junction slivers.
   */
  private _emitCliffTile(
    builder: ChunkBuilder,
    ti: number,
    tj: number,
    corners: number[],
    xs: number[],
    zs: number[],
  ): void {
    const t = this._map.terrain;
    const H = t.finalHeight;
    const g = cliffTileGeometry(t, ti, tj);

    // Neighbor tile across each edge in walk order S, E, N, W.
    const neighborIsCliff = [
      tileIsCliff(t, ti, tj - 1),
      tileIsCliff(t, ti + 1, tj),
      tileIsCliff(t, ti, tj + 1),
      tileIsCliff(t, ti - 1, tj),
    ];

    const tex = this._dominantTexture(corners);
    const rect = this._atlas.uvRect(tex);
    const groundUV = (x: number, z: number): [number, number] => [
      rect.u0 + ((x - xs[0]) / TILE_SIZE) * (rect.u1 - rect.u0),
      rect.v0 + ((zs[0] - z) / TILE_SIZE) * (rect.v1 - rect.v0),
    ];

    const emitPoly = (poly: { x: number; z: number; h: number; k: number }[]): void => {
      if (poly.length < 3) return;
      const idx = poly.map((p) => {
        const [u, v] = groundUV(p.x, p.z);
        return builder.vertex(p.x, p.h, p.z, 0, 1, 0, u, v, this._tilepointShade(p.k));
      });
      for (let f = 1; f < poly.length - 1; f++) {
        builder.tri(idx[0], idx[f], idx[f + 1]);
      }
    };

    const lowCx = g.polyLow.reduce((s, p) => s + p.x, 0) / g.polyLow.length;
    const lowCz = g.polyLow.reduce((s, p) => s + p.z, 0) / g.polyLow.length;
    const cliffCell = t.cliffTexture[corners[0]] === 1 ? CLIFF_CELL_DIRT : CLIFF_CELL_GRASS;

    // Tiles spanning 3 cliff levels classify some mixed edge's corners as
    // both-high, rendering that edge straight while a stepping neighbor
    // expects a midpoint step. Fill the sliver with a double-sided cap.
    for (let c = 0; c < 4; c++) {
      const nc = (c + 1) & 3;
      const bothSide = ((g.mask >> c) & 1) === ((g.mask >> nc) & 1);
      if (t.layer[corners[c]] !== t.layer[corners[nc]] && bothSide && neighborIsCliff[c]) {
        this._emitEdgeCap(builder, corners, xs, zs, c, nc, cliffCell);
      }
    }

    if (!g.diagonal) {
      // Single contour: walk order gives convex high/low polygons as-is.
      emitPoly(g.polyHigh);
      emitPoly(g.polyLow);
      if (g.crossings.length === 2) {
        this._emitCliffWall(builder, g.crossings[0], g.crossings[1], lowCx, lowCz, cliffCell);
      }
    } else {
      // Two opposite high corners: two plateau triangles + hexagon floor
      // + two walls, one per high corner between its adjacent crossings.
      emitPoly(g.polyLow);
      for (let c = 0; c < 4; c++) {
        if (!((g.mask >> c) & 1)) continue;
        const k = corners[c];
        const shade = this._tilepointShade(k);
        const prev = g.crossings.find((cr) => cr.edge === ((c + 3) & 3))!;
        const next = g.crossings.find((cr) => cr.edge === c)!;
        const [uc, vc] = groundUV(xs[c], zs[c]);
        const [up, vp] = groundUV(prev.x, prev.z);
        const [un, vn] = groundUV(next.x, next.z);
        const a = builder.vertex(xs[c], H[k], zs[c], 0, 1, 0, uc, vc, shade);
        const b = builder.vertex(next.x, next.topH, next.z, 0, 1, 0, un, vn, shade);
        const d = builder.vertex(prev.x, prev.topH, prev.z, 0, 1, 0, up, vp, shade);
        builder.tri(a, b, d);
        this._emitCliffWall(builder, prev, next, lowCx, lowCz, cliffCell);
      }
    }
  }

  /**
   * Double-sided sliver fill along a mixed-layer tile edge that this tile
   * renders straight but the neighboring cliff tile renders stepped: two
   * triangles between the straight corner-to-corner line and the neighbor's
   * midpoint step profile.
   */
  private _emitEdgeCap(
    builder: ChunkBuilder,
    corners: number[],
    xs: number[],
    zs: number[],
    c: number,
    nc: number,
    cliffCell: number,
  ): void {
    const t = this._map.terrain;
    const H = t.finalHeight;
    const hi = t.layer[corners[c]] > t.layer[corners[nc]] ? c : nc;
    const lo = hi === c ? nc : c;
    const hH = H[corners[hi]];
    const lH = H[corners[lo]];
    const midX = (xs[c] + xs[nc]) / 2;
    const midZ = (zs[c] + zs[nc]) / 2;
    const avg = (hH + lH) / 2;

    const rect = this._atlas.uvRect(cliffCell);
    const shade: [number, number, number] = [1, 1, 1];
    const v = (y: number): number => rect.v0 + ((y - lH) / Math.max(hH - lH, 1)) * (rect.v1 - rect.v0);

    const P = builder.vertex(xs[hi], hH, zs[hi], 0, 1, 0, rect.u0, v(hH), shade);
    const Mt = builder.vertex(midX, hH, midZ, 0, 1, 0, rect.u1, v(hH), shade);
    const Ma = builder.vertex(midX, avg, midZ, 0, 1, 0, rect.u1, v(avg), shade);
    const Mb = builder.vertex(midX, lH, midZ, 0, 1, 0, rect.u0, v(lH), shade);
    const Q = builder.vertex(xs[lo], lH, zs[lo], 0, 1, 0, rect.u1, v(lH), shade);

    // Both windings — visibility side depends on surrounding geometry.
    builder.tri(P, Mt, Ma);
    builder.tri(P, Ma, Mt);
    builder.tri(Ma, Mb, Q);
    builder.tri(Ma, Q, Mb);
  }

  /** Vertical wall quad between two contour crossings, facing the low side. */
  private _emitCliffWall(
    builder: ChunkBuilder,
    c0: { x: number; z: number; topH: number; botH: number },
    c1: { x: number; z: number; topH: number; botH: number },
    lowCx: number,
    lowCz: number,
    cliffCell: number,
  ): void {
    // Orient so the wall's front face points toward the low region.
    // For tri (P0top, P1top, P0bot) the normal ∝ (dz, 0, −dx).
    const dx = c1.x - c0.x;
    const dz = c1.z - c0.z;
    const midX = (c0.x + c1.x) / 2;
    const midZ = (c0.z + c1.z) / 2;
    if (dz * (lowCx - midX) - dx * (lowCz - midZ) < 0) {
      [c0, c1] = [c1, c0];
    }

    const skirt = 16; // extend below the low plateau to mask junction slivers
    const rect = this._atlas.uvRect(cliffCell);
    const nx = c1.z - c0.z;
    const nz = -(c1.x - c0.x);
    const nl = Math.hypot(nx, nz) || 1;
    const shade: [number, number, number] = [1, 1, 1];

    const p0t = builder.vertex(c0.x, c0.topH, c0.z, nx / nl, 0, nz / nl, rect.u0, rect.v1, shade);
    const p1t = builder.vertex(c1.x, c1.topH, c1.z, nx / nl, 0, nz / nl, rect.u1, rect.v1, shade);
    const p1b = builder.vertex(c1.x, c1.botH - skirt, c1.z, nx / nl, 0, nz / nl, rect.u1, rect.v0, shade);
    const p0b = builder.vertex(c0.x, c0.botH - skirt, c0.z, nx / nl, 0, nz / nl, rect.u0, rect.v0, shade);
    builder.tri(p0t, p1t, p0b);
    builder.tri(p1t, p1b, p0b);
  }

  /** Most frequent ground-texture index among 4 corner tilepoints. */
  private _dominantTexture(corners: number[]): number {
    const tex = this._map.terrain.texture;
    const counts = new Map<number, number>();
    let best = tex[corners[0]];
    let bestCount = 0;
    for (const k of corners) {
      const v = tex[k];
      const n = (counts.get(v) ?? 0) + 1;
      counts.set(v, n);
      if (n > bestCount || (n === bestCount && v > best)) {
        best = v;
        bestCount = n;
      }
    }
    return best;
  }

  /** Analytic normal from central differences on the tilepoint height grid. */
  private _tilepointNormal(k: number): THREE.Vector3 {
    const t = this._map.terrain;
    const w = t.width;
    const H = t.finalHeight;
    const i = k % w;
    const j = (k - i) / w;

    const hE = H[j * w + Math.min(i + 1, w - 1)];
    const hW = H[j * w + Math.max(i - 1, 0)];
    const hN = H[Math.min(j + 1, t.height - 1) * w + i];
    const hS = H[Math.max(j - 1, 0) * w + i];

    // ∂H/∂wx over 2 tiles; j grows northward = −z, so ∂H/∂wz = −∂H/∂j / TILE
    const dhdx = (hE - hW) / (2 * TILE_SIZE);
    const dhdz = -(hN - hS) / (2 * TILE_SIZE);
    return new THREE.Vector3(-dhdx, 1, -dhdz).normalize();
  }

  /** Per-tilepoint tint: deterministic hue jitter + underwater darkening. */
  private _tilepointShade(k: number): [number, number, number] {
    const t = this._map.terrain;
    // Small deterministic brightness jitter breaks up tiling monotony.
    let h = (k * 2654435761) >>> 0;
    h ^= h >>> 13;
    const jitter = 0.92 + (h % 1000) / 1000 * 0.16;

    let r = jitter;
    let g = jitter;
    let b = jitter;

    // Submerged ground reads darker and slightly blue.
    const depth = t.finalWaterHeight[k] - t.finalHeight[k];
    if ((t.flags[k] & FLAG_WATER) !== 0 && depth > 0) {
      const deep = Math.min(depth / 160, 1);
      const dark = 1 - 0.45 * deep;
      r *= dark * 0.85;
      g *= dark * 0.95;
      b *= dark;
    }
    return [r, g, b];
  }
}

/** Growable vertex/index accumulator for variable-geometry tiles. */
class ChunkBuilder {
  private _positions: number[] = [];
  private _normals: number[] = [];
  private _uvs: number[] = [];
  private _colors: number[] = [];
  private _indices: number[] = [];
  private _count = 0;

  vertex(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    shade: [number, number, number],
  ): number {
    this._positions.push(x, y, z);
    this._normals.push(nx, ny, nz);
    this._uvs.push(u, v);
    this._colors.push(shade[0], shade[1], shade[2]);
    return this._count++;
  }

  tri(a: number, b: number, c: number): void {
    this._indices.push(a, b, c);
  }

  toGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this._positions), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this._normals), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this._uvs), 2));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this._colors), 3));
    geo.setIndex(this._indices);
    geo.computeBoundingSphere();
    return geo;
  }
}
