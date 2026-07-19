/**
 * Pool of short-lived elemental impact visuals spawned when an ice or fire
 * arrow strikes an enemy. Each burst is a bright flash sphere, a ground ring,
 * and a spray of outward particles (frost shards / embers) that fade over
 * ~0.55s. Purely cosmetic — spawned from `hit` / `creepHit` sim events whose
 * shooter carries the matching bow.
 */
import * as THREE from 'three';

export type ImpactElement = 'ice' | 'fire';

const DURATION = 0.55;
const PARTICLE_COUNT = 20;
const GRAVITY = 220; // world units / s²

interface Palette {
  flash: number;
  ring: number;
  particle: number;
  /** Vertical launch bias: embers rise, frost shards arc outward and fall. */
  rise: number;
}

const PALETTES: Record<ImpactElement, Palette> = {
  ice: { flash: 0xd6f0ff, ring: 0x8fd0ff, particle: 0xe6f6ff, rise: 40 },
  fire: { flash: 0xffd27a, ring: 0xff5a22, particle: 0xff8a3c, rise: 120 },
};

interface ActiveImpact {
  group: THREE.Group;
  flash: THREE.Mesh;
  flashMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  particles: THREE.Points;
  partMat: THREE.PointsMaterial;
  positions: Float32Array;
  velocities: Float32Array;
  age: number;
  element: ImpactElement;
}

export class ImpactEffects {
  private _scene: THREE.Scene;
  private _active: ActiveImpact[] = [];

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  /** Spawn an elemental burst at a world position (centred on the victim). */
  spawn(x: number, y: number, z: number, element: ImpactElement): void {
    const pal = PALETTES[element];
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // ── Flash sphere (bright core, additive) ──
    const flashMat = new THREE.MeshBasicMaterial({
      color: pal.flash,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), flashMat);
    flash.renderOrder = 1000;
    group.add(flash);

    // ── Ground ring (shockwave, additive) ──
    const ringMat = new THREE.MeshBasicMaterial({
      color: pal.ring,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -y + 3; // sit just above the terrain regardless of spawn height
    ring.renderOrder = 1000;
    group.add(ring);

    // ── Particle spray (frost shards / embers) ──
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = new Float32Array(PARTICLE_COUNT * 3);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      // Launch outward in a random direction, biased upward.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5; // upper hemisphere
      const speed = 60 + Math.random() * 110;
      velocities[i3] = Math.cos(theta) * Math.sin(phi) * speed;
      velocities[i3 + 1] = Math.cos(phi) * speed + pal.rise;
      velocities[i3 + 2] = Math.sin(theta) * Math.sin(phi) * speed;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const partMat = new THREE.PointsMaterial({
      color: pal.particle,
      size: element === 'fire' ? 3.2 : 2.6,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const particles = new THREE.Points(geo, partMat);
    particles.renderOrder = 1000;
    group.add(particles);

    this._scene.add(group);
    this._active.push({
      group, flash, flashMat, ring, ringMat, particles, partMat,
      positions, velocities, age: 0, element,
    });
  }

  /** Advance, expand, and fade all active impacts. Call once per frame. */
  update(dt: number): void {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const e = this._active[i];
      e.age += dt;
      const t = Math.min(e.age / DURATION, 1);
      const ease = 1 - (1 - t) ** 3; // ease-out cubic

      // Flash: pops out fast, fades faster.
      e.flash.scale.setScalar(Math.max(26 * ease, 0.001));
      e.flashMat.opacity = 0.95 * (1 - t) ** 2;

      // Ring: expands wide across the ground.
      e.ring.scale.setScalar(Math.max(48 * ease, 0.001));
      e.ringMat.opacity = 0.85 * (1 - t);

      // Particles: ballistic spray with gravity, fading out.
      const p = e.positions;
      const v = e.velocities;
      for (let j = 0; j < PARTICLE_COUNT; j++) {
        const j3 = j * 3;
        v[j3 + 1] -= GRAVITY * dt;
        p[j3] += v[j3] * dt;
        p[j3 + 1] += v[j3 + 1] * dt;
        p[j3 + 2] += v[j3 + 2] * dt;
      }
      (e.particles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      e.partMat.opacity = 0.95 * (1 - t);

      if (t >= 1) {
        this._dispose(e);
        this._active.splice(i, 1);
      }
    }
  }

  private _dispose(e: ActiveImpact): void {
    e.group.removeFromParent();
    e.flash.geometry.dispose();
    e.flashMat.dispose();
    e.ring.geometry.dispose();
    e.ringMat.dispose();
    e.particles.geometry.dispose();
    e.partMat.dispose();
  }

  dispose(): void {
    for (const e of this._active) this._dispose(e);
    this._active = [];
  }
}
