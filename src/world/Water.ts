import * as THREE from 'three';
import { MapData, TILE_SIZE } from './wc3/MapData';
import { FLAG_WATER } from './wc3/W3EParser';

const CHUNK_TILES = 32;

/**
 * Translucent animated water surface built from the original map's
 * per-tilepoint water levels.
 *
 * A tile gets a water quad when any corner carries the water flag AND the
 * water table sits above the ground there — the flag alone is set on many
 * raised tiles where the water would be underground. Vertex color darkens
 * with depth so shallows read bright teal and channels read deep.
 * The ripple highlight texture is self-created on a canvas and scrolled
 * slowly each frame.
 */
export class Water {
  readonly group: THREE.Group;

  private readonly _texture: THREE.CanvasTexture;

  constructor(map: MapData) {
    this.group = new THREE.Group();
    this.group.name = 'water';
    this._texture = createRippleTexture();

    const material = new THREE.MeshStandardMaterial({
      map: this._texture,
      color: 0x3f89a0,
      transparent: true,
      opacity: 0.6,
      roughness: 0.35,
      metalness: 0.1,
      depthWrite: false,
      vertexColors: true,
    });

    this._build(map, material);
  }

  /** Scroll the ripple texture; call once per frame. */
  update(delta: number): void {
    this._texture.offset.x = (this._texture.offset.x + delta * 0.008) % 1;
    this._texture.offset.y = (this._texture.offset.y + delta * 0.005) % 1;
  }

  private _build(map: MapData, material: THREE.Material): void {
    const t = map.terrain;
    const tilesW = t.width - 1;
    const tilesH = t.height - 1;
    const chunksX = Math.ceil(tilesW / CHUNK_TILES);
    const chunksZ = Math.ceil(tilesH / CHUNK_TILES);
    const w = t.width;
    const G = t.finalHeight;
    const W = t.finalWaterHeight;

    for (let cj = 0; cj < chunksZ; cj++) {
      for (let ci = 0; ci < chunksX; ci++) {
        const positions: number[] = [];
        const uvs: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        let count = 0;

        const tj1 = Math.min((cj + 1) * CHUNK_TILES, tilesH);
        const ti1 = Math.min((ci + 1) * CHUNK_TILES, tilesW);
        for (let j = cj * CHUNK_TILES; j < tj1; j++) {
          for (let i = ci * CHUNK_TILES; i < ti1; i++) {
            const kSW = j * w + i;
            const ks = [kSW, kSW + 1, kSW + w + 1, kSW + w]; // SW SE NE NW

            let wet = false;
            for (const k of ks) {
              if ((t.flags[k] & FLAG_WATER) !== 0 && W[k] > G[k]) {
                wet = true;
                break;
              }
            }
            if (!wet) continue;

            const x0 = t.offsetX + i * TILE_SIZE;
            const zS = -(t.offsetY + j * TILE_SIZE);
            const xs = [x0, x0 + TILE_SIZE, x0 + TILE_SIZE, x0];
            const zs = [zS, zS, zS - TILE_SIZE, zS - TILE_SIZE];

            for (let c = 0; c < 4; c++) {
              const k = ks[c];
              positions.push(xs[c], W[k], zs[c]);
              // World-anchored UVs so ripples tile seamlessly across quads.
              uvs.push(xs[c] / 512, zs[c] / 512);
              const depth = Math.max(W[k] - G[k], 0);
              const deep = Math.min(depth / 96, 1);
              const shade = 1 - 0.55 * deep;
              colors.push(shade * 0.9, shade, shade * 1.05);
            }
            indices.push(count, count + 1, count + 2, count, count + 2, count + 3);
            count += 4;
          }
        }

        if (count === 0) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
        // The surface is effectively flat — uniform up normals avoid
        // per-quad shading seams.
        const normals = new Float32Array(count * 3);
        for (let n = 0; n < count; n++) normals[n * 3 + 1] = 1;
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geo.setIndex(indices);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, material);
        mesh.name = `water-chunk-${ci}-${cj}`;
        this.group.add(mesh);
      }
    }
  }
}

/** Soft ripple-highlight pattern, drawn from scratch (tileable). */
function createRippleTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = 'rgb(210,225,232)';
  ctx.fillRect(0, 0, size, size);

  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  // Wrapped wavy highlight strokes
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      ctx.save();
      ctx.translate(ox * size, oy * size);
      seed = 7;
      for (let i = 0; i < 42; i++) {
        const y = rnd() * size;
        const x = rnd() * size;
        const len = 20 + rnd() * 46;
        const bright = rnd() < 0.6;
        ctx.strokeStyle = bright ? 'rgba(255,255,255,0.35)' : 'rgba(150,175,190,0.4)';
        ctx.lineWidth = 1 + rnd() * 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + len * 0.5, y + (rnd() - 0.5) * 8, x + len, y + (rnd() - 0.5) * 4);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
