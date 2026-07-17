import * as THREE from 'three';

export class Renderer {
  private _renderer: THREE.WebGLRenderer;

  constructor() {
    this._renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.shadowMap.enabled = false;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.35;
  }

  get domElement(): HTMLCanvasElement {
    return this._renderer.domElement;
  }

  resize(width: number, height: number): void {
    this._renderer.setSize(width, height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this._renderer.render(scene, camera);
  }

  /** Expose WebGL render stats: draw calls, triangles, points. */
  get info(): { drawCalls: number; triangles: number; points: number } {
    const r = this._renderer.info.render;
    return { drawCalls: r.calls, triangles: r.triangles, points: r.points };
  }
}
