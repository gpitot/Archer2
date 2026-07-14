import * as THREE from 'three';

/**
 * Top-down orthographic camera.
 *
 * Looks straight down at the XZ plane. Rotation is fixed (Rx -90°):
 *  - Screen right = world +X
 *  - Screen up    = world -Z (south)
 *  - Forward      = world -Y (looking down)
 *
 * The canvas is CSS-flipped (scaleY(-1)) so north (+Z) appears at the top
 * visually. The 3D pipeline is unaffected — backface culling stays correct.
 *
 * Supports edge-panning via pan() and smooth follow via follow().
 */
export class TopDownCamera {
  readonly camera: THREE.OrthographicCamera;

  private _target = new THREE.Vector3();
  private _viewSize = 600; // half-height in world units (~WC3 camera)
  private _elevation = 1200;

  constructor() {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.OrthographicCamera(
      -this._viewSize * aspect,
      this._viewSize * aspect,
      this._viewSize,
      -this._viewSize,
      1,
      3000,
    );

    // Rx(-π/2): look straight down, right = +X, up = -Z (south)
    this.camera.rotation.set(-Math.PI / 2, 0, 0);
    this.camera.position.set(0, this._elevation, 0);
  }

  get target(): THREE.Vector3 {
    return this._target.clone();
  }

  setTarget(pos: THREE.Vector3): void {
    this._target.set(pos.x, pos.y, pos.z);
    this._updatePosition();
  }

  follow(targetPos: THREE.Vector3, lerpFactor = 0.08): void {
    this._target.lerp(targetPos, lerpFactor);
    this._updatePosition();
  }

  pan(delta: THREE.Vector3): void {
    this._target.x += delta.x;
    this._target.z += delta.z;
    this._updatePosition();
  }

  resize(width: number, height: number): void {
    const aspect = width / height;
    this.camera.left = -this._viewSize * aspect;
    this.camera.right = this._viewSize * aspect;
    this.camera.top = this._viewSize;
    this.camera.bottom = -this._viewSize;
    this.camera.updateProjectionMatrix();
  }

  viewHalfWidth(): number {
    return this._viewSize * (window.innerWidth / window.innerHeight);
  }

  private _updatePosition(): void {
    this.camera.position.x = this._target.x;
    this.camera.position.z = this._target.z;
  }
}
