/**
 * Original procedural low-poly archer (see ArcherMesh.ts), wrapped in the
 * HeroRig interface. Walk cycle and bow-release gesture are animated by
 * rotating the limb groups directly.
 */
import * as THREE from 'three';
import type { HeroRig } from './HeroRig';
import { buildArcherMesh } from './ArcherMesh';

/** Total length of the bow-release gesture, in seconds. */
const SHOOT_DURATION = 0.45;

/** Walk bob height in world units (root is under the 52.5x scaled group). */
const BOB_WORLD = 1.5;
const MESH_SCALE = 52.5;

export class ClassicArcherRig implements HeroRig {
  readonly root: THREE.Group;

  private _bodyMat: THREE.MeshStandardMaterial;
  private _legL: THREE.Object3D;
  private _legR: THREE.Object3D;
  private _armL: THREE.Object3D;
  private _armR: THREE.Object3D;
  private _bow: THREE.Object3D;
  private _bowRestPitch: number;

  private _walkPhase = 0;
  private _walkBlend = 0;
  private _shootTimer = 0;

  constructor(teamColor: number) {
    this.root = buildArcherMesh(teamColor);
    this._bodyMat = (this.root.getObjectByName('heroBody') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    this._legL = this.root.getObjectByName('legL')!;
    this._legR = this.root.getObjectByName('legR')!;
    this._armL = this.root.getObjectByName('armL')!;
    this._armR = this.root.getObjectByName('armR')!;
    this._bow = this.root.getObjectByName('bow')!;
    this._bowRestPitch = this._bow.rotation.x;
  }

  update(dt: number, moving: boolean, speed: number): void {
    this._updateWalk(dt, moving, speed);
    this._updateShoot(dt);
    // The bow hangs from the arm group; counter-pitch it so it stays upright
    // whether the arm is walk-swinging or raised toward the target.
    this._bow.rotation.x = this._bowRestPitch - this._armL.rotation.x;
  }

  playShoot(): void {
    this._shootTimer = SHOOT_DURATION;
  }

  setEmissive(color: number, intensity: number): void {
    this._bodyMat.emissive?.set(intensity > 0 ? color : 0x000000);
    this._bodyMat.emissiveIntensity = intensity;
  }

  setOpacity(opacity: number): void {
    if (opacity >= 1) {
      if (this._bodyMat.transparent) {
        this._bodyMat.transparent = false;
        this._bodyMat.opacity = 1;
      }
    } else {
      this._bodyMat.transparent = true;
      this._bodyMat.opacity = opacity;
    }
  }

  onRespawn(): void {
    this._shootTimer = 0;
    this.setEmissive(0x000000, 0);
    this.setOpacity(1);
  }

  /**
   * Procedural walk cycle: legs swing in opposition from the hips, arms
   * counter-swing with less travel, and the whole mesh bobs slightly.
   * Blends in/out over ~0.15s so starting/stopping doesn't snap the pose.
   */
  private _updateWalk(dt: number, moving: boolean, speed: number): void {
    const target = moving ? 1 : 0;
    const rate = 7 * dt;
    this._walkBlend += Math.max(-rate, Math.min(rate, target - this._walkBlend));

    if (this._walkBlend <= 0.001) {
      this._walkBlend = 0;
      this._walkPhase = 0;
    } else {
      // Cadence scales with actual move speed so boots roughly track the ground.
      this._walkPhase += dt * speed * 0.055;
    }

    const swing = Math.sin(this._walkPhase) * this._walkBlend;
    this._legL.rotation.x = swing * 0.55;
    this._legR.rotation.x = -swing * 0.55;
    this._armL.rotation.x = -swing * 0.22;
    this._armR.rotation.x = swing * 0.22;

    // Body is highest when the legs pass under the hips (swing ≈ 0).
    this.root.position.y = Math.abs(Math.cos(this._walkPhase)) * (BOB_WORLD / MESH_SCALE) * this._walkBlend;
  }

  /**
   * Bow-release gesture, layered over the walk pose (runs after `_updateWalk`,
   * which re-sets the arm rotations every frame): the bow arm snaps up
   * extended toward the target and holds; the draw hand starts at the cheek
   * and recoils backward/outward off the string; then everything eases back
   * down to the walk/idle pose.
   */
  private _updateShoot(dt: number): void {
    if (this._shootTimer <= 0) return;
    this._shootTimer = Math.max(0, this._shootTimer - dt);
    const t = 1 - this._shootTimer / SHOOT_DURATION; // 0 → 1 over the gesture

    // Weight: fast snap up, hold at full pose, smooth ease back down.
    let w: number;
    if (t < 0.12) w = t / 0.12;
    else if (t < 0.55) w = 1;
    else w = 1 - (t - 0.55) / 0.45;
    w = w * w * (3 - 2 * w);

    // Draw hand releases the string over the first ~40% of the gesture.
    const recoil = Math.min(t / 0.4, 1);

    // Bow arm: extended toward the target (negative pitch = forward).
    this._armL.rotation.x += (-1.25 - this._armL.rotation.x) * w;

    // Draw arm: from the cheek (forward) back past the shoulder, opening
    // slightly outward as the hand comes off the string.
    this._armR.rotation.x += (-1.05 + recoil * 0.55 - this._armR.rotation.x) * w;
    this._armR.rotation.z = recoil * 0.35 * w;
  }
}
