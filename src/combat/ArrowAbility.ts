import * as THREE from 'three';
import { Hero } from '../entities/Hero';
import { ProjectilePool } from './ProjectilePool';

export type AbilityState = 'idle' | 'charging' | 'cooldown';

/**
 * Charged Arrow ability.
 *
 * Attached to a Hero. Hold Space to charge, release to fire.
 * Charge level determines projectile speed and max range.
 */
export class ArrowAbility {
  readonly hero: Hero;
  readonly pool: ProjectilePool;

  private _state: AbilityState = 'idle';
  private _chargeStart = 0;
  private _chargeLevel = 0;        // 0..1
  private _cooldownRemaining = 0;
  private _elapsed = 0;

  // Tuning
  readonly maxChargeTime = 1.5;    // seconds to full charge
  readonly cooldownTime = 0.5;     // seconds between shots
  readonly minSpeed = 15;          // projectile speed at 0% charge
  readonly maxSpeed = 45;          // projectile speed at 100% charge
  readonly minRange = 8;           // max travel at 0% charge
  readonly maxRange = 40;          // max travel at 100% charge
  readonly baseDamage = 30;

  // Visual indicators on the hero
  private _chargeGlow: THREE.PointLight | null = null;

  constructor(hero: Hero, pool: ProjectilePool) {
    this.hero = hero;
    this.pool = pool;

    // Create charge glow light (hidden by default)
    this._chargeGlow = new THREE.PointLight(0xff6600, 0, 5);
    this._chargeGlow.position.set(0, 0.7, 0);
    this.hero.mesh.add(this._chargeGlow);
  }

  get state(): AbilityState { return this._state; }
  get chargeLevel(): number { return this._chargeLevel; }
  get cooldownRemaining(): number { return this._cooldownRemaining; }
  get cooldownProgress(): number {
    return this.cooldownTime > 0
      ? 1 - this._cooldownRemaining / this.cooldownTime
      : 1;
  }

  /** Begin charging. No-op if on cooldown. */
  startCharge(elapsed: number): void {
    if (this._state !== 'idle') return;
    this._state = 'charging';
    this._chargeStart = elapsed;
    this._chargeLevel = 0;
  }

  /** Release charge — fires the arrow if charging. */
  releaseCharge(aimPos?: THREE.Vector3): void {
    if (this._state !== 'charging') return;

    this._fire(aimPos);
    this._state = 'cooldown';
    this._cooldownRemaining = this.cooldownTime;
    this._updateVisuals();
  }

  /** Cancel charge without firing (e.g., hero starts moving). */
  cancelCharge(): void {
    if (this._state !== 'charging') return;
    this._state = 'idle';
    this._chargeLevel = 0;
    this._updateVisuals();
  }

  /** Called every simulation tick. */
  update(delta: number, elapsed: number): void {
    this._elapsed = elapsed;

    if (this._state === 'charging') {
      const chargeDuration = elapsed - this._chargeStart;
      this._chargeLevel = Math.min(chargeDuration / this.maxChargeTime, 1.0);
      this._updateVisuals();
    }

    if (this._state === 'cooldown') {
      this._cooldownRemaining -= delta;
      if (this._cooldownRemaining <= 0) {
        this._state = 'idle';
        this._cooldownRemaining = 0;
      }
      this._updateVisuals();
    }
  }

  private _fire(aimPos?: THREE.Vector3): void {
    const heroPos = this.hero.position;

    // Direction: toward aim position (mouse cursor), or hero facing as fallback
    let dir: THREE.Vector3;
    if (aimPos) {
      dir = new THREE.Vector3().subVectors(aimPos, heroPos);
      dir.y = 0;
      if (dir.length() < 0.01) {
        // Mouse is right on the hero — fall back to facing
        dir = new THREE.Vector3(Math.sin(this.hero.facing), 0, Math.cos(this.hero.facing));
      }
      dir.normalize();
    } else {
      dir = new THREE.Vector3(Math.sin(this.hero.facing), 0, Math.cos(this.hero.facing)).normalize();
    }

    // Spawn position (slightly in front of hero, at hero height)
    const spawnOffset = this.hero.scale * 0.8;
    const spawnPos = new THREE.Vector3(
      heroPos.x + dir.x * spawnOffset,
      heroPos.y,
      heroPos.z + dir.z * spawnOffset,
    );

    // Interpolate speed and range based on charge level
    const t = this._chargeLevel;
    const speed = this.minSpeed + (this.maxSpeed - this.minSpeed) * t;
    const range = this.minRange + (this.maxRange - this.minRange) * t;

    this.pool.fire({
      position: spawnPos,
      direction: dir,
      speed,
      maxRange: range,
      damage: this.baseDamage,
      owner: this.hero,
    });
  }

  private _updateVisuals(): void {
    if (!this._chargeGlow) return;

    if (this._state === 'charging') {
      // Glow intensity scales with charge
      this._chargeGlow.intensity = this._chargeLevel * 4;
      // Color shifts from orange to yellow/white at full charge
      const r = 1;
      const g = 0.4 + this._chargeLevel * 0.6;
      const b = 0;
      this._chargeGlow.color.setRGB(r, g, b);
    } else if (this._state === 'cooldown') {
      // Dim blue during cooldown
      this._chargeGlow.intensity = 0.5;
      this._chargeGlow.color.setRGB(0.2, 0.4, 1.0);
    } else {
      // Idle — off
      this._chargeGlow.intensity = 0;
    }
  }
}
