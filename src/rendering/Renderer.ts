import * as THREE from 'three';
import { quality } from '../core/qualitySettings';

export class Renderer {
  private _renderer: THREE.WebGLRenderer;
  /** CSS size last handed to `resize`, replayed when the render scale changes. */
  private _width = 1;
  private _height = 1;
  private _pixelRatioCap: number;
  private _renderScale = 1;

  constructor() {
    const q = quality();
    this._pixelRatioCap = q.pixelRatioCap;
    this._renderer = new THREE.WebGLRenderer({
      // MSAA multiplies fragment work; the Low tier turns it off. This is fixed
      // at context creation, so a tier change needs a reload to take effect.
      antialias: q.antialias,
      alpha: false,
      // Hybrid-GPU laptops otherwise default to the integrated GPU.
      powerPreference: 'high-performance',
      // Nothing in the scene uses the stencil buffer.
      stencil: false,
    });
    this._applyPixelRatio();
    this._renderer.shadowMap.enabled = false;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.35;
  }

  get domElement(): HTMLCanvasElement {
    return this._renderer.domElement;
  }

  resize(width: number, height: number): void {
    this._width = width;
    this._height = height;
    this._renderer.setSize(width, height);
  }

  /**
   * Render at a fraction of native resolution (1 = native). Only the WebGL
   * drawing buffer shrinks — the canvas keeps its CSS size, so the DOM HUD and
   * mouse picking are untouched and the browser scales the image up.
   *
   * Driven by `AdaptiveResolution`.
   */
  setRenderScale(scale: number): void {
    if (scale === this._renderScale) return;
    this._renderScale = scale;
    this._applyPixelRatio();
    // setPixelRatio alone doesn't resize the buffer; replay the stored size.
    this._renderer.setSize(this._width, this._height);
  }

  /** Current render scale, 1 = native. */
  get renderScale(): number {
    return this._renderScale;
  }

  private _applyPixelRatio(): void {
    this._renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, this._pixelRatioCap) * this._renderScale,
    );
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this._renderer.render(scene, camera);
  }

  /**
   * Expose WebGL render stats: draw calls, triangles, points, and the number of
   * compiled shader programs.
   *
   * `programs` is the shader-churn detector: it must stay flat during a fight.
   * If it climbs, something is changing a shader-define-affecting property at
   * runtime — most often the scene's light count (see `Lighting.ts`).
   */
  get info(): { drawCalls: number; triangles: number; points: number; programs: number } {
    const r = this._renderer.info.render;
    return {
      drawCalls: r.calls,
      triangles: r.triangles,
      points: r.points,
      programs: this._renderer.info.programs?.length ?? 0,
    };
  }
}
