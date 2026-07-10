/**
 * Procedural height map for the arena terrain.
 *
 * Generates a 2D height array and creates the corresponding Three.js mesh
 * with vertex colors based on elevation.
 */

import * as THREE from 'three';

export class HeightMap {
  readonly width: number;   // cells in X
  readonly depth: number;   // cells in Z
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;

  /** Height data: heights[z][x] in world units (Y). Size = (depth+1) × (width+1). */
  readonly heights: Float32Array;
  private _stride: number; // width + 1

  // Slope threshold: max height difference per cell for walkability
  readonly maxWalkableSlope = 1.5;

  constructor(width: number, depth: number, cellSize = 1, originX = 0, originZ = 0) {
    this.width = width;
    this.depth = depth;
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;

    this._stride = width + 1;
    this.heights = new Float32Array((width + 1) * (depth + 1));
  }

  /** World XZ → height array index. */
  private _index(gx: number, gz: number): number {
    return gz * this._stride + gx;
  }

  /** Get height at grid vertex (gx, gz). */
  getHeight(gx: number, gz: number): number {
    if (gx < 0 || gx > this.width || gz < 0 || gz > this.depth) return 0;
    return this.heights[this._index(gx, gz)];
  }

  /** Get interpolated height at world position. */
  getHeightAt(wx: number, wz: number): number {
    const fx = (wx - this.originX) / this.cellSize;
    const fz = (wz - this.originZ) / this.cellSize;

    const gx0 = Math.floor(fx);
    const gz0 = Math.floor(fz);
    const gx1 = gx0 + 1;
    const gz1 = gz0 + 1;

    const tx = fx - gx0;
    const tz = fz - gz0;

    const h00 = this.getHeight(gx0, gz0);
    const h10 = this.getHeight(gx1, gz0);
    const h01 = this.getHeight(gx0, gz1);
    const h11 = this.getHeight(gx1, gz1);

    // Bilinear interpolation
    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    return h0 + (h1 - h0) * tz;
  }

  /** Get the center height of a grid cell. */
  getCellCenterHeight(gx: number, gz: number): number {
    const wx = this.originX + (gx + 0.5) * this.cellSize;
    const wz = this.originZ + (gz + 0.5) * this.cellSize;
    return this.getHeightAt(wx, wz);
  }

  // ── Generation ─────────────────────────────────────────────────

  /** Generate height data from a function f(worldX, worldZ) → height. */
  generate(generator: (wx: number, wz: number) => number): void {
    for (let gz = 0; gz <= this.depth; gz++) {
      for (let gx = 0; gx <= this.width; gx++) {
        const wx = this.originX + gx * this.cellSize;
        const wz = this.originZ + gz * this.cellSize;
        this.heights[this._index(gx, gz)] = generator(wx, wz);
      }
    }
  }

  // ── Mesh ───────────────────────────────────────────────────────

  /** Create a Three.js mesh from the height data with vertex colors. */
  createMesh(): THREE.Mesh {
    const segmentsX = this.width;
    const segmentsZ = this.depth;
    const sizeX = this.width * this.cellSize;
    const sizeZ = this.depth * this.cellSize;

    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segmentsX, segmentsZ);
    geo.rotateX(-Math.PI / 2);

    // Displace vertices by height
    const positions = geo.attributes.position.array as Float32Array;
    const colors = new Float32Array(positions.length);

    for (let i = 0; i < positions.length / 3; i++) {
      const x = positions[i * 3];
      const z = positions[i * 3 + 2];
      const h = this.getHeightAt(x, z);
      positions[i * 3 + 1] = h;

      // Color based on height
      const color = this._heightToColor(h);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.0,
      flatShading: false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }

  private _heightToColor(h: number): THREE.Color {
    // Normalize: expected range roughly -2 to 8
    const t = THREE.MathUtils.clamp((h + 1) / 10, 0, 1);

    if (h < -0.5) {
      // Water level / deep basin — dark blue-green
      return new THREE.Color(0.15, 0.3, 0.25);
    } else if (h < 0.5) {
      // Low ground — dark grass
      return new THREE.Color(0.25, 0.45, 0.15);
    } else if (h < 2) {
      // Mid elevation — green grass
      return new THREE.Color(0.3 + t * 0.2, 0.5 + t * 0.1, 0.18);
    } else if (h < 4) {
      // High ground — yellow-green transitioning to brown
      const s = (h - 2) / 2;
      return new THREE.Color(0.45 + s * 0.1, 0.55 - s * 0.1, 0.15 - s * 0.05);
    } else if (h < 6) {
      // Rocky — grey-brown
      const s = (h - 4) / 2;
      return new THREE.Color(0.5 + s * 0.1, 0.42 + s * 0.05, 0.3 + s * 0.1);
    } else {
      // Cliff / peak — grey
      return new THREE.Color(0.55, 0.5, 0.45);
    }
  }
}
