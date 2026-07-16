/**
 * Render-only view of a jungle creep. Reads a plain `CreepState` each frame
 * and mirrors it onto the mesh — no gameplay logic. Deliberately cheaper
 * than HeroView: shared geometries/materials (see CreepMeshes), no dynamic
 * light, and only the body material is per-instance (for the hit flash).
 */
import * as THREE from 'three';
import { CreepState } from '../sim/state';
import { CreepTypeId, CREEP_TYPES, creepMaxHp } from '../sim/creepRules';
import { HERO } from '../sim/rules';
import { HealthBar } from './HealthBar';
import { buildCreepMesh } from './CreepMeshes';

export class CreepView {
  readonly mesh: THREE.Group;
  readonly creepId: string;

  private _bodyMat: THREE.MeshStandardMaterial;
  private _healthBar: HealthBar;
  private _hitFlashTimer = 0;

  // Procedural animation (walk swing / wing flap)
  private _limbL: THREE.Object3D | null;
  private _limbR: THREE.Object3D | null;
  private _legL: THREE.Object3D | null;
  private _legR: THREE.Object3D | null;
  private _phase = 0;
  private _moveBlend = 0;
  private _lastX = 0;
  private _lastZ = 0;

  constructor(
    creepId: string,
    private _type: CreepTypeId,
    private _heightAt: (x: number, z: number) => number,
  ) {
    this.creepId = creepId;
    this.mesh = buildCreepMesh(_type);
    this._bodyMat = (this.mesh.getObjectByName('creepBody') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;

    const isGhoul = _type === 'ghoul';
    this._limbL = this.mesh.getObjectByName(isGhoul ? 'armL' : 'wingL') ?? null;
    this._limbR = this.mesh.getObjectByName(isGhoul ? 'armR' : 'wingR') ?? null;
    this._legL = this.mesh.getObjectByName('legL') ?? null;
    this._legR = this.mesh.getObjectByName('legR') ?? null;

    this._healthBar = new HealthBar(creepMaxHp(_type, 1));
    this._healthBar.sprite.position.set(0, isGhoul ? 68 : 72, 0);
    this._healthBar.sprite.scale.set(60, 8, 1);
    this.mesh.add(this._healthBar.sprite);
  }

  /** Pulse the red hit flash (driven by a `creepHit` event). */
  flashHit(): void {
    this._hitFlashTimer = 0.15;
    this._bodyMat.emissive.set(0xff0000);
    this._bodyMat.emissiveIntensity = 0.7;
  }

  /** Mirror the simulation state onto the mesh for this frame. */
  sync(state: CreepState, dt: number): void {
    if (!state.alive) {
      this.mesh.visible = false;
      return;
    }

    this.mesh.visible = true;
    this._healthBar.setHP(state.hp, creepMaxHp(state.type, state.level));

    const y = this._heightAt(state.pos.x, state.pos.z) + HERO.groundOffset;
    this.mesh.position.set(state.pos.x, y, state.pos.z);
    this.mesh.rotation.y = state.facing;

    this._animate(state, dt);

    if (this._hitFlashTimer > 0) {
      this._hitFlashTimer -= dt;
      this._bodyMat.emissiveIntensity = Math.max(0, this._hitFlashTimer / 0.15) * 0.7;
      if (this._hitFlashTimer <= 0) this._bodyMat.emissive.set(0x000000);
    }
  }

  private _animate(state: CreepState, dt: number): void {
    // Moving = the sim position changed since last frame.
    const moved = state.pos.x !== this._lastX || state.pos.z !== this._lastZ;
    this._lastX = state.pos.x;
    this._lastZ = state.pos.z;

    const target = moved ? 1 : 0;
    const rate = 7 * dt;
    this._moveBlend += Math.max(-rate, Math.min(rate, target - this._moveBlend));

    if (this._type === 'ghoul') {
      const speed = CREEP_TYPES.ghoul.speed;
      if (this._moveBlend > 0.001) this._phase += dt * speed * 0.055;
      const swing = Math.sin(this._phase) * this._moveBlend;
      if (this._legL) this._legL.rotation.x = swing * 0.6;
      if (this._legR) this._legR.rotation.x = -swing * 0.6;
      if (this._limbL) this._limbL.rotation.x = 0.5 - swing * 0.25;
      if (this._limbR) this._limbR.rotation.x = 0.5 + swing * 0.25;
    } else {
      // Dragons always flap — slow idle beat, faster when moving.
      this._phase += dt * (3 + 4 * this._moveBlend);
      const flap = Math.sin(this._phase) * 0.45;
      if (this._limbL) this._limbL.rotation.z = flap;
      if (this._limbR) this._limbR.rotation.z = -flap;
      // Gentle hover bob.
      this.mesh.position.y += 4 + Math.sin(this._phase * 0.5) * 2;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}
