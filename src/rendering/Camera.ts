import * as THREE from 'three';

/**
 * Fixed isometric camera using perspective projection.
 *
 * The camera sits at a fixed angle above the scene and smoothly follows
 * a target position. The hero appears slightly below centre of the screen.
 * Players cannot rotate or tilt the camera.
 *
 * Maps to League of Legends-style camera:
 * - Perspective projection
 * - ~35° pitch downward from horizontal
 * - 45° yaw (isometric)
 * - Smooth damped follow
 */
export class IsometricCamera {
  readonly camera: THREE.PerspectiveCamera;

  private _target = new THREE.Vector3();
  private _currentLookAt = new THREE.Vector3();

  // Camera angles (radians)
  private readonly _yaw = Math.PI / 4;     // 45° azimuth
  private readonly _pitch = Math.PI * 35 / 180; // 35° downward from horizontal

  // Distance from target (constant)
  private readonly _distance = 55;

  // Screen offset: hero appears below centre (positive Y offset = lower on screen)
  private readonly _screenOffset = 4; // world units offset along camera's forward direction

  constructor() {
    this.camera = new THREE.PerspectiveCamera(
      45, // FOV
      window.innerWidth / window.innerHeight,
      1,
      500,
    );
    this._updatePosition(true);
  }

  get target(): THREE.Vector3 {
    return this._target.clone();
  }

  /** Set the world position the camera should centre on. */
  setTarget(pos: THREE.Vector3): void {
    this._target.copy(pos);
  }

  /**
   * Smoothly follow a world position. Call every frame.
   * Hero appears slightly below screen centre.
   */
  follow(targetPos: THREE.Vector3, lerpFactor = 0.08): void {
    this._target.lerp(targetPos, lerpFactor);
    this._updatePosition();
  }

  /**
   * Pan the camera target by a world-space delta (for edge panning).
   */
  pan(delta: THREE.Vector3): void {
    this._target.add(delta);
    this._updatePosition();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private _updatePosition(instant = false): void {
    // Camera position in spherical coordinates around the target
    const dist = this._distance;
    const camX = this._target.x + dist * Math.cos(this._pitch) * Math.cos(this._yaw);
    const camY = this._target.y + dist * Math.sin(this._pitch);
    const camZ = this._target.z + dist * Math.cos(this._pitch) * Math.sin(this._yaw);

    this.camera.position.set(camX, camY, camZ);

    // Look-at point: target + small offset so hero is below centre
    // The camera's forward direction (target → camera) points roughly SW.
    // We offset the look-at point slightly opposite to camera forward
    // to push the hero toward the bottom of the screen.
    const forwardX = Math.cos(this._pitch) * Math.cos(this._yaw);
    const forwardZ = Math.cos(this._pitch) * Math.sin(this._yaw);
    const lookTarget = new THREE.Vector3(
      this._target.x - forwardX * this._screenOffset * 0.3,
      this._target.y,
      this._target.z - forwardZ * this._screenOffset * 0.3,
    );

    if (instant) {
      this._currentLookAt.copy(lookTarget);
    } else {
      this._currentLookAt.lerp(lookTarget, 0.08);
    }

    this.camera.lookAt(this._currentLookAt);
  }
}
