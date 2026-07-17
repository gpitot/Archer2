/**
 * GLB-based hero rig using the Quaternius "RPG Characters" ranger model
 * (see RangerModel.ts). Skeletal animation via THREE.AnimationMixer:
 * Idle_Weapon / Run_Holding locomotion with crossfades, and Bow_Shoot as a
 * one-shot layered action for firing.
 *
 * The GLB loads asynchronously; the rig exposes an empty root immediately
 * and attaches the model (plus any buffered tint/flash state) once parsed.
 */
import * as THREE from 'three';
import type { HeroRig } from './HeroRig';
import { createRangerInstance } from './RangerModel';
import { HERO } from '../sim/rules';

// ── Tuning knobs ─────────────────────────────────────────────────
/** Extra scale so the ranger (~3 units tall) matches the classic archer (~2). */
const MODEL_SCALE = 0.65;
/** Yaw offset if the GLB forward axis doesn't match sim facing (+Z). */
const YAW_OFFSET = 0;
/** Wall-clock length the Bow_Shoot clip is compressed into, in seconds. */
const SHOOT_DURATION = 0.45;
/** Locomotion crossfade time, in seconds. */
const FADE = 0.15;
/**
 * Opacity of the team-color overlay on the body texture (0 = none, 1 = solid).
 * Strong enough that blue vs red team reads at a glance on the map.
 */
const TEAM_TINT = 0.5;
/** The overlay uses a fully saturated variant of the team color (HSL). */
const TINT_SATURATION = 1.0;
const TINT_LIGHTNESS = 0.55;
/**
 * Constant team-colored emissive on the body. The texture is mostly dark
 * leather/cloth, so a multiply tint alone can't produce a clear red/blue —
 * the additive glow keeps the team readable regardless of texture darkness.
 */
const TEAM_GLOW = 0.35;

const CLIP_IDLE = 'Idle_Weapon';
const CLIP_RUN = 'Run_Holding';
const CLIP_SHOOT = 'Bow_Shoot';

export class RangerRig implements HeroRig {
  readonly root = new THREE.Group();

  private _mixer: THREE.AnimationMixer | null = null;
  private _idle: THREE.AnimationAction | null = null;
  private _run: THREE.AnimationAction | null = null;
  private _shoot: THREE.AnimationAction | null = null;
  private _materials: THREE.MeshStandardMaterial[] = [];
  private _bodyMat: THREE.MeshStandardMaterial | null = null;
  private _teamEmissive: THREE.Color;

  private _moving = false;
  // Buffered state, applied when the async load completes.
  private _emissive = 0x000000;
  private _emissiveIntensity = 0;
  private _opacity = 1;
  private _shootQueued = false;
  private _disposed = false;

  constructor(teamColor: number) {
    this._teamEmissive = new THREE.Color(teamColor);

    this.root.rotation.y = YAW_OFFSET;
    this.root.scale.setScalar(MODEL_SCALE);

    createRangerInstance().then(({ scene, clips, materials }) => {
      if (this._disposed) return;
      this.root.add(scene);
      this._materials = [...materials.values()];

      // Team tint on the body texture (materials are per-instance clones).
      // Saturate the team color first so the multiply-tint reads as a clear
      // blue/red instead of a subtle pastel shift.
      const body = materials.get('Ranger_Texture');
      const hsl = { h: 0, s: 0, l: 0 };
      const tint = new THREE.Color(teamColor);
      tint.getHSL(hsl);
      tint.setHSL(hsl.h, TINT_SATURATION, TINT_LIGHTNESS);
      body?.color.lerp(tint, TEAM_TINT);
      this._bodyMat = body ?? null;

      this._mixer = new THREE.AnimationMixer(scene);
      const clip = (name: string) => {
        const c = THREE.AnimationClip.findByName(clips, name);
        if (!c) throw new Error(`ranger.glb is missing animation clip "${name}"`);
        return c;
      };
      this._idle = this._mixer.clipAction(clip(CLIP_IDLE));
      this._run = this._mixer.clipAction(clip(CLIP_RUN));
      this._shoot = this._mixer.clipAction(clip(CLIP_SHOOT));
      this._shoot.setLoop(THREE.LoopOnce, 1);
      this._shoot.setDuration(SHOOT_DURATION);

      // When the shot finishes, hand back to the locomotion action.
      this._mixer.addEventListener('finished', (e) => {
        if (e.action !== this._shoot) return;
        const to = this._moving ? this._run! : this._idle!;
        this._shoot!.fadeOut(FADE);
        to.reset().fadeIn(FADE).play();
      });

      (this._moving ? this._run : this._idle)!.play();
      this._applyEmissive();
      this._applyOpacity();
      if (this._shootQueued) {
        this._shootQueued = false;
        this.playShoot();
      }
    });
  }

  update(dt: number, moving: boolean, speed: number): void {
    if (!this._mixer) {
      this._moving = moving;
      return;
    }

    if (moving !== this._moving) {
      this._moving = moving;
      // Don't fight the one-shot; the 'finished' handler picks the right pose.
      if (!this._shoot!.isRunning()) {
        const from = moving ? this._idle! : this._run!;
        const to = moving ? this._run! : this._idle!;
        from.fadeOut(FADE);
        to.reset().fadeIn(FADE).play();
      }
    }

    // Run cadence tracks actual move speed (speed bonuses etc.).
    this._run!.timeScale = speed / HERO.baseSpeed;

    this._mixer.update(dt);
  }

  playShoot(): void {
    if (!this._mixer) {
      this._shootQueued = true;
      return;
    }
    const from = this._moving ? this._run! : this._idle!;
    from.fadeOut(FADE / 2);
    this._shoot!.reset().fadeIn(FADE / 2).play();
  }

  setEmissive(color: number, intensity: number): void {
    this._emissive = intensity > 0 ? color : 0x000000;
    this._emissiveIntensity = intensity;
    this._applyEmissive();
  }

  setOpacity(opacity: number): void {
    this._opacity = opacity;
    this._applyOpacity();
  }

  onRespawn(): void {
    this._shootQueued = false;
    this.setEmissive(0x000000, 0);
    this.setOpacity(1);
    if (this._mixer) {
      this._mixer.stopAllAction();
      (this._moving ? this._run : this._idle)!.reset().play();
    }
  }

  dispose(): void {
    this._disposed = true;
  }

  private _applyEmissive(): void {
    const flashing = this._emissiveIntensity > 0;
    for (const m of this._materials) {
      if (flashing) {
        m.emissive.set(this._emissive);
        m.emissiveIntensity = this._emissiveIntensity;
      } else if (m === this._bodyMat) {
        // At rest the body carries the team glow, not black.
        m.emissive.copy(this._teamEmissive);
        m.emissiveIntensity = TEAM_GLOW;
      } else {
        m.emissive.set(0x000000);
        m.emissiveIntensity = 0;
      }
    }
  }

  private _applyOpacity(): void {
    for (const m of this._materials) {
      if (this._opacity >= 1) {
        m.transparent = false;
        m.opacity = 1;
      } else {
        m.transparent = true;
        m.opacity = this._opacity;
      }
    }
  }
}
