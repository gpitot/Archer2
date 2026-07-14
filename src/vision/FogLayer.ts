import * as THREE from 'three';
import { FogOfWar, FOG_EXPLORED, FOG_VISIBLE } from './FogOfWar';

/**
 * Renders one team's fog into the 3D scene.
 *
 * The fog map is uploaded as a small brightness texture (bilinear-filtered so
 * cell edges blend) and injected into world materials via `onBeforeCompile`:
 * each fragment samples the texture at its world XZ and multiplies its final
 * color — hidden ground renders black, explored ground dimmed, visible ground
 * untouched, matching WC3's black mask / grey fog / clear terrain.
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
  private _brightness: Float32Array;
  private _data: Uint8Array;
  private _patched = new WeakSet<THREE.Material>();
  private _uniforms: {
    uFogMap: { value: THREE.Texture };
    uFogOrigin: { value: THREE.Vector2 };
    uFogSizeInv: { value: number };
  };

  constructor(fog: FogOfWar, team: number) {
    this._fog = fog;
    this._team = team;

    const n = fog.cells;
    this._data = new Uint8Array(n * n); // starts fully hidden (black)
    this._brightness = new Float32Array(n * n);
    this.texture = new THREE.DataTexture(this._data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    this._uniforms = {
      uFogMap: { value: this.texture },
      uFogOrigin: { value: new THREE.Vector2(fog.worldOrigin, fog.worldOrigin) },
      uFogSizeInv: { value: 1 / fog.worldSize },
    };
  }

  /** Ease brightness toward the current fog states and upload the texture. */
  update(delta: number): void {
    const states = this._fog.team(this._team);
    const k = 1 - Math.exp(-delta * 10);
    for (let i = 0; i < states.length; i++) {
      const target =
        states[i] === FOG_VISIBLE ? 1 :
        states[i] === FOG_EXPLORED ? FogLayer.EXPLORED_BRIGHTNESS : 0;
      const b = this._brightness[i] + (target - this._brightness[i]) * k;
      this._brightness[i] = b;
      this._data[i] = (b * 255) | 0;
    }
    this.texture.needsUpdate = true;
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
          '#include <project_vertex>\nvFowWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'varying vec3 vFowWorldPos;',
            'uniform sampler2D uFogMap;',
            'uniform vec2 uFogOrigin;',
            'uniform float uFogSizeInv;',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            '#include <dithering_fragment>',
            'vec2 fowUv = (vFowWorldPos.xz - uFogOrigin) * uFogSizeInv;',
            'float fowBrightness = texture2D(uFogMap, fowUv).r;',
            'gl_FragColor.rgb *= fowBrightness;',
          ].join('\n'),
        );
    };
    // All patched materials share one program variant; unpatched ones keep theirs.
    mat.customProgramCacheKey = () => 'fog-of-war';
    mat.needsUpdate = true;
  }
}
