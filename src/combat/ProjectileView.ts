/**
 * Render-only view of a projectile (arrow). Owns the Three.js mesh; each
 * frame it *reads* a plain `ProjectileState` and mirrors it onto the mesh.
 * No gameplay logic lives here — the sim is the source of truth.
 */
import * as THREE from 'three';
import { ProjectileState } from '../sim/state';
import { ARROW } from '../sim/rules';

export class ProjectileView {
  readonly mesh: THREE.Group;
  readonly projectileId: string;

  private _light: THREE.PointLight;

  constructor(projectileId: string) {
    this.projectileId = projectileId;
    this.mesh = this._buildMesh();
    this.mesh.visible = false;
    this._light = this.mesh.getObjectByName('arrowLight') as THREE.PointLight;
  }

  /** Mirror the simulation state onto the mesh for this frame. */
  sync(state: ProjectileState, heightAt: (x: number, z: number) => number): void {
    this.mesh.visible = true;
    this.mesh.position.set(
      state.pos.x,
      heightAt(state.pos.x, state.pos.z) + ARROW.flyHeight,
      state.pos.z,
    );
    this.mesh.rotation.y = Math.atan2(state.dir.x, state.dir.z);
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }

  // ── Mesh (same geometry as the original Projectile) ────────────

  private _buildMesh(): THREE.Group {
    const group = new THREE.Group();

    const shaftGeo = new THREE.CylinderGeometry(1.2, 1.2, 24, 6);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0xddcc88, roughness: 0.3, emissive: 0x331100,
    });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.z = 12;
    shaft.rotation.x = Math.PI / 2;
    shaft.name = 'arrowTrail';
    group.add(shaft);

    const headGeo = new THREE.ConeGeometry(2, 7, 6);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xcccccc, roughness: 0.2, metalness: 0.8, emissive: 0x111111,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.z = 26;
    head.rotation.x = Math.PI / 2;
    group.add(head);

    const light = new THREE.PointLight(0xffaa44, 60, 60);
    light.position.z = 12;
    light.name = 'arrowLight';
    group.add(light);

    return group;
  }
}
