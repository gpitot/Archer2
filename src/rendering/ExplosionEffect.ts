/**
 * Pool of short-lived explosion visuals: an expanding flash sphere plus a
 * ground shockwave ring that grow and fade over ~0.5s. Purely cosmetic —
 * spawned from `blastExplode` sim events.
 */
import * as THREE from 'three';

const DURATION = 0.5;

interface ActiveExplosion {
  group: THREE.Group;
  sphere: THREE.Mesh;
  ring: THREE.Mesh;
  sphereMat: THREE.MeshBasicMaterial;
  ringMat: THREE.MeshBasicMaterial;
  age: number;
  radius: number;
}

export class ExplosionEffects {
  private _scene: THREE.Scene;
  private _active: ActiveExplosion[] = [];

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  /** Spawn an explosion at a world position with the given final radius. */
  spawn(x: number, y: number, z: number, radius: number): void {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0xffaa33,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), sphereMat);
    sphere.renderOrder = 1000;
    group.add(sphere);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff6622,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 2;
    ring.renderOrder = 1000;
    group.add(ring);

    this._scene.add(group);
    this._active.push({ group, sphere, ring, sphereMat, ringMat, age: 0, radius });
  }

  /** Advance and fade all active explosions. Call once per frame. */
  update(dt: number): void {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const e = this._active[i];
      e.age += dt;
      const t = Math.min(e.age / DURATION, 1);
      const ease = 1 - (1 - t) ** 3; // ease-out cubic

      const sphereScale = Math.max(0.6 * e.radius * ease, 0.001);
      e.sphere.scale.setScalar(sphereScale);
      e.sphereMat.opacity = 0.9 * (1 - t);

      const ringScale = Math.max(1.15 * e.radius * ease, 0.001);
      e.ring.scale.setScalar(ringScale);
      e.ringMat.opacity = 0.8 * (1 - t);

      if (t >= 1) {
        this._dispose(e);
        this._active.splice(i, 1);
      }
    }
  }

  private _dispose(e: ActiveExplosion): void {
    e.group.removeFromParent();
    e.sphere.geometry.dispose();
    e.sphereMat.dispose();
    e.ring.geometry.dispose();
    e.ringMat.dispose();
  }

  dispose(): void {
    for (const e of this._active) this._dispose(e);
    this._active = [];
  }
}
