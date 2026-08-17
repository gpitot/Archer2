/**
 * Fake "light pooling on the ground" decal.
 *
 * The scene is forward-rendered with MeshStandardMaterial almost everywhere,
 * so a real PointLight costs a full PBR light evaluation on every fragment it
 * can reach — and the terrain fills the screen. Worse, adding or removing one
 * changes three.js's `NUM_POINT_LIGHTS` define and recompiles *every* standard
 * material in the scene, which is exactly what a volley of arrows does.
 *
 * A single additive quad lying flat on the ground reads the same from the
 * top-down camera at the cost of one cheap draw call and no shader churn. The
 * radial-gradient texture and the plane geometry are shared process-wide; only
 * the material (colour + opacity) is per instance.
 */
import * as THREE from 'three';

let _texture: THREE.Texture | null = null;
let _geometry: THREE.PlaneGeometry | null = null;

/**
 * Shared soft radial-gradient texture (white core → transparent edge). Also
 * used for sprite-based muzzle flashes, which want the same falloff.
 */
export function radialGlowTexture(): THREE.Texture {
  if (_texture) return _texture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  // Bright, fairly tight core with a long tail — matches how a point light's
  // inverse-square falloff used to pool under the arrow.
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  _texture = tex;
  return tex;
}

/** Shared unit quad, pre-rotated to lie flat on the XZ plane. */
function glowGeometry(): THREE.PlaneGeometry {
  if (!_geometry) {
    _geometry = new THREE.PlaneGeometry(1, 1);
    _geometry.rotateX(-Math.PI / 2);
  }
  return _geometry;
}

export class GroundGlow {
  readonly mesh: THREE.Mesh;
  private _mat: THREE.MeshBasicMaterial;
  private _baseOpacity: number;

  /**
   * @param size  Decal width/depth in world units.
   * @param color Tint, additive over the terrain.
   * @param opacity Base opacity; `setPulse` modulates around it.
   */
  constructor(size = 40, color = 0xffbb55, opacity = 0.55) {
    this._baseOpacity = opacity;
    this._mat = new THREE.MeshBasicMaterial({
      map: radialGlowTexture(),
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Drawn before the additive arrow glow so overlapping quads still read
      // as "arrow above its own pool of light".
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(glowGeometry(), this._mat);
    this.mesh.scale.set(size, 1, size);
    this.mesh.renderOrder = 1;
  }

  setColor(color: number): void {
    this._mat.color.set(color);
  }

  /** Scale the decal (world units across). */
  setSize(size: number): void {
    this.mesh.scale.set(size, 1, size);
  }

  /** Multiply the base opacity — for the same shimmer the light used to have. */
  setPulse(factor: number): void {
    this._mat.opacity = this._baseOpacity * factor;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this._mat.dispose();
  }
}
