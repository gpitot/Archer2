import * as THREE from 'three';

export type ClickHandler = (worldPos: THREE.Vector3) => void;
export type KeyHandler = () => void;
export type ScrollHandler = (deltaY: number) => void;

/**
 * Captures mouse clicks (ground targeting), mouse movement (aim tracking),
 * and keyboard events (ability usage).
 */
export class InputManager {
  private _canvas: HTMLCanvasElement;
  private _camera: THREE.Camera;
  private _raycaster = new THREE.Raycaster();
  private _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private _ground: THREE.Object3D | null = null;

  private _clickHandlers: ClickHandler[] = [];
  private _scrollHandlers: ScrollHandler[] = [];

  // Mouse aim
  private _aimPosition = new THREE.Vector3();
  private _hasAim = false;

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
    this._canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
    this._canvas.addEventListener('wheel', this._onWheel.bind(this), { passive: true });
    window.addEventListener('keydown', this._onKeyDown.bind(this));
    window.addEventListener('keyup', this._onKeyUp.bind(this));
    // Track mouse on the whole window for edge panning
    window.addEventListener('mousemove', this._onWindowMouseMove.bind(this));
  }

  /** Set the terrain mesh to raycast for click/aim. Falls back to the y=0 plane. */
  setGround(mesh: THREE.Object3D): void {
    this._ground = mesh;
  }

  /** Register a mouse-wheel handler (positive deltaY = scroll down). */
  onScroll(handler: ScrollHandler): void {
    this._scrollHandlers.push(handler);
  }

  private _onWheel(event: WheelEvent): void {
    for (const h of this._scrollHandlers) h(event.deltaY);
  }

  // ── Mouse aim ──────────────────────────────────────────────────

  /** Current world-space position of the mouse on the ground plane, or null. */
  get aimPosition(): THREE.Vector3 | null {
    return this._hasAim ? this._aimPosition.clone() : null;
  }

  // ── Mouse click ────────────────────────────────────────────────

  onClick(handler: ClickHandler): void {
    this._clickHandlers.push(handler);
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
   */
  get edgePan(): THREE.Vector3 {
    return this._panDirection.clone();
  }

  private _onWindowMouseMove(event: MouseEvent): void {
    this._mouseScreenX = event.clientX;
    this._mouseScreenY = event.clientY;
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

  private _screenToWorld(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this._canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );

    this._raycaster.setFromCamera(mouse, this._camera);

    // Prefer the actual terrain surface under the cursor. Recursive, since
    // the terrain is a Group of chunk meshes.
    if (this._ground) {
      const hits = this._raycaster.intersectObject(this._ground, true);
      if (hits.length > 0) return hits[0].point.clone();
    }

    // Fallback: the flat y=0 plane (e.g. cursor pointing at the sky).
    const intersection = new THREE.Vector3();
    const hit = this._raycaster.ray.intersectPlane(this._groundPlane, intersection);
    return hit ? intersection : null;
  }

  private _onMouseMove(event: MouseEvent): void {
    const pt = this._screenToWorld(event.clientX, event.clientY);
    if (pt) {
      this._aimPosition.copy(pt);
      this._hasAim = true;
    } else {
      this._hasAim = false;
    }
  }

  private _onClick(event: MouseEvent): void {
    const pt = this._screenToWorld(event.clientX, event.clientY);
    if (pt) {
      for (const handler of this._clickHandlers) {
        handler(pt.clone());
      }
    }
  }

  private _onKeyDown(event: KeyboardEvent): void {
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
    this._canvas.removeEventListener('mousemove', this._onMouseMove.bind(this));
    window.removeEventListener('keydown', this._onKeyDown.bind(this));
    window.removeEventListener('keyup', this._onKeyUp.bind(this));
  }
}
