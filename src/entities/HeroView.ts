import * as THREE from 'three';
import { HeroState } from '../sim/state';
import { HERO } from '../sim/rules';
import { HealthBar } from './HealthBar';

const MESH_SCALE = 60;

/** Build a flat disc + facing triangle + shadow for the hero. */
function buildHeroCircle(radius: number, color: number): THREE.Group {
  const group = new THREE.Group();

  const bodyGeo = new THREE.CylinderGeometry(radius, radius, 0.15, 24);
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.name = 'heroBody';
  group.add(body);

  const triShape = new THREE.Shape();
  triShape.moveTo(0, -radius * 1.2);
  triShape.lineTo(-radius * 0.35, -radius * 0.5);
  triShape.lineTo(radius * 0.35, -radius * 0.5);
  triShape.closePath();
  const triGeo = new THREE.ShapeGeometry(triShape);
  const triMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, side: THREE.DoubleSide });
  const tri = new THREE.Mesh(triGeo, triMat);
  tri.rotation.x = -Math.PI / 2;
  tri.position.y = 0.08;
  tri.name = 'heroFacing';
  group.add(tri);

  const shadowGeo = new THREE.CylinderGeometry(radius * 0.9, radius * 0.9, 0.05, 24);
  const shadowMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, transparent: true, opacity: 0.25 });
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.position.y = -0.1;
  shadow.name = 'heroShadow';
  group.add(shadow);

  return group;
}

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
    this.mesh = buildHeroCircle(0.45, color);
    this.mesh.scale.setScalar(MESH_SCALE);
    this._bodyMat = (this.mesh.getObjectByName('heroBody') as THREE.Mesh).material as THREE.MeshStandardMaterial;

    this._healthBar = new HealthBar(HERO.maxHp);
    this.mesh.add(this._healthBar.sprite);

    // Muzzle-flash glow, pulsed on fire.
    this._flashGlow = new THREE.PointLight(0xff6600, 0, 5);
    this._flashGlow.position.set(0, 0.7, 0);
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
