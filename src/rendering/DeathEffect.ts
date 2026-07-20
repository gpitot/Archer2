/**
 * Pool of short-lived death visuals: red particles that burst upward and
 * outward from the hero's feet when killed. Mirrors the level-up tome style
 * but coloured red for the death event.
 * Purely cosmetic — spawned from `kill` sim events.
 */
import * as THREE from 'three';

const DURATION = 0.85;
const PARTICLE_COUNT = 16;
const MAX_RISE = 100;
const RING_RADIUS = 50;

interface ActiveEffect {
  group: THREE.Group;
  particles: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    vy: number;
    vx: number;
    vz: number;
  }[];
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  age: number;
}

export class DeathEffect {
  private _scene: THREE.Scene;
  private _active: ActiveEffect[] = [];

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  /** Spawn a death burst at the given world position. */
  spawn(x: number, y: number, z: number): void {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    const particles: ActiveEffect['particles'] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff2222,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const geo = new THREE.SphereGeometry(3.5, 8, 6);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 999;
      group.add(mesh);
      // Burst outward in a random direction with a strong upward bias.
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 60;
      particles.push({
        mesh,
        mat,
        vy: 50 + Math.random() * 70,
        vx: Math.cos(angle) * speed,
        vz: Math.sin(angle) * speed,
      });
    }

    // Expanding red ring at the base.
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff3333,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, 5, 8, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 998;
    group.add(ring);

    this._scene.add(group);
    this._active.push({ group, particles, ring, ringMat, age: 0 });
  }

  /** Advance and fade all active effects. Call once per frame. */
  update(dt: number): void {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const e = this._active[i];
      e.age += dt;
      const t = Math.min(e.age / DURATION, 1);

      // Particles burst outward with ballistic gravity-like deceleration.
      const gravity = 1 - t; // slow down over time
      for (const p of e.particles) {
        p.mesh.position.set(
          p.mesh.position.x + p.vx * dt * gravity,
          p.mesh.position.y + p.vy * dt * gravity,
          p.mesh.position.z + p.vz * dt * gravity,
        );
        p.mesh.scale.setScalar(1 + t * 1.2);
        // Fade out in the last 40% of the duration.
        p.mat.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      }

      // Ring expands and fades.
      const ringScale = 1 + t * 2.0;
      e.ring.scale.setScalar(ringScale);
      e.ringMat.opacity = 0.85 * (1 - t);

      // Dispose expired effects.
      if (t >= 1) {
        this._dispose(e);
        this._active.splice(i, 1);
      }
    }
  }

  private _dispose(e: ActiveEffect): void {
    e.group.removeFromParent();
    for (const p of e.particles) {
      p.mesh.geometry.dispose();
      p.mat.dispose();
    }
    e.ring.geometry.dispose();
    e.ringMat.dispose();
  }

  dispose(): void {
    for (const e of this._active) this._dispose(e);
    this._active = [];
  }
}
