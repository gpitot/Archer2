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
  private _trailMat: THREE.MeshStandardMaterial;

  constructor(projectileId: string) {
    this.projectileId = projectileId;
    this.mesh = this._buildMesh();
    this.mesh.visible = false;
    this._light = this.mesh.getObjectByName('arrowLight') as THREE.PointLight;
    this._trailMat = (this.mesh.getObjectByName('arrowTrail') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
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

    // Pulse the trail opacity for a subtle living feel
    const pulse = 0.25 + 0.08 * Math.sin(performance.now() * 0.015);
    this._trailMat.opacity = pulse;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }

  // ── Mesh ────────────────────────────────────────────────────────

  private _buildMesh(): THREE.Group {
    const group = new THREE.Group();

    // ── Shaft (wooden body) ──
    const shaftGeo = new THREE.CylinderGeometry(1.8, 1.8, 32, 8);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0xc49a6c, roughness: 0.55, metalness: 0.05,
    });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.z = 14;
    shaft.rotation.x = Math.PI / 2;
    group.add(shaft);

    // ── Arrowhead (metallic, sharp) ──
    const headGeo = new THREE.ConeGeometry(2.6, 10, 8);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xd8d8d8, roughness: 0.15, metalness: 0.9, emissive: 0x111111,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.z = 35;
    head.rotation.x = Math.PI / 2;
    group.add(head);

    // ── Fletching (3 feathers at the tail) ──
    const featherMat = new THREE.MeshStandardMaterial({
      color: 0xe84040, roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
    });
    const nockMat = new THREE.MeshStandardMaterial({
      color: 0x333333, roughness: 0.4, metalness: 0.3,
    });

    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const featherGeo = new THREE.ConeGeometry(1.4, 9, 4);
      const feather = new THREE.Mesh(featherGeo, featherMat);
      feather.position.set(
        Math.cos(angle) * 1.8,
        Math.sin(angle) * 1.8,
        -3,
      );
      feather.rotation.x = Math.PI / 2;
      group.add(feather);
    }

    // Nock (small cylinder at the very back)
    const nockGeo = new THREE.CylinderGeometry(1.3, 1.5, 3, 8);
    const nock = new THREE.Mesh(nockGeo, nockMat);
    nock.position.z = -2;
    nock.rotation.x = Math.PI / 2;
    group.add(nock);

    // ── Motion trail (long tapering semi-transparent cone behind) ──
    const trailGeo = new THREE.CylinderGeometry(1.6, 0.2, 50, 8, 1, true);
    const trailMat = new THREE.MeshStandardMaterial({
      color: 0xffddaa,
      roughness: 0.5,
      emissive: 0x331100,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.position.z = -20; // extend behind the arrow
    trail.rotation.x = Math.PI / 2;
    trail.name = 'arrowTrail';
    trail.renderOrder = 1;
    group.add(trail);

    // ── Point light (warm glow around the arrowhead) ──
    const light = new THREE.PointLight(0xff9944, 80, 90);
    light.position.z = 30;
    light.name = 'arrowLight';
    group.add(light);

    return group;
  }
}
