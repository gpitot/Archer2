import * as THREE from 'three';
import { FogOfWar, FOG_EXPLORED, FOG_VISIBLE } from './FogOfWar';

/**
 * Upsampling factor of the render texture over the fog grid. The LoL-style
 * recipe: compute vision coarse, then upsample + blur for rendering only.
 */
const UPSAMPLE = 4;

/** Separable Gaussian kernel applied to the upsampled target field. */
const BLUR_KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
const BLUR_RADIUS = 2;

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
  private _patched = new WeakSet<THREE.Material>();
  private _uniforms: {
    uFogMap: { value: THREE.Texture };
    uFogOrigin: { value: THREE.Vector2 };
    uFogSizeInv: { value: THREE.Vector2 };
  };

  constructor(fog: FogOfWar, team: number) {
    this._fog = fog;
    this._team = team;

    this._hiX = fog.cellsX * UPSAMPLE;
    this._hiZ = fog.cellsZ * UPSAMPLE;
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

  /** Ease brightness toward the current fog states and upload the texture. */
  update(delta: number): void {
    if (this._fog.version !== this._lastVersion) {
      this._lastVersion = this._fog.version;
      this._rebuildTarget();
    }
    const target = this._targetHi;
    const k = 1 - Math.exp(-delta * 10);
    for (let i = 0; i < target.length; i++) {
      const b = this._brightness[i] + (target[i] - this._brightness[i]) * k;
      this._brightness[i] = b;
      this._data[i] = (b * 255) | 0;
    }
    this.texture.needsUpdate = true;
  }

  /** Coarse states → brightness targets → 4× bilinear upsample → blur. */
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
    const inv = 1 / UPSAMPLE;
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
    for (let hz = 0; hz < hiZ; hz++) {
      const row = hz * hiX;
      for (let hx = 0; hx < hiX; hx++) {
        let sum = 0;
        for (let o = -BLUR_RADIUS; o <= BLUR_RADIUS; o++) {
          const sx = Math.min(Math.max(hx + o, 0), hiX - 1);
          sum += hi[row + sx] * BLUR_KERNEL[o + BLUR_RADIUS];
        }
        tmp[row + hx] = sum;
      }
    }
    for (let hz = 0; hz < hiZ; hz++) {
      for (let hx = 0; hx < hiX; hx++) {
        let sum = 0;
        for (let o = -BLUR_RADIUS; o <= BLUR_RADIUS; o++) {
          const sz = Math.min(Math.max(hz + o, 0), hiZ - 1);
          sum += tmp[sz * hiX + hx] * BLUR_KERNEL[o + BLUR_RADIUS];
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
