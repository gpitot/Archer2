import * as THREE from 'three';

export type ClickHandler = (worldPos: THREE.Vector3) => void;
/** Returns true if the click was consumed (don't pass to regular handlers). */
export type ClickInterceptor = (worldPos: THREE.Vector3) => boolean;
export type KeyHandler = () => void;

/** Height-plane refinement steps used by `_screenToWorld`. */
const PICK_ITERATIONS = 3;
/** World units of height agreement that counts as converged. */
const PICK_TOLERANCE = 1;

/**
 * Captures mouse clicks (ground targeting), mouse movement (aim tracking),
 * and keyboard events (ability usage).
 */
export class InputManager {
  private _canvas: HTMLCanvasElement;
  private _camera: THREE.Camera;
  private _raycaster = new THREE.Raycaster();
  private _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** Terrain height sampler; null → pick against the flat y=0 plane. */
  private _heightAt: ((x: number, z: number) => number) | null = null;

  // Scratch vectors, reused so picking allocates nothing per event.
  private _ndc = new THREE.Vector2();
  private _pickHit = new THREE.Vector3();

  private _clickHandlers: ClickHandler[] = [];
  private _clickInterceptor: ClickInterceptor | null = null;
  private _rightClickHandlers: (() => void)[] = [];
  // Mouse aim
  private _aimPosition = new THREE.Vector3();
  private _hasAim = false;
  /**
   * Latest mouse position that has not been converted to a world point yet.
   * `mousemove` fires far more often than the game renders (and a burst can
   * arrive between two frames), so the event only records coordinates and the
   * pick happens lazily on the next `aimPosition` read — at most once per burst.
   */
  private _aimClientX = 0;
  private _aimClientY = 0;
  private _aimDirty = false;

  // Keyboard state
  private _keysDown = new Set<string>();
  private _keyDownHandlers = new Map<string, KeyHandler[]>();
  private _keyUpHandlers = new Map<string, KeyHandler[]>();

  // Edge panning
  private _edgeZone = 100;        // px from edge where panning starts (gradient ramp)
  private _mouseScreenX = 0;
  private _mouseScreenY = 0;
  private _panDirection = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, camera: THREE.Camera) {
    this._canvas = canvas;
    this._camera = camera;

    this._canvas.addEventListener('click', this._onClick.bind(this));
    this._canvas.addEventListener('contextmenu', this._onContextMenu.bind(this));
    this._canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
    window.addEventListener('keydown', this._onKeyDown.bind(this));
    window.addEventListener('keyup', this._onKeyUp.bind(this));
    // Track mouse on the whole window for edge panning
    window.addEventListener('mousemove', this._onWindowMouseMove.bind(this));
  }

  /**
   * Supply the terrain height sampler used to place click/aim points on the
   * ground surface. Without one, picking falls back to the flat y=0 plane.
   */
  setGround(heightAt: (x: number, z: number) => number): void {
    this._heightAt = heightAt;
  }

  // ── Mouse aim ──────────────────────────────────────────────────

  /**
   * Current world-space position of the mouse on the ground, or null.
   *
   * The returned vector is the live internal one — **read-only**. Callers only
   * read `.x`/`.z` out of it; copy it if you need to keep it.
   */
  get aimPosition(): THREE.Vector3 | null {
    if (this._aimDirty) {
      this._aimDirty = false;
      const pt = this._screenToWorld(this._aimClientX, this._aimClientY);
      if (pt) {
        this._aimPosition.copy(pt);
        this._hasAim = true;
      } else {
        this._hasAim = false;
      }
    }
    return this._hasAim ? this._aimPosition : null;
  }

  // ── Mouse click ────────────────────────────────────────────────

  onClick(handler: ClickHandler): void {
    this._clickHandlers.push(handler);
  }

  /** Set a single interceptor that fires before regular handlers. Returns true → consumed. */
  setClickInterceptor(interceptor: ClickInterceptor | null): void {
    this._clickInterceptor = interceptor;
  }

  /** Register a handler for right-click (contextmenu). */
  onRightClick(handler: () => void): void {
    this._rightClickHandlers.push(handler);
  }

  // ── Keyboard ───────────────────────────────────────────────────

  isKeyDown(key: string): boolean {
    return this._keysDown.has(key);
  }

  onKeyDown(key: string, handler: KeyHandler): void {
    const handlers = this._keyDownHandlers.get(key) ?? [];
    handlers.push(handler);
    this._keyDownHandlers.set(key, handlers);
  }

  onKeyUp(key: string, handler: KeyHandler): void {
    const handlers = this._keyUpHandlers.get(key) ?? [];
    handlers.push(handler);
    this._keyUpHandlers.set(key, handlers);
  }

  // ── Edge panning ───────────────────────────────────────────────

  /**
   * Screen-space pan intent while near a screen edge. Zero vector if not.
   *  - `.x` = screen right (+1) / left (-1)
   *  - `.z` = screen forward/up (+1) / down (-1)
   * The camera converts these into world directions via its yaw.
   *
   * The returned vector is the live internal one — **read-only**.
   */
  get edgePan(): THREE.Vector3 {
    return this._panDirection;
  }

  private _onWindowMouseMove(event: MouseEvent): void {
    this._mouseScreenX = event.clientX;
    this._mouseScreenY = event.clientY;
    // Suppress edge panning when the cursor is over a UI element (spell bar,
    // item bar, minimap, shop window, etc.) so the camera doesn't drift while
    // the player hovers the HUD.
    if (event.target && !this._canvas.contains(event.target as Node)) {
      this._panDirection.set(0, 0, 0);
      return;
    }
    this._updatePanDirection();
  }

  private _updatePanDirection(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const zone = this._edgeZone;

    // Gradient ramp: 0 at zone boundary, ±1 at screen edge.
    // This naturally enables smooth diagonal panning when the cursor is in a corner.
    let right = 0;   // screen right (+1) / left (-1)
    let forward = 0; // screen up/forward (+1) / down (-1)

    if (this._mouseScreenX < zone) {
      right = -(zone - this._mouseScreenX) / zone;          // -1 at x=0,  0 at x=zone
    } else if (this._mouseScreenX > w - zone) {
      right = (this._mouseScreenX - (w - zone)) / zone;    //  0 at x=w-zone, +1 at x=w
    }

    if (this._mouseScreenY < zone) {
      forward = (zone - this._mouseScreenY) / zone;         // +1 at y=0,  0 at y=zone
    } else if (this._mouseScreenY > h - zone) {
      forward = -(this._mouseScreenY - (h - zone)) / zone; //  0 at y=h-zone, -1 at y=h
    }

    if (right !== 0 || forward !== 0) {
      // Cap total magnitude so diagonals aren't faster than cardinals.
      const mag = Math.sqrt(right * right + forward * forward);
      if (mag > 1) {
        right /= mag;
        forward /= mag;
      }
      this._panDirection.set(right, 0, forward);
    } else {
      this._panDirection.set(0, 0, 0);
    }
  }

  /**
   * Convert screen coordinates to a point on the ground.
   *
   * This used to raycast the terrain group triangle-by-triangle, which meant
   * walking every chunk's BVH-less geometry on every `mousemove` — by far the
   * most expensive thing the input layer did. Instead: intersect a horizontal
   * plane, sample the terrain height there, lift the plane to that height, and
   * repeat. Two or three iterations converge wherever the ground is not close
   * to vertical.
   *
   * Tradeoff: right at a cliff edge the returned point can be off by under a
   * world unit (well inside a nav cell), because the height field is sampled
   * rather than intersected. Nothing downstream is that precise — clicks are
   * snapped to walkable nav cells and aim only feeds a direction.
   *
   * Returns the shared scratch vector — **read-only**, and invalidated by the
   * next call.
   */
  private _screenToWorld(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this._canvas.getBoundingClientRect();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );

    this._raycaster.setFromCamera(this._ndc, this._camera);
    const ray = this._raycaster.ray;
    const hit = this._pickHit;
    const heightAt = this._heightAt;

    // The plane's normal is +Y, so `constant = -y` puts it at height y.
    let y = 0;
    for (let i = 0; i < PICK_ITERATIONS; i++) {
      this._groundPlane.constant = -y;
      // Pointing at the sky, or along the plane: no ground under the cursor.
      if (!ray.intersectPlane(this._groundPlane, hit)) return null;
      if (!heightAt) return hit;
      const h = heightAt(hit.x, hit.z);
      // Converged: `hit` already lies on the plane at this height.
      if (Math.abs(h - y) < PICK_TOLERANCE) break;
      y = h;
    }
    // Report the true surface height at the point we landed on, so the Y is
    // exact even when the XZ hasn't fully converged on a steep slope.
    if (heightAt) hit.y = heightAt(hit.x, hit.z);
    return hit;
  }

  private _onMouseMove(event: MouseEvent): void {
    // Just record it — the pick happens on the next `aimPosition` read.
    this._aimClientX = event.clientX;
    this._aimClientY = event.clientY;
    this._aimDirty = true;
  }

  private _onClick(event: MouseEvent): void {
    const pt = this._screenToWorld(event.clientX, event.clientY);
    if (pt) {
      // Handlers get their own copy: `_screenToWorld` returns shared scratch,
      // and a handler may hold on to the point (move indicators do).
      if (this._clickInterceptor) {
        const consumed = this._clickInterceptor(pt.clone());
        if (consumed) return;
      }
      for (const handler of this._clickHandlers) {
        handler(pt.clone());
      }
    }
  }

  private _onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    for (const handler of this._rightClickHandlers) {
      handler();
    }
  }

  private _onKeyDown(event: KeyboardEvent): void {
    // Prevent Tab from moving focus away from the game canvas.
    if (event.code === 'Tab') event.preventDefault();
    if (this._keysDown.has(event.code)) return;
    this._keysDown.add(event.code);

    const handlers = this._keyDownHandlers.get(event.code);
    if (handlers) {
      handlers.forEach((h) => h());
    }
  }

  private _onKeyUp(event: KeyboardEvent): void {
    this._keysDown.delete(event.code);

    const handlers = this._keyUpHandlers.get(event.code);
    if (handlers) {
      handlers.forEach((h) => h());
    }
  }

  destroy(): void {
    this._canvas.removeEventListener('click', this._onClick.bind(this));
    this._canvas.removeEventListener('contextmenu', this._onContextMenu.bind(this));
    this._canvas.removeEventListener('mousemove', this._onMouseMove.bind(this));
    window.removeEventListener('keydown', this._onKeyDown.bind(this));
    window.removeEventListener('keyup', this._onKeyUp.bind(this));
  }
}
