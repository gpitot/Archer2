import * as THREE from 'three';
import { FogOfWar, FOG_EXPLORED, FOG_VISIBLE } from './FogOfWar';
import { quality } from '../core/qualitySettings';

/**
 * Separable Gaussian kernels by radius, applied to the upsampled target field.
 * Radius 2 is the authored look; radius 1 pairs with the Low tier's 2× upsample
 * (a wider kernel over fewer texels would just smear the fog edge into mush).
 */
const BLUR_KERNELS: Record<number, number[]> = {
  1: [1 / 4, 2 / 4, 1 / 4],
  2: [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16],
};

/**
 * Rate the brightness ease runs at. The ease is a full walk of the upsampled
 * texture in JS plus a texture upload, and it runs for as long as vision is
 * changing — which, with a moving hero, is always. Through a bilinearly
 * filtered, Gaussian-blurred texture, 20 Hz is indistinguishable from 60.
 */
const EASE_HZ = 20;

/**
 * Renders one team's fog into the 3D scene.
 *
 * The fog map is uploaded as a brightness texture and injected into world
 * materials via `onBeforeCompile`: each fragment samples the texture at its
 * world XZ and multiplies its final color — hidden ground renders black,
 * explored ground dimmed, visible ground untouched, matching WC3's black
 * mask / grey fog / clear terrain.
 *
 * The texture is UPSAMPLE× finer than the fog grid: whenever the fog
 * recomputes, the coarse states are bilinearly upsampled and Gaussian-blurred
 * (blur the upscaled image, not the source — LoL's documented approach) so
 * fog borders are soft curves instead of cell-quantized steps.
 *
 * World positions outside the fog grid render black, which doubles as the
 * WC3-style dark void beyond the active arena's camera bounds.
 *
 * Brightness eases toward its target every frame so fog edges roll in and out
 * smoothly instead of popping on each recompute.
 */
export class FogLayer {
  /** Brightness of terrain that is explored but not currently visible. */
  static readonly EXPLORED_BRIGHTNESS = 0.4;

  readonly texture: THREE.DataTexture;

  private _fog: FogOfWar;
  private _team: number;
  private _hiX: number;
  private _hiZ: number;
  private _targetCoarse: Float32Array;
  private _targetHi: Float32Array;
  private _blurTmp: Float32Array;
  private _brightness: Float32Array;
  private _data: Uint8Array;
  private _lastVersion = -1;
  private _settled = false;
  private _patched = new WeakSet<THREE.Material>();
  /** Upsample factor of the render texture over the coarse fog grid. */
  private _upsample: number;
  private _blurRadius: number;
  private _blurKernel: number[];
  /** Seconds of ease owed since the last texture walk (see `EASE_HZ`). */
  private _easeAccum = 0;
  private _uniforms: {
    uFogMap: { value: THREE.Texture };
    uFogOrigin: { value: THREE.Vector2 };
    uFogSizeInv: { value: THREE.Vector2 };
  };

  /**
   * @param upsample Render-texture upsample factor over the coarse fog grid.
   *   Defaults to the quality tier's value — halving it quarters the number of
   *   texels every ease walk touches and uploads.
   */
  constructor(fog: FogOfWar, team: number, upsample = quality().fogUpsample) {
    this._fog = fog;
    this._team = team;
    this._upsample = upsample;
    this._blurRadius = quality().fogBlurRadius;
    this._blurKernel = BLUR_KERNELS[this._blurRadius] ?? BLUR_KERNELS[2];

    this._hiX = fog.cellsX * upsample;
    this._hiZ = fog.cellsZ * upsample;
    const n = this._hiX * this._hiZ;
    this._data = new Uint8Array(n); // starts fully hidden (black)
    this._brightness = new Float32Array(n);
    this._targetHi = new Float32Array(n);
    this._blurTmp = new Float32Array(n);
    this._targetCoarse = new Float32Array(fog.cellsX * fog.cellsZ);
    this.texture = new THREE.DataTexture(this._data, this._hiX, this._hiZ, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    this._uniforms = {
      uFogMap: { value: this.texture },
      uFogOrigin: { value: new THREE.Vector2(fog.originX, fog.originZ) },
      uFogSizeInv: { value: new THREE.Vector2(1 / fog.worldWidth, 1 / fog.worldHeight) },
    };
  }

  /**
   * Ease brightness toward the current fog states and upload the texture.
   *
   * Throttled to `EASE_HZ`: the walk below touches every texel of the
   * upsampled texture and re-uploads the whole thing, and it runs continuously
   * while vision is changing. The accumulated delta is fed into the same
   * exponential ease, so the *fade speed* is unchanged — the fade just advances
   * in fewer, larger steps.
   */
  update(delta: number): void {
    if (this._fog.version !== this._lastVersion) {
      this._lastVersion = this._fog.version;
      this._rebuildTarget();
      this._settled = false;
    }
    // Once every texel has reached its target there is nothing to ease and
    // nothing new to upload — skip the full-texture walk until the next
    // fog recompute.
    if (this._settled) {
      this._easeAccum = 0;
      return;
    }

    this._easeAccum += delta;
    if (this._easeAccum < 1 / EASE_HZ) return;
    const eased = this._easeAccum;
    this._easeAccum = 0;

    const target = this._targetHi;
    const k = 1 - Math.exp(-eased * 10);
    const EPS = 0.5 / 255; // below one texture quantization step
    let maxErr = 0;
    for (let i = 0; i < target.length; i++) {
      const b = this._brightness[i] + (target[i] - this._brightness[i]) * k;
      this._brightness[i] = b;
      this._data[i] = (b * 255) | 0;
      const err = Math.abs(target[i] - b);
      if (err > maxErr) maxErr = err;
    }
    if (maxErr < EPS) {
      // Snap exactly onto the target so the final upload matches it.
      this._brightness.set(target);
      for (let i = 0; i < target.length; i++) this._data[i] = (target[i] * 255) | 0;
      this._settled = true;
    }
    this.texture.needsUpdate = true;
  }

  /** Coarse states → brightness targets → bilinear upsample → blur. */
  private _rebuildTarget(): void {
    const states = this._fog.team(this._team);
    const coarse = this._targetCoarse;
    for (let i = 0; i < states.length; i++) {
      coarse[i] =
        states[i] === FOG_VISIBLE ? 1 :
        states[i] === FOG_EXPLORED ? FogLayer.EXPLORED_BRIGHTNESS : 0;
    }

    // Bilinear upsample, treating coarse texel centers as the sample points.
    const nX = this._fog.cellsX;
    const nZ = this._fog.cellsZ;
    const hiX = this._hiX;
    const hiZ = this._hiZ;
    const hi = this._targetHi;
    const inv = 1 / this._upsample;
    for (let hz = 0; hz < hiZ; hz++) {
      let v = (hz + 0.5) * inv - 0.5;
      v = Math.min(Math.max(v, 0), nZ - 1);
      const j = Math.min(Math.floor(v), Math.max(nZ - 2, 0));
      const fv = v - j;
      const row0 = j * nX;
      const row1 = Math.min(j + 1, nZ - 1) * nX;
      for (let hx = 0; hx < hiX; hx++) {
        let u = (hx + 0.5) * inv - 0.5;
        u = Math.min(Math.max(u, 0), nX - 1);
        const i = Math.min(Math.floor(u), Math.max(nX - 2, 0));
        const fu = u - i;
        const i1 = Math.min(i + 1, nX - 1);
        const top = coarse[row0 + i] * (1 - fu) + coarse[row0 + i1] * fu;
        const bot = coarse[row1 + i] * (1 - fu) + coarse[row1 + i1] * fu;
        hi[hz * hiX + hx] = top * (1 - fv) + bot * fv;
      }
    }

    // Separable Gaussian, clamp-extended at the borders (zero-padding would
    // darken the arena edge; the shader's outside-grid cutoff stays the void
    // mask). Horizontal hi→tmp, vertical tmp→hi.
    const tmp = this._blurTmp;
    const radius = this._blurRadius;
    const kernel = this._blurKernel;
    for (let hz = 0; hz < hiZ; hz++) {
      const row = hz * hiX;
      for (let hx = 0; hx < hiX; hx++) {
        let sum = 0;
        for (let o = -radius; o <= radius; o++) {
          const sx = Math.min(Math.max(hx + o, 0), hiX - 1);
          sum += hi[row + sx] * kernel[o + radius];
        }
        tmp[row + hx] = sum;
      }
    }
    for (let hz = 0; hz < hiZ; hz++) {
      for (let hx = 0; hx < hiX; hx++) {
        let sum = 0;
        for (let o = -radius; o <= radius; o++) {
          const sz = Math.min(Math.max(hz + o, 0), hiZ - 1);
          sum += tmp[sz * hiX + hx] * kernel[o + radius];
        }
        hi[hz * hiX + hx] = sum;
      }
    }
  }

  /**
   * Patch every mesh material under `root` to be darkened by the fog map.
   * Use on static world geometry (terrain, doodads, buildings). Units should
   * instead be shown/hidden discretely, WC3-style.
   */
  applyTo(root: THREE.Object3D): void {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) this._patchMaterial(mat);
    });
  }

  private _patchMaterial(mat: THREE.Material): void {
    if (this._patched.has(mat)) return;
    this._patched.add(mat);

    const uniforms = this._uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFogMap = uniforms.uFogMap;
      shader.uniforms.uFogOrigin = uniforms.uFogOrigin;
      shader.uniforms.uFogSizeInv = uniforms.uFogSizeInv;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFowWorldPos;')
        .replace(
          '#include <project_vertex>',
          [
            '#include <project_vertex>',
            // Instanced meshes (doodads) need the per-instance transform to
            // land on their true world position in the fog map.
            'vec4 fowLocal = vec4(transformed, 1.0);',
            '#ifdef USE_INSTANCING',
            '  fowLocal = instanceMatrix * fowLocal;',
            '#endif',
            'vFowWorldPos = (modelMatrix * fowLocal).xyz;',
          ].join('\n'),
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'varying vec3 vFowWorldPos;',
            'uniform sampler2D uFogMap;',
            'uniform vec2 uFogOrigin;',
            'uniform vec2 uFogSizeInv;',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            '#include <dithering_fragment>',
            'vec2 fowUv = (vFowWorldPos.xz - uFogOrigin) * uFogSizeInv;',
            'float fowBrightness = texture2D(uFogMap, fowUv).r;',
            // Outside the fog grid = beyond arena bounds → black void.
            'vec2 fowIn = step(vec2(0.0), fowUv) * step(fowUv, vec2(1.0));',
            'gl_FragColor.rgb *= fowBrightness * fowIn.x * fowIn.y;',
          ].join('\n'),
        );
    };
    // All patched materials share one program variant; unpatched ones keep theirs.
    mat.customProgramCacheKey = () => 'fog-of-war';
    mat.needsUpdate = true;
  }
}
