import * as THREE from 'three';

export class Renderer {
  private _renderer: THREE.WebGLRenderer;

  constructor() {
    this._renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFShadowMap;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.0;
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
}
