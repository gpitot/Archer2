/**
 * Render-only view of a power-up rune spot. Owns the Three.js meshes; each
 * frame it *reads* a plain `RuneState` and mirrors presence/type onto a
 * bobbing, spinning gem (DotA-style). No gameplay logic lives here.
 */
import * as THREE from 'three';
import { RuneState } from '../sim/state';
import { RUNE_TYPES, RuneTypeId } from '../sim/runeRules';

export class RuneView {
  readonly mesh: THREE.Group;
  readonly runeId: string;

  private _gem: THREE.Mesh;
  private _gemMat: THREE.MeshStandardMaterial;
  private _ring: THREE.Mesh;
  private _ringMat: THREE.MeshBasicMaterial;
  private _glow: THREE.PointLight;
  private _time = Math.random() * Math.PI * 2;
  private _type: RuneTypeId | null = null;

  constructor(runeId: string) {
    this.runeId = runeId;
    this.mesh = new THREE.Group();

    // Spinning gem.
    this._gemMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.25,
      metalness: 0.2,
      emissive: 0xffffff,
      emissiveIntensity: 0.8,
    });
    this._gem = new THREE.Mesh(new THREE.OctahedronGeometry(14, 0), this._gemMat);
    this._gem.scale.y = 1.5;
    this.mesh.add(this._gem);

    // Ground ring marking the spot.
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._ring = new THREE.Mesh(new THREE.RingGeometry(18, 24, 32).rotateX(-Math.PI / 2), this._ringMat);
    this._ring.renderOrder = 5;
    this.mesh.add(this._ring);

    // Soft colored glow.
    this._glow = new THREE.PointLight(0xffffff, 1.2, 120);
    this.mesh.add(this._glow);
  }

  /** Mirror the simulation state onto the meshes for this frame. */
  sync(state: RuneState, dt: number, heightAt: (x: number, z: number) => number): void {
    if (!state.active) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    if (state.type !== this._type) {
      this._type = state.type;
      const color = RUNE_TYPES[state.type].color;
      this._gemMat.color.set(color);
      this._gemMat.emissive.set(color);
      this._ringMat.color.set(color);
      this._glow.color.set(color);
    }

    this._time += dt;
    const y = heightAt(state.pos.x, state.pos.z);
    this.mesh.position.set(state.pos.x, y, state.pos.z);
    this._gem.position.y = 26 + Math.sin(this._time * 2.2) * 5;
    this._gem.rotation.y = this._time * 1.6;
    this._glow.position.y = this._gem.position.y;
    this._gemMat.emissiveIntensity = 0.7 + 0.25 * Math.sin(this._time * 3.1);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this._gem.geometry.dispose();
    this._gemMat.dispose();
    this._ring.geometry.dispose();
    this._ringMat.dispose();
  }
}
