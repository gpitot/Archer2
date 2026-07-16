/**
 * Modal ground-targeting system for items and abilities that need a point on
 * the ground (wards, blink dagger, AoE spells).
 *
 * Flow:
 *   activate() → show range ring, intercept clicks
 *     ├─ click in range & valid  → onTarget(pos), deactivate
 *     ├─ click out of range      → onMove(target), walk until in range, then onTarget
 *     └─ cancel()                → onCancel(), deactivate
 *
 * Reusable: instantiate once, call activate() with a different config per
 * item/spell. Only one targeting session can be active at a time.
 */
import * as THREE from 'three';
import { sphereHitsObstacle, ObstacleAABB } from '../sim/world';
import { WARD } from '../sim/rules';
import { NavGrid } from '../navigation/NavGrid';

// ── Public interface ─────────────────────────────────────────────────

export interface TargetingConfig {
  /** Radius of the placement circle (world units). */
  range: number;
  /** Emissive colour of the range ring. */
  indicatorColor: number;
  /**
   * Optional client-side target validation with snapping.
   * Receives the raw click position. Returns the final placement position
   * (possibly snapped to the nearest valid spot), or null if no valid spot
   * exists within tolerance.
   */
  validateTarget?: (x: number, z: number) => { x: number; z: number } | null;
  /** Fired when the player confirms a target (click or walk-then-place). */
  onTarget: (x: number, z: number) => void;
  /** Fired when targeting is cancelled without placing. */
  onCancel: () => void;
  /** Fired when the player clicks outside range — issue a move command. */
  onMove: (x: number, z: number) => void;
}

type TargetingState = 'idle' | 'aiming' | 'walking';

// ── Range indicator ring ─────────────────────────────────────────────

const RING_SEGMENTS = 64;
const RING_TUBE = 1.5;

class RangeIndicator {
  readonly mesh: THREE.Mesh;

  constructor(radius: number, color: number) {
    const geo = new THREE.TorusGeometry(radius, RING_TUBE, 8, RING_SEGMENTS);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      roughness: 0.5,
      transparent: true,
      opacity: 0.55,
      depthTest: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2; // lay flat on ground
    this.mesh.renderOrder = 999;
    this.mesh.visible = false;
  }

  setPosition(x: number, y: number, z: number): void {
    this.mesh.position.set(x, y + 0.15, z);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

// ── Targeting state machine ──────────────────────────────────────────

export class TargetingSystem {
  private _state: TargetingState = 'idle';
  private _config: TargetingConfig | null = null;
  private _indicator: RangeIndicator | null = null;
  private _targetX = 0;
  private _targetZ = 0;
  private _heroX = 0;
  private _heroZ = 0;

  /** True while any targeting session is active (aiming or walking). */
  get isActive(): boolean {
    return this._state !== 'idle';
  }

  /** The item id that triggered this session (so we can toggle on re-press). */
  private _sourceItemId: string | null = null;
  get sourceItemId(): string | null {
    return this._sourceItemId;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Enter targeting mode. Shows the range ring around the hero and begins
   * intercepting clicks.
   */
  activate(
    config: TargetingConfig,
    sourceItemId: string | null,
    heroX: number,
    heroZ: number,
    heroY: number,
    scene: THREE.Scene,
  ): void {
    this.deactivate();
    this._config = config;
    this._sourceItemId = sourceItemId;
    this._state = 'aiming';

    this._indicator = new RangeIndicator(config.range, config.indicatorColor);
    this._indicator.setPosition(heroX, heroY, heroZ);
    this._indicator.setVisible(true);
    scene.add(this._indicator.mesh);
  }

  /** Exit targeting mode, clean up visuals, fire onCancel if needed. */
  deactivate(): void {
    if (this._state === 'idle') return;

    const config = this._config;
    this._state = 'idle';

    if (this._indicator) {
      this._indicator.dispose();
      this._indicator = null;
    }

    this._config = null;
    this._sourceItemId = null;

    config?.onCancel();
  }

  /** Cancel without firing onCancel (e.g. because onTarget already fired). */
  private _cleanup(): void {
    this._state = 'idle';
    if (this._indicator) {
      this._indicator.dispose();
      this._indicator = null;
    }
    this._config = null;
    this._sourceItemId = null;
  }

  dispose(): void {
    this.deactivate();
  }

  // ── Frame update ──────────────────────────────────────────────────

  /**
   * Call every frame. Advances the walk-then-place state machine and moves
   * the range ring to follow the hero.
   */
  update(heroX: number, heroZ: number, heroY: number): void {
    if (this._state === 'idle' || !this._config) return;

    this._heroX = heroX;
    this._heroZ = heroZ;

    // Follow the hero with the indicator ring.
    if (this._indicator) {
      this._indicator.setPosition(heroX, heroY, heroZ);
    }

    // In walking state, check if the hero has arrived within range of the target.
    if (this._state === 'walking') {
      const dx = heroX - this._targetX;
      const dz = heroZ - this._targetZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= this._config.range + 0.5) {
        const config = this._config;
        this._cleanup();
        config.onTarget(this._targetX, this._targetZ);
      }
    }
  }

  // ── Click handling ────────────────────────────────────────────────

  /** Call from the InputManager click interceptor. Returns true if consumed. */
  handleClick(worldX: number, worldZ: number): boolean {
    if (this._state === 'idle' || !this._config) return false;

    if (this._state === 'aiming') {
      if (!this._indicator) return false;
      const hx = this._indicator.mesh.position.x;
      const hz = this._indicator.mesh.position.z;
      const dist = Math.sqrt((worldX - hx) ** 2 + (worldZ - hz) ** 2);

      if (dist <= this._config.range) {
        // In range — validate (with snapping) and place.
        let tx = worldX;
        let tz = worldZ;
        if (this._config.validateTarget) {
          const snapped = this._config.validateTarget(worldX, worldZ);
          if (!snapped) return true; // no valid spot nearby, consume click
          tx = snapped.x;
          tz = snapped.z;
        }
        const config = this._config;
        this._cleanup();
        config.onTarget(tx, tz);
        return true;
      } else {
        // Out of range — walk toward target, then place.
        // Hide the ring immediately; the hero is now just walking.
        this._targetX = worldX;
        this._targetZ = worldZ;
        this._state = 'walking';
        if (this._indicator) {
          this._indicator.dispose();
          this._indicator = null;
        }
        this._config.onMove(worldX, worldZ);
        return true;
      }
    }

    // In walking state, a click cancels the walk-then-place and falls
    // through to a normal move to wherever the player clicked.
    if (this._state === 'walking') {
      if (this._config) {
        this._config.onMove(this._heroX, this._heroZ);
      }
      this.deactivate();
      return false;
    }

    return false;
  }

  /** Cancel current targeting, e.g. on Escape / right-click / other action. */
  cancel(): void {
    if (this._state === 'idle') return;

    if (this._state === 'walking' && this._config) {
      this._config.onMove(this._heroX, this._heroZ);
    }

    this.deactivate();
  }
}

// ── Pre-built validators ─────────────────────────────────────────────

/**
 * Returns a validateTarget that snaps to the nearest walkable, obstacle-free
 * cell. Returns null if no valid cell is found within maxRadius cells.
 */
export function walkableValidator(
  navGrid: NavGrid,
  obstacles: ObstacleAABB[],
  maxRadius: number = 64,
): (x: number, z: number) => { x: number; z: number } | null {
  const world = { obstacles };

  const isValid = (wx: number, wz: number): boolean => {
    const { gx, gz } = navGrid.worldToGrid(wx, wz);
    if (!navGrid.isWalkable(gx, gz)) return false;
    return !sphereHitsObstacle(world, { x: wx, z: wz }, WARD.placementRadius);
  };

  return (x: number, z: number) => {
    if (isValid(x, z)) return { x, z };

    // Spiral search for nearest valid cell.
    const start = navGrid.worldToGrid(x, z);
    for (let r = 1; r <= maxRadius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const gx = start.gx + dx;
          const gz = start.gz + dz;
          if (!navGrid.isWalkable(gx, gz)) continue;
          const { wx: cx, wz: cz } = navGrid.gridToWorld(gx, gz);
          if (!sphereHitsObstacle(world, { x: cx, z: cz }, WARD.placementRadius)) {
            console.log(`[ward] snapped (${x.toFixed(0)},${z.toFixed(0)}) → (${cx.toFixed(0)},${cz.toFixed(0)}) radius=${r}`);
            return { x: cx, z: cz };
          }
        }
      }
    }
    console.warn(`[ward] no walkable spot near (${x.toFixed(0)},${z.toFixed(0)}) within ${maxRadius} cells`);
    return null;
  };
}

/**
 * Returns a validateTarget that only rejects positions inside solid
 * obstacles (trees, rocks) — no snapping, no walkability check.
 */
export function obstacleValidator(obstacles: ObstacleAABB[]): (x: number, z: number) => { x: number; z: number } | null {
  return (x: number, z: number) => {
    return sphereHitsObstacle({ obstacles }, { x, z }, WARD.placementRadius) ? null : { x, z };
  };
}
