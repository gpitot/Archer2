/**
 * The taut line drawn for a Grappling Arrow — first from the shooter to the
 * hook in flight, then from the hooked unit to whatever the hook caught while
 * the yank plays out.
 *
 * Immediate mode: `begin()` each frame, `draw()` every rope that should be
 * visible right now (keyed so meshes are reused frame to frame), `end()` to
 * hide the rest. Ropes have no lifetime of their own — the sim state decides
 * every frame whether one exists, so a hook that dies mid-flight takes its
 * rope with it and nothing has to be expired by hand.
 */
import * as THREE from 'three';

/** Rope thickness in world units. */
const RADIUS = 2.2;

interface Rope {
  group: THREE.Group;
  cord: THREE.Mesh;
  used: boolean;
}

export class GrappleRopes {
  private _scene: THREE.Scene;
  private _ropes = new Map<string, Rope>();
  /** Reusable scratch so a frame of rope drawing allocates nothing. */
  private _from = new THREE.Vector3();
  private _to = new THREE.Vector3();
  private _mid = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  /** Start a frame: everything is stale until drawn again. */
  begin(): void {
    for (const rope of this._ropes.values()) rope.used = false;
  }

  /** Draw (or update) the rope identified by `key` between two world points. */
  draw(
    key: string,
    fx: number, fy: number, fz: number,
    tx: number, ty: number, tz: number,
  ): void {
    this._from.set(fx, fy, fz);
    this._to.set(tx, ty, tz);
    this._dir.subVectors(this._to, this._from);
    const length = this._dir.length();
    if (length < 1) return; // degenerate — nothing worth drawing

    const rope = this._ropes.get(key) ?? this._create(key);
    rope.used = true;
    rope.group.visible = true;

    // The cord is a unit-height cylinder along +Y: stretch it to the span and
    // rotate +Y onto the direction between the two points.
    this._mid.addVectors(this._from, this._to).multiplyScalar(0.5);
    rope.group.position.copy(this._mid);
    rope.group.quaternion.setFromUnitVectors(this._up, this._dir.normalize());
    rope.cord.scale.set(1, length, 1);
  }

  /** End a frame: hide every rope that wasn't drawn. */
  end(): void {
    for (const rope of this._ropes.values()) {
      if (!rope.used) rope.group.visible = false;
    }
  }

  dispose(): void {
    for (const rope of this._ropes.values()) {
      this._scene.remove(rope.group);
      rope.cord.geometry.dispose();
      (rope.cord.material as THREE.Material).dispose();
    }
    this._ropes.clear();
  }

  private _create(key: string): Rope {
    const group = new THREE.Group();
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(RADIUS, RADIUS, 1, 6),
      new THREE.MeshStandardMaterial({
        color: 0x5a4a34,
        roughness: 0.85,
        metalness: 0.1,
        emissive: 0x1a1208,
        emissiveIntensity: 0.5,
      }),
    );
    group.add(cord);
    this._scene.add(group);

    const rope: Rope = { group, cord, used: true };
    this._ropes.set(key, rope);
    return rope;
  }
}
