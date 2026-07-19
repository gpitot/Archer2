/**
 * Pool of short-lived blue portal ring visuals spawned for Blink Dagger.
 * A source portal appears at the hero's cast position (pulsing ring) and
 * a destination portal burst appears when the blink completes.
 */
import * as THREE from 'three';

const DURATION = 0.4;
const RING_RADIUS = 45;

interface ActivePortal {
  group: THREE.Group;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  age: number;
  /** If true, this is a destination burst (fade in then out). */
  burst: boolean;
}

export class PortalEffects {
  private _scene: THREE.Scene;
  private _active: ActivePortal[] = [];
  /** Persistent source rings keyed by hero id (removed when casting stops). */
  private _sourceRings = new Map<string, THREE.Group>();
  private _sourceYOffsets = new Map<string, number>();

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  /**
   * Show or update a portal ring at a hero's feet. Called every frame while
   * `blinkCastTimer > 0`. The ring pulsates (size + opacity oscillate).
   * Called with timer=0 to remove.
   */
  showSourceRing(heroId: string, x: number, y: number, z: number, timer: number): void {
    if (timer <= 0) {
      this._removeSourceRing(heroId);
      return;
    }
    let group = this._sourceRings.get(heroId);
    if (!group) {
      group = new THREE.Group();
      group.renderOrder = 999;

      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x4488ff,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, 4, 8, 48), ringMat);
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);
      group.userData = { ring, ringMat };

      this._scene.add(group);
      this._sourceRings.set(heroId, group);
    }
    group.position.set(x, y, z);
    const ring = group.userData['ring'] as THREE.Mesh;
    const ringMat = group.userData['ringMat'] as THREE.MeshBasicMaterial;
    // Pulsate: scale oscillates with the timer
    const pulse = 1 + 0.15 * Math.sin(timer * 25);
    ring.scale.setScalar(pulse);
    ringMat.opacity = 0.5 + 0.3 * Math.sin(timer * 18);
  }

  private _removeSourceRing(heroId: string): void {
    const group = this._sourceRings.get(heroId);
    if (!group) return;
    this._scene.remove(group);
    group.removeFromParent();
    const ring = group.userData['ring'] as THREE.Mesh;
    const ringMat = group.userData['ringMat'] as THREE.MeshBasicMaterial;
    ring.geometry.dispose();
    ringMat.dispose();
    this._sourceRings.delete(heroId);
  }

  /** Spawn a one-shot destination portal burst at the given position. */
  spawnBurst(x: number, y: number, z: number): void {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(10, 6, 8, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 1000;
    group.add(ring);

    this._scene.add(group);
    this._active.push({ group, ring, ringMat, age: 0, burst: true });
  }

  /** Advance and fade all active burst portals. Call once per frame. */
  update(dt: number): void {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const e = this._active[i];
      e.age += dt;
      const t = Math.min(e.age / DURATION, 1);

      if (e.burst) {
        // Burst: expand ring quickly, fade in then out
        const expand = RING_RADIUS * t;
        e.ring.scale.setScalar(Math.max(expand / 10, 0.001));
        e.ringMat.opacity = t < 0.3 ? t / 0.3 * 0.9 : 0.9 * (1 - (t - 0.3) / 0.7);
      }

      if (t >= 1) {
        this._dispose(e);
        this._active.splice(i, 1);
      }
    }
  }

  private _dispose(e: ActivePortal): void {
    e.group.removeFromParent();
    e.ring.geometry.dispose();
    e.ringMat.dispose();
  }

  /** Remove all source rings (e.g. on map change / disconnect). */
  dispose(): void {
    for (const e of this._active) this._dispose(e);
    this._active = [];
    for (const [id] of this._sourceRings) this._removeSourceRing(id);
  }
}
