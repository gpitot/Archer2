/**
 * Render-only view of a jungle creep. Reads a plain `CreepState` each frame and
 * mirrors it onto a skinned GLB monster model (see `MonsterModel`) — no gameplay
 * logic. The model loads asynchronously; until it arrives the view is just an
 * empty group carrying the health bar.
 *
 * Locomotion crossfades idle ↔ move by whether the sim position changed since
 * last frame; a one-shot attack action plays on melee/fireball events, and a
 * red emissive pulse (plus the hit-react clip) fires on damage. Because a camp
 * respawns one tier up as a *different* monster type, `sync` detects a changed
 * `state.type` and hot-swaps the model.
 */
import * as THREE from 'three';
import { CreepState } from '../sim/state';
import { CreepTypeId, creepMaxHp, CREEP_TYPES } from '../sim/creepRules';
import { HERO } from '../sim/rules';
import { HealthBar } from './HealthBar';
import { UnitView } from './UnitView';
import { createMonsterInstance, pickClip, MonsterModelConfig } from './MonsterModel';

const FADE = 0.15;
const ATTACK_DURATION = 0.5;
/** Amber ground ring — creeps are neutral-hostile, distinct from hero team colors. */
const CREEP_RING_COLOR = 0xffaa33;

export class CreepView extends UnitView {
  readonly creepId: string;

  private _type: CreepTypeId;
  private _healthBar: HealthBar;
  private _loadToken = 0;

  private _model: THREE.Group | null = null;
  private _config: MonsterModelConfig | null = null;
  private _materials: THREE.MeshStandardMaterial[] = [];
  private _mixer: THREE.AnimationMixer | null = null;
  private _idle: THREE.AnimationAction | null = null;
  private _move: THREE.AnimationAction | null = null;
  private _attack: THREE.AnimationAction | null = null;
  private _hitReact: THREE.AnimationAction | null = null;

  private _moving = false;
  private _lastX = 0;
  private _lastZ = 0;

  constructor(
    creepId: string,
    type: CreepTypeId,
    private _heightAt: (x: number, z: number) => number,
  ) {
    super(new THREE.Group());
    this.creepId = creepId;
    this._type = type;

    // Amber foot ring in raw world units (the creep group isn't scaled).
    this.addFootRing(CREEP_TYPES[type].bodyRadius, CREEP_RING_COLOR, { tube: 3, y: 2, opacity: 0.3 });

    this._healthBar = new HealthBar(creepMaxHp(type, 1));
    this._healthBar.sprite.position.set(0, 80, 0);
    this._healthBar.sprite.scale.set(60, 8, 1);
    this.mesh.add(this._healthBar.sprite);

    this._load(type);
  }

  private _load(type: CreepTypeId): void {
    const token = ++this._loadToken;
    createMonsterInstance(type).then((inst) => {
      if (token !== this._loadToken) return; // superseded by a later type-swap
      this._model = inst.scene;
      this._config = inst.config;
      this._materials = inst.materials;
      this.mesh.add(inst.scene);
      this._healthBar.sprite.position.y = inst.config.worldHeight + 16;

      this._mixer = new THREE.AnimationMixer(inst.scene);
      this._idle = this._action(inst.clips, inst.config.clips.idle);
      this._move = this._action(inst.clips, inst.config.clips.move);
      this._attack = this._action(inst.clips, inst.config.clips.attack, true);
      this._hitReact = this._action(inst.clips, inst.config.clips.hit, true);
      (this._moving ? this._move : this._idle)?.play();

      this._mixer.addEventListener('finished', (e) => {
        if (e.action === this._attack || e.action === this._hitReact) {
          (this._moving ? this._move : this._idle)?.reset().fadeIn(FADE).play();
        }
      });

      // Re-apply an in-flight hit flash to the freshly built materials.
      if (this._hitFlashTimer > 0) this._applyFlash();
    });
  }

  private _action(
    clips: THREE.AnimationClip[],
    candidates: string[],
    once = false,
  ): THREE.AnimationAction | null {
    if (!this._mixer) return null;
    const clip = pickClip(clips, candidates);
    if (!clip) return null;
    const action = this._mixer.clipAction(clip);
    if (once) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    return action;
  }

  /** Pulse the red hit flash + hit-react clip (driven by a damage event). */
  flashHit(): void {
    this._hitFlashTimer = 0.15;
    this._applyFlash();
    if (this._hitReact && this._mixer) {
      this._hitReact.reset().setDuration(0.35).fadeIn(FADE / 2).play();
    }
  }

  /** Play the attack lunge/swing once (driven by a melee/fireball event). */
  playAttack(): void {
    if (!this._attack || !this._mixer) return;
    (this._moving ? this._move : this._idle)?.fadeOut(FADE / 2);
    this._attack.reset().setDuration(ATTACK_DURATION).fadeIn(FADE / 2).play();
  }

  /** Mirror the simulation state onto the mesh for this frame. */
  sync(state: CreepState, dt: number): void {
    if (state.type !== this._type) {
      // Camp climbed a tier — this slot came back as a different monster.
      this._swapType(state.type);
    }

    if (!state.alive) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this._healthBar.setHP(state.hp, creepMaxHp(state.type, state.level));

    const hover = this._config?.hover ?? 0;
    const y = this._heightAt(state.pos.x, state.pos.z) + HERO.groundOffset + hover;
    this.mesh.position.set(state.pos.x, y, state.pos.z);
    this.mesh.rotation.y = state.facing + (this._config?.yaw ?? 0);

    this._animate(state, dt);

    if (this._hitFlashTimer > 0) {
      this._hitFlashTimer -= dt;
      const k = Math.max(0, this._hitFlashTimer / 0.15) * 0.7;
      for (const m of this._materials) m.emissiveIntensity = k;
      if (this._hitFlashTimer <= 0) for (const m of this._materials) m.emissive.set(0x000000);
    }
  }

  private _animate(state: CreepState, dt: number): void {
    const moved = state.pos.x !== this._lastX || state.pos.z !== this._lastZ;
    this._lastX = state.pos.x;
    this._lastZ = state.pos.z;

    if (moved !== this._moving) {
      this._moving = moved;
      const from = moved ? this._idle : this._move;
      const to = moved ? this._move : this._idle;
      if (to && to !== from && !(this._attack?.isRunning() || this._hitReact?.isRunning())) {
        from?.fadeOut(FADE);
        to.reset().fadeIn(FADE).play();
      }
    }

    this._mixer?.update(dt);
  }

  private _swapType(type: CreepTypeId): void {
    this._type = type;
    if (this._model) {
      this.mesh.remove(this._model);
      this._model = null;
    }
    this._mixer = null;
    this._idle = this._move = this._attack = this._hitReact = null;
    this._materials = [];
    this._config = null;
    this._load(type);
  }

  private _applyFlash(): void {
    for (const m of this._materials) {
      m.emissive.set(0xff0000);
      m.emissiveIntensity = 0.7;
    }
  }

  dispose(): void {
    this._loadToken++; // cancel any in-flight load
    this.mesh.removeFromParent();
  }
}
