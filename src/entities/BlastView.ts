/**
 * Render-only view of a pending R-spell blast zone: a flat translucent disc
 * plus an edge ring laid on the ground at the target point. Pulses faster as
 * the fuse burns down. No gameplay logic lives here.
 */
import * as THREE from 'three';
import { BlastState } from '../sim/state';
import { BLAST } from '../sim/rules';

export class BlastView {
  readonly mesh: THREE.Group;
  readonly blastId: string;

  private _discMat: THREE.MeshBasicMaterial;
  private _ringMat: THREE.MeshBasicMaterial;

  constructor(blastId: string) {
    this.blastId = blastId;

    this.mesh = new THREE.Group();

    // Filled danger disc
    const discGeo = new THREE.CircleGeometry(BLAST.radius, 48);
    this._discMat = new THREE.MeshBasicMaterial({
      color: 0xff3311,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    const disc = new THREE.Mesh(discGeo, this._discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = 998;
    this.mesh.add(disc);

    // Edge ring
    const ringGeo = new THREE.RingGeometry(BLAST.radius - 6, BLAST.radius, 48);
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0xff5522,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, this._ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 999;
    this.mesh.add(ring);
  }

  /** Mirror the simulation state onto the mesh for this frame. */
  sync(state: BlastState, heightAt: (x: number, z: number) => number): void {
    const y = heightAt(state.pos.x, state.pos.z);
    this.mesh.position.set(state.pos.x, y + 1.5, state.pos.z);

    // Pulse speeds up as the fuse runs out.
    const t = Math.max(state.timer, 0);
    const urgency = 1 - t / BLAST.delay; // 0 → 1
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / (120 - 70 * urgency));
    this._discMat.opacity = 0.12 + 0.14 * pulse + 0.1 * urgency;
    this._ringMat.opacity = 0.6 + 0.4 * pulse;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    for (const child of this.mesh.children) {
      const m = child as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
