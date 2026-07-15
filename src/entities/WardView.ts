/**
 * Render-only view of a sentry ward. Owns the Three.js mesh; each frame it
 * *reads* a plain `WardState` and mirrors position / expiry blink onto the
 * mesh. No gameplay logic lives here.
 */
import * as THREE from 'three';
import { WardState } from '../sim/state';
import { WARD } from '../sim/rules';

export class WardView {
  readonly mesh: THREE.Group;
  readonly wardId: string;

  private _eyeMat: THREE.MeshStandardMaterial;

  constructor(wardId: string) {
    this.wardId = wardId;
    this.mesh = this._buildMesh();
    this._eyeMat = (this.mesh.getObjectByName('wardEye') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
  }

  /** Mirror the simulation state onto the mesh for this frame. */
  sync(state: WardState, heightAt: (x: number, z: number) => number): void {
    const y = heightAt(state.pos.x, state.pos.z);
    this.mesh.position.set(state.pos.x, y, state.pos.z);

    // Blink the eye during the last 10 seconds as an expiry warning.
    if (state.life < 10) {
      const blink = Math.sin(state.life * 12) > 0;
      this._eyeMat.emissiveIntensity = blink ? 1.2 : 0.2;
    } else {
      this._eyeMat.emissiveIntensity = 0.9;
    }
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }

  // ── Mesh (same geometry as the original Ward) ─────────────────

  private _buildMesh(): THREE.Group {
    const g = new THREE.Group();

    // Wooden stake
    const stakeGeo = new THREE.CylinderGeometry(2, 3, 18, 6);
    const stakeMat = new THREE.MeshStandardMaterial({ color: 0x6b4a26, roughness: 0.9 });
    const stake = new THREE.Mesh(stakeGeo, stakeMat);
    stake.position.y = 9;
    g.add(stake);

    // Glowing eye orb on top
    const eyeGeo = new THREE.SphereGeometry(5, 12, 10);
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x66ff88,
      roughness: 0.3,
      emissive: 0x22cc55,
      emissiveIntensity: 0.9,
    });
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.y = 21;
    eye.name = 'wardEye';
    g.add(eye);

    return g;
  }
}
