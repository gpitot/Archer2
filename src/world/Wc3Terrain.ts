import * as THREE from 'three';
import { MapData, TILE_SIZE, sampleTilepointGrid } from './wc3/MapData';
import { FLAG_WATER } from './wc3/W3EParser';
import { createGroundAtlas, GroundAtlas } from './wc3/GroundTextures';

const CHUNK_TILES = 32;

/**
 * Renders the original map's terrain: one textured, vertex-colored mesh per
 * 32×32-tile chunk (frustum-culled individually). Every tile gets 4 unique
 * vertices at its corner elevations, textured by the tile's dominant ground
 * type from the procedural atlas.
 *
 * `heightAt` is the single source of truth for ground elevation — it drives
 * hero/projectile Y, camera framing, and prop placement.
 *
 * Cliff transitions currently render as steep smooth quads; the stepped
 * cliff/ramp mesher replaces them in the next phase.
 */
export class Wc3Terrain {
  readonly group: THREE.Group;
  /** Kept as `mesh` alias so existing call sites (raycast, fog) keep working. */
  get mesh(): THREE.Object3D {
    return this.group;
  }

  private readonly _map: MapData;
  private readonly _atlas: GroundAtlas;

  constructor(map: MapData) {
    this._map = map;
    this._atlas = createGroundAtlas();
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this._buildChunks();
  }

  // ── Sampling ───────────────────────────────────────────────────

  /** Terrain height at a world XZ position (bilinear over tilepoints). */
  heightAt(wx: number, wz: number): number {
    return sampleTilepointGrid(this._map.terrain, this._map.terrain.finalHeight, wx, wz);
  }

  /** Gradient magnitude (rise/run) at a world XZ position. */
  slopeAt(wx: number, wz: number): number {
    const e = 8;
    const hx = (this.heightAt(wx + e, wz) - this.heightAt(wx - e, wz)) / (2 * e);
    const hz = (this.heightAt(wx, wz + e) - this.heightAt(wx, wz - e)) / (2 * e);
    return Math.sqrt(hx * hx + hz * hz);
  }

  /** Surface normal at a world XZ position. */
  normalAt(wx: number, wz: number): THREE.Vector3 {
    const e = 8;
    const hx = (this.heightAt(wx + e, wz) - this.heightAt(wx - e, wz)) / (2 * e);
    const hz = (this.heightAt(wx, wz + e) - this.heightAt(wx, wz - e)) / (2 * e);
    return new THREE.Vector3(-hx, 1, -hz).normalize();
  }

  // ── Mesh construction ──────────────────────────────────────────

  private _buildChunks(): void {
    const t = this._map.terrain;
    const tilesW = t.width - 1;
    const tilesH = t.height - 1;
    const chunksX = Math.ceil(tilesW / CHUNK_TILES);
    const chunksZ = Math.ceil(tilesH / CHUNK_TILES);

    const material = new THREE.MeshStandardMaterial({
      map: this._atlas.texture,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });

    for (let cj = 0; cj < chunksZ; cj++) {
      for (let ci = 0; ci < chunksX; ci++) {
        const mesh = this._buildChunk(
          ci * CHUNK_TILES,
          cj * CHUNK_TILES,
          Math.min(CHUNK_TILES, tilesW - ci * CHUNK_TILES),
          Math.min(CHUNK_TILES, tilesH - cj * CHUNK_TILES),
          material,
        );
        this.group.add(mesh);
      }
    }
  }

  /** Build one chunk starting at tile (ti0, tj0), size tw×th tiles. */
  private _buildChunk(ti0: number, tj0: number, tw: number, th: number, material: THREE.Material): THREE.Mesh {
    const t = this._map.terrain;
    const w = t.width;
    const H = t.finalHeight;

    const tileCount = tw * th;
    const positions = new Float32Array(tileCount * 4 * 3);
    const normals = new Float32Array(tileCount * 4 * 3);
    const uvs = new Float32Array(tileCount * 4 * 2);
    const colors = new Float32Array(tileCount * 4 * 3);
    const indices = new Uint32Array(tileCount * 6);

    let vtx = 0;
    let idx = 0;

    for (let dj = 0; dj < th; dj++) {
      for (let di = 0; di < tw; di++) {
        const i = ti0 + di;
        const j = tj0 + dj;

        // Corner tilepoint indices: SW, SE, NW, NE (j grows northward)
        const kSW = j * w + i;
        const kSE = kSW + 1;
        const kNW = kSW + w;
        const kNE = kNW + 1;
        const corners = [kSW, kSE, kNW, kNE];

        // World rect of the tile (north edge has smaller z)
        const x0 = t.offsetX + i * TILE_SIZE;
        const zS = -(t.offsetY + j * TILE_SIZE);
        const zN = zS - TILE_SIZE;

        // Dominant corner texture; ties resolve to the higher index
        // (matches WC3 tile layer priority).
        const tex = this._dominantTexture(corners);
        const { u0, v0, u1, v1 } = this._atlas.uvRect(tex);

        // Corner order: SW, SE, NW, NE
        const xs = [x0, x0 + TILE_SIZE, x0, x0 + TILE_SIZE];
        const zs = [zS, zS, zN, zN];
        // Variation-driven 90° UV rotation breaks up repetition. The four
        // rotations permute which UV corner each vertex gets.
        const rot = t.variation[kSW] & 3;
        const uvCorners = [
          [u0, v0], [u1, v0], [u0, v1], [u1, v1], // SW SE NW NE at rot 0
        ];
        const rotOrder = [
          [0, 1, 2, 3],
          [2, 0, 3, 1],
          [3, 2, 1, 0],
          [1, 3, 0, 2],
        ][rot];

        for (let c = 0; c < 4; c++) {
          const k = corners[c];
          positions[vtx * 3] = xs[c];
          positions[vtx * 3 + 1] = H[k];
          positions[vtx * 3 + 2] = zs[c];

          const n = this._tilepointNormal(k);
          normals[vtx * 3] = n.x;
          normals[vtx * 3 + 1] = n.y;
          normals[vtx * 3 + 2] = n.z;

          const [u, v] = uvCorners[rotOrder[c]];
          uvs[vtx * 2] = u;
          uvs[vtx * 2 + 1] = v;

          const shade = this._tilepointShade(k);
          colors[vtx * 3] = shade[0];
          colors[vtx * 3 + 1] = shade[1];
          colors[vtx * 3 + 2] = shade[2];
          vtx++;
        }

        const base = vtx - 4;
        // (SW, SE, NE) + (SW, NE, NW), front face up
        indices[idx++] = base;
        indices[idx++] = base + 1;
        indices[idx++] = base + 3;
        indices[idx++] = base;
        indices[idx++] = base + 3;
        indices[idx++] = base + 2;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `terrain-chunk-${ti0}-${tj0}`;
    mesh.receiveShadow = true;
    return mesh;
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
