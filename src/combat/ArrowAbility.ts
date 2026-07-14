import * as THREE from 'three';
import { Hero } from '../entities/Hero';
import { ProjectilePool } from './ProjectilePool';

export type AbilityState = 'idle' | 'cooldown';

/**
 * Shoot Arrow — instant-fire skill-shot.
 *
 * Press Q to fire a straight arrow toward the mouse cursor.
 * Damage, range, and cooldown scale with ability level (1–4).
 * Matches the Assault Archer's Q from Archer Wars Legacy.
 */
export class ArrowAbility {
  readonly hero: Hero;
  readonly pool: ProjectilePool;

  private _state: AbilityState = 'idle';
  private _cooldownRemaining = 0;
  private _elapsed = 0;

  // Ability level (1–4)
  private _level = 0; // 0 = unlearned, 1–4 = learned

  // ── Per-level stats (Shoot Arrow, scaled from WC3) ────
  private static readonly _damageByLevel  = [0, 200, 266, 333, 400];
  private static readonly _rangeByLevel   = [0, 1000, 1666, 2333, 3000];
  private static readonly _cdByLevel      = [0, 2.25, 2.0, 1.75, 1.5];
  private static readonly _speed          = 900;

  // Visuals
  private _flashGlow: THREE.PointLight | null = null;

  constructor(hero: Hero, pool: ProjectilePool) {
    this.hero = hero;
    this.pool = pool;

    // Flash glow on fire
    this._flashGlow = new THREE.PointLight(0xff6600, 0, 5);
    this._flashGlow.position.set(0, 0.7, 0);
    this.hero.mesh.add(this._flashGlow);
  }

  // ── Public getters ─────────────────────────────────────

  get state(): AbilityState { return this._state; }
  get level(): number { return this._level; }

  get damage(): number { return ArrowAbility._damageByLevel[this._level]; }
  get range(): number { return ArrowAbility._rangeByLevel[this._level]; }
  get cooldownTime(): number { return ArrowAbility._cdByLevel[this._level]; }

  get cooldownRemaining(): number { return this._cooldownRemaining; }
  get cooldownProgress(): number {
    if (this._cooldownRemaining <= 0) return 1;
    return 1 - this._cooldownRemaining / this.cooldownTime;
  }

  // ── Leveling ───────────────────────────────────────────

  /** Increase ability level (max 4). Returns true if leveled up. */
  levelUp(): boolean {
    if (this._level >= 4) return false;
    this._level++;
    return true;
  }

  // ── Firing ─────────────────────────────────────────────

  /** Fire an arrow. No-op if on cooldown or not yet learned. */
  fire(aimPos?: THREE.Vector3): void {
    if (this._state !== 'idle' || this._level < 1) return;

    const heroPos = this.hero.position;

    // Direction: toward aim position, or hero facing as fallback
    let dir: THREE.Vector3;
    if (aimPos) {
      dir = new THREE.Vector3().subVectors(aimPos, heroPos);
      dir.y = 0;
      if (dir.length() < 0.01) {
        dir = new THREE.Vector3(Math.sin(this.hero.facing), 0, Math.cos(this.hero.facing));
      }
      dir.normalize();
    } else {
      dir = new THREE.Vector3(Math.sin(this.hero.facing), 0, Math.cos(this.hero.facing)).normalize();
    }

    // Spawn in front of hero
    const spawnOffset = this.hero.scale * 0.8;
    const spawnPos = new THREE.Vector3(
      heroPos.x + dir.x * spawnOffset,
      heroPos.y,
      heroPos.z + dir.z * spawnOffset,
    );

    this.pool.fire({
      position: spawnPos,
      direction: dir,
      speed: ArrowAbility._speed,
      maxRange: this.range,
      damage: this.damage,
      owner: this.hero,
    });

    this._state = 'cooldown';
    this._cooldownRemaining = this.cooldownTime;

    // Flash visual
    if (this._flashGlow) {
      this._flashGlow.intensity = 3;
      this._flashGlow.color.set(0xff6600);
    }
  }

  // ── Update ─────────────────────────────────────────────

  update(delta: number, _elapsed: number): void {
    if (this._state === 'cooldown') {
      this._cooldownRemaining -= delta;
      if (this._cooldownRemaining <= 0) {
        this._state = 'idle';
        this._cooldownRemaining = 0;
      }
    }

    // Decay flash glow
    if (this._flashGlow && this._flashGlow.intensity > 0) {
      this._flashGlow.intensity = Math.max(0, this._flashGlow.intensity - delta * 8);
    }
  }

}
