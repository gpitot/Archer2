import * as THREE from 'three';

/**
 * Perspective isometric camera (Warcraft 3 / League of Legends style).
 *
 * Like League, the camera has NO yaw: it sits due south of the focus looking
 * north, pitched ~56° above the horizon (LoL/WC3 both use ≈56°). Screen axes
 * therefore map 1:1 to world axes — screen up = -Z, screen right = +X — which
 * keeps edge-pan and the minimap aligned. (The diagonal look of Summoner's
 * Rift comes from the map art, not camera rotation.) It never rotates freely
 * (design constraint), rises with terrain height, and supports wheel zoom.
 *
 *  - Screen "up"    = groundForward()  (into the screen, along the ground)
 *  - Screen "right" = groundRight()
 *
 * Everything gameplay is 2D on the XZ plane; this class only affects framing.
 */
export class IsometricCamera {
  readonly camera: THREE.PerspectiveCamera;

  private _focus = new THREE.Vector3();
  private _distance = 1600;
  private readonly _minDist = 700;
  private readonly _maxDist = 2800;

  // Fixed orientation: no yaw (League-style), pitch 56° above horizon.
  private readonly _yaw = 0;
  private readonly _pitch = THREE.MathUtils.degToRad(56);
  private _offset = new THREE.Vector3();

  constructor() {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(32, aspect, 1, 8000);
    this._recomputeOffset();
    this._apply();
  }

  // ── Focus control ──────────────────────────────────────────────

  get target(): THREE.Vector3 {
    return this._focus.clone();
  }

  /** Read-only live reference to the focus point (for terrain sampling). */
  get focus(): THREE.Vector3 {
    return this._focus;
  }

  setTarget(pos: THREE.Vector3): void {
    this._focus.copy(pos);
    this._apply();
  }

  /** Smoothly follow a target on the ground plane (XZ only). */
  follow(pos: THREE.Vector3, lerp = 0.08): void {
    this._focus.x += (pos.x - this._focus.x) * lerp;
    this._focus.z += (pos.z - this._focus.z) * lerp;
    this._apply();
  }

  /** Set the focus height (terrain under the focus) so the camera rides hills. */
  setFocusY(y: number): void {
    this._focus.y = y;
    this._apply();
  }

  // ── Screen-space panning ───────────────────────────────────────

  /** Ground-projected "into screen" unit vector (screen up). */
  groundForward(): THREE.Vector3 {
    return new THREE.Vector3(-this._offset.x, 0, -this._offset.z).normalize();
  }

  /** Ground-projected "screen right" unit vector (view dir × world up). */
  groundRight(): THREE.Vector3 {
    const f = this.groundForward();
    return new THREE.Vector3(-f.z, 0, f.x);
  }

  /** Pan the focus in screen space (right>0 → right, forward>0 → away/up). */
  panScreen(right: number, forward: number): void {
    const r = this.groundRight().multiplyScalar(right);
    const f = this.groundForward().multiplyScalar(forward);
    this._focus.x += r.x + f.x;
    this._focus.z += r.z + f.z;
    this._apply();
  }

  // ── Zoom ───────────────────────────────────────────────────────

  /** Dolly in/out. Positive `amount` zooms out. */
  zoom(amount: number): void {
    this._distance = THREE.MathUtils.clamp(
      this._distance + amount,
      this._minDist,
      this._maxDist,
    );
    this._recomputeOffset();
    this._apply();
  }

  // ── Framing helpers ────────────────────────────────────────────

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Approximate half-width of the visible ground, for the minimap view-rect. */
  viewHalfWidth(): number {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const halfHeightAtFocus = Math.tan(vFov / 2) * this._distance;
    return halfHeightAtFocus * this.camera.aspect;
  }

  // ── Internal ───────────────────────────────────────────────────

  private _recomputeOffset(): void {
    const horiz = Math.cos(this._pitch) * this._distance;
    const vert = Math.sin(this._pitch) * this._distance;
    this._offset.set(
      Math.sin(this._yaw) * horiz,
      vert,
      Math.cos(this._yaw) * horiz,
    );
  }

  private _apply(): void {
    this.camera.position.copy(this._focus).add(this._offset);
    this.camera.lookAt(this._focus);
  }
}
