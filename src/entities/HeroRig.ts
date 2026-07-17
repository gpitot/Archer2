/**
 * Hero mesh "rig" abstraction: HeroView owns positioning, health bar and
 * flash timers, and delegates the actual body mesh + animation to a rig.
 *
 * Two implementations exist so the models can be compared side by side:
 *  - RangerRig (default): Quaternius "RPG Characters" ranger GLB, skeletal.
 *  - ClassicArcherRig (`?hero=classic`): the original procedural low-poly mesh.
 */
import * as THREE from 'three';
import { ClassicArcherRig } from './ClassicArcherRig';
import { RangerRig } from './RangerRig';

/** World scale applied to the HeroView group (rig roots live under it). */
export const MESH_SCALE = 52.5;

export interface HeroRig {
  /** Root object; HeroView parents this under its (scaled) group. */
  readonly root: THREE.Object3D;

  /**
   * Per-frame animation update.
   * @param moving whether the hero is walking this frame
   * @param speed  current move speed in world units/s (cadence scaling)
   */
  update(dt: number, moving: boolean, speed: number): void;

  /** Trigger the bow-shoot gesture/animation. */
  playShoot(): void;

  /** Set the body emissive flash (intensity 0 clears it). */
  setEmissive(color: number, intensity: number): void;

  /** Set body opacity; 1 restores full opacity and disables transparency. */
  setOpacity(opacity: number): void;

  /** Reset transient animation/flash state after a respawn. */
  onRespawn(): void;

  /** Optional cleanup (e.g. cancel a pending async model load). */
  dispose?(): void;
}

function useClassicMesh(): boolean {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('hero') === 'classic';
}

/** Build the hero rig selected by the `?hero=` URL param (default: ranger). */
export function createHeroRig(teamColor: number): HeroRig {
  return useClassicMesh() ? new ClassicArcherRig(teamColor) : new RangerRig(teamColor);
}
