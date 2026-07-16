import * as THREE from 'three';
import { HeroState } from '../sim/state';
import { HERO } from '../sim/rules';
import { HealthBar } from './HealthBar';
import { buildArcherMesh } from './ArcherMesh';

const MESH_SCALE = 52.5;

/**
 * Render-only view of a hero. Owns the Three.js mesh, health bar, and the
 * cosmetic flashes; each frame it *reads* a plain `HeroState` produced by the
 * simulation and mirrors it onto the mesh. No gameplay logic lives here.
 */
export class HeroView {
  readonly mesh: THREE.Group;
  readonly heroId: string;

  private _bodyMat: THREE.MeshStandardMaterial;
  private _healthBar: HealthBar;
  private _flashGlow: THREE.PointLight;
  private _hitFlashTimer = 0;
  private _wasAlive = true;

  constructor(
    heroId: string,
    color: number,
    private _heightAt: (x: number, z: number) => number,
  ) {
    this.heroId = heroId;
    this.mesh = buildArcherMesh(color);
    this.mesh.scale.setScalar(MESH_SCALE);
    this._bodyMat = (this.mesh.getObjectByName('heroBody') as THREE.Mesh).material as THREE.MeshStandardMaterial;

    // Hitbox ring at feet
    const ringGeo = new THREE.TorusGeometry(HERO.bodyRadius / MESH_SCALE, 0.08, 8, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthTest: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.renderOrder = 0;
    this.mesh.add(ring);

    this._healthBar = new HealthBar(HERO.maxHp);
    this._healthBar.sprite.position.set(0, 2.5, 0); // above archer's head
    this.mesh.add(this._healthBar.sprite);

    // Muzzle-flash glow, pulsed on fire.
    this._flashGlow = new THREE.PointLight(0xff6600, 0, 5);
    this._flashGlow.position.set(0, 1.5, 0);
    this.mesh.add(this._flashGlow);
  }

  /** Pulse the red hit flash (driven by a sim `hit` event). */
  flashHit(): void {
    this._hitFlashTimer = 0.15;
    this._bodyMat.emissive?.set(0xff0000);
    this._bodyMat.emissiveIntensity = 0.6;
  }

  /** Pulse the muzzle flash (driven by a sim `fire` event). */
  flashFire(): void {
    this._flashGlow.intensity = 3;
    this._flashGlow.color.set(0xff6600);
  }

  /** Mirror the simulation state onto the mesh for this frame. */
  sync(state: HeroState, dt: number): void {
    // Death / respawn transitions reset the mesh appearance.
    if (state.alive && !this._wasAlive) this._onRespawn();
    this._wasAlive = state.alive;

    if (!state.alive) {
      this.mesh.visible = false;
      this._healthBar.hide();
      return;
    }

    this.mesh.visible = true;
    this._healthBar.show();
    this._healthBar.setHP(state.hp, HERO.maxHp);

    const y = this._heightAt(state.pos.x, state.pos.z) + HERO.groundOffset;
    this.mesh.position.set(state.pos.x, y, state.pos.z);
    this.mesh.rotation.y = state.facing;

    // Invulnerability flicker (mirrors the sim's invulnerable timer).
    if (state.invulnerable) {
      const flicker = Math.sin(state.invulnerableTimer * 20) > 0;
      this._bodyMat.transparent = true;
      this._bodyMat.opacity = flicker ? 0.4 : 0.8;
    } else if (this._bodyMat.transparent) {
      this._bodyMat.transparent = false;
      this._bodyMat.opacity = 1;
    }

    // Dodge visual — purple tint while dodging
    if (state.dodgeActive) {
      this._bodyMat.emissive?.set(0x8833cc);
      this._bodyMat.emissiveIntensity = 0.7;
    } else if (!state.invulnerable && this._hitFlashTimer <= 0) {
      this._bodyMat.emissive?.set(0x000000);
      this._bodyMat.emissiveIntensity = 0;
    }

    // Decay the cosmetic flashes.
    if (this._hitFlashTimer > 0) {
      this._hitFlashTimer -= dt;
      const t = Math.max(0, this._hitFlashTimer / 0.15);
      this._bodyMat.emissiveIntensity = t * 0.6;
      if (this._hitFlashTimer <= 0) this._bodyMat.emissive?.set(0x000000);
    }
    if (this._flashGlow.intensity > 0) {
      this._flashGlow.intensity = Math.max(0, this._flashGlow.intensity - dt * 8);
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }

  private _onRespawn(): void {
    this._hitFlashTimer = 0;
    this._bodyMat.emissive?.set(0x000000);
    this._bodyMat.emissiveIntensity = 0;
    this._bodyMat.transparent = false;
    this._bodyMat.opacity = 1;
  }
}
