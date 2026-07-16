import * as THREE from 'three';

/**
 * A single move-click indicator — four small green chevrons in a cross
 * pattern that animate inward and fade out, WC3-style.
 */
interface Indicator {
  group: THREE.Group;
  age: number;
}

const DURATION = 0.55; // seconds
const INWARD_DIST = 24; // how far each arrow slides inward
const ARROW_COLOR = 0x33ff55;
const ARROW_EMISSIVE = 0x22aa33;

/**
 * Pool of WC3-style ground-click movement indicators.
 * Spawns a burst of 4 small green arrows at a world position that
 * animate inward, shrink, and fade.
 */
export class MoveIndicatorManager {
  private _indicators: Indicator[] = [];
  private _scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  /** Spawn a click indicator at the given world position. */
  spawn(worldPos: THREE.Vector3): void {
    const group = new THREE.Group();
    group.position.copy(worldPos);
    group.position.y += 0.6; // float just above the ground

    const size = 10.5;
    const spread = 30; // distance from center to each arrow base

    // Four cardinal directions pointing inward
    const dirs = [
      { x: 1, z: 0, rot: -Math.PI / 2 },   // east  → pointing west
      { x: -1, z: 0, rot: Math.PI / 2 },    // west  → pointing east
      { x: 0, z: 1, rot: Math.PI },          // north → pointing south
      { x: 0, z: -1, rot: 0 },               // south → pointing north
    ];

    for (const d of dirs) {
      const arrow = this._buildArrow(size, ARROW_COLOR, ARROW_EMISSIVE);
      arrow.position.set(d.x * spread, 0, d.z * spread);
      // Rotate the arrow to point toward center
      // Cone points up (+Y) by default; we lay it flat and rotate azimuth
      arrow.rotation.x = Math.PI / 2; // lay flat on ground
      arrow.rotation.z = d.rot;       // point toward center

      group.add(arrow);
    }

    this._indicators.push({ group, age: 0 });
    this._scene.add(group);
  }

  /** Advance all active indicators and remove finished ones. */
  update(dt: number): void {
    for (let i = this._indicators.length - 1; i >= 0; i--) {
      const ind = this._indicators[i];
      ind.age += dt;
      const t = ind.age / DURATION;

      if (t >= 1) {
        this._scene.remove(ind.group);
        this._disposeGroup(ind.group);
        this._indicators.splice(i, 1);
        continue;
      }

      // Ease: fast inward slide, then slow fade/shrink
      const slide = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const alpha = 1 - t * t;              // fade quadratically

      ind.group.children.forEach((child) => {
        const arrow = child as THREE.Mesh;
        // Slide toward center
        const baseDir = arrow.position.clone().normalize();
        const baseLen = arrow.position.length();
        arrow.position.copy(baseDir.multiplyScalar(baseLen - slide * INWARD_DIST));

        // Scale down
        const s = 1 - t * 0.5;
        arrow.scale.setScalar(s);

        // Fade opacity
        if (Array.isArray(arrow.material)) {
          // handle mesh with multiple materials
          for (const mat of arrow.material) {
            if ('opacity' in mat) mat.opacity = alpha;
          }
        } else if ('opacity' in arrow.material) {
          arrow.material.opacity = alpha;
        }
      });

      // Also fade the parent group by adjusting renderOrder doesn't work well;
      // child opacity handles it.
    }
  }

  clear(): void {
    for (const ind of this._indicators) {
      this._scene.remove(ind.group);
      this._disposeGroup(ind.group);
    }
    this._indicators.length = 0;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private _buildArrow(size: number, color: number, emissive: number): THREE.Mesh {
    // A flat cone used as a chevron/arrowhead pointing up (rotate to final direction)
    const geo = new THREE.ConeGeometry(size * 0.5, size, 4, 1);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: 0.5,
      roughness: 0.3,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    return mesh;
  }

  private _disposeGroup(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
  }
}
