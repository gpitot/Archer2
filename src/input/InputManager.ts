import * as THREE from 'three';

export type ClickHandler = (worldPos: THREE.Vector3) => void;
export type KeyHandler = () => void;

/**
 * Captures mouse clicks (ground targeting), mouse movement (aim tracking),
 * and keyboard events (ability usage).
 */
export class InputManager {
  private _canvas: HTMLCanvasElement;
  private _camera: THREE.Camera;
  private _raycaster = new THREE.Raycaster();
  private _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private _clickHandlers: ClickHandler[] = [];

  // Mouse aim
  private _aimPosition = new THREE.Vector3();
  private _hasAim = false;

  // Keyboard state
  private _keysDown = new Set<string>();
  private _keyDownHandlers = new Map<string, KeyHandler[]>();
  private _keyUpHandlers = new Map<string, KeyHandler[]>();

  // Edge panning
  private _edgeThreshold = 30; // px from window edge to trigger pan
  private _panSpeed = 25;       // world units/sec
  private _mouseScreenX = 0;
  private _mouseScreenY = 0;
  private _panDirection = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, camera: THREE.Camera) {
    this._canvas = canvas;
    this._camera = camera;

    this._canvas.addEventListener('click', this._onClick.bind(this));
    this._canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
    window.addEventListener('keydown', this._onKeyDown.bind(this));
    window.addEventListener('keyup', this._onKeyUp.bind(this));
    // Track mouse on the whole window for edge panning
    window.addEventListener('mousemove', this._onWindowMouseMove.bind(this));
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

  /** Direction to pan the camera (normalized in XZ plane). Zero vector if not near edge. */
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
    const t = this._edgeThreshold;

    let wx = 0; // world east/west (+X = east)
    let wz = 0; // world north/south (+Z = north)

    if (this._mouseScreenX < t) wx = -1;        // left  → west
    else if (this._mouseScreenX > w - t) wx = 1; // right → east

    if (this._mouseScreenY < t) wz = -1;          // top    → north
    else if (this._mouseScreenY > h - t) wz = +1; // bottom → south

    if (wx !== 0 || wz !== 0) {
      this._panDirection.set(wx, 0, wz).normalize();
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
