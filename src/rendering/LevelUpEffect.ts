/**
 * Pool of short-lived level-up visuals: golden particles that spiral upward
 * from the hero's feet, mimicking the WC3 tome / hero-level-up animation.
 * Purely cosmetic — spawned from `levelUp` sim events.
 */
import * as THREE from 'three';

const DURATION = 1.0;
const PARTICLE_COUNT = 12;
const MAX_RISE = 120;
const RING_RADIUS = 55;

interface ActiveEffect {
  group: THREE.Group;
  particles: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    angle: number;
    radius: number;
    speed: number;
  }[];
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  age: number;
}

export class LevelUpEffect {
  private _scene: THREE.Scene;
  private _active: ActiveEffect[] = [];

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  /** Spawn a level-up burst at the given world position. */
  spawn(x: number, y: number, z: number): void {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    const particles: ActiveEffect['particles'] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd700,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const geo = new THREE.SphereGeometry(3, 8, 6);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 999;
      group.add(mesh);
      particles.push({
        mesh,
        mat,
        angle: (Math.PI * 2 * i) / PARTICLE_COUNT + Math.random() * 0.3,
        radius: 12 + Math.random() * 16,
        speed: 0.8 + Math.random() * 0.6,
      });
    }

    // Expanding golden ring at the base.
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffcc00,
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

      // Particles spiral up and outward, fading as they go.
      for (const p of e.particles) {
        const rise = t * MAX_RISE;
        const spiralAngle = p.angle + t * Math.PI * 1.5; // ~270° rotation
        const r = p.radius + t * 25; // expand outward
        p.mesh.position.set(
          Math.cos(spiralAngle) * r,
          rise,
          Math.sin(spiralAngle) * r,
        );
        p.mesh.scale.setScalar(1 + t * 1.5);
        p.mat.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      }

      // Ring expands and fades.
      const ringScale = 1 + t * 1.5;
      e.ring.scale.setScalar(ringScale);
      e.ringMat.opacity = 0.9 * (1 - t);

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
