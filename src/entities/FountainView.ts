/**
 * Render-only view of a healing fountain. Owns the Three.js meshes; each
 * frame it positions the fountain at its static world location. The healing
 * logic lives in the sim; this is purely visual.
 */
import * as THREE from 'three';

export class FountainView {
  readonly mesh: THREE.Group;
  private _waterMat: THREE.MeshStandardMaterial;
  private _time = Math.random() * Math.PI * 2;

  constructor() {
    this.mesh = this._buildMesh();
    this._waterMat = (this.mesh.getObjectByName('fountainWater') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
  }

  /** Position the fountain and animate the water glow. */
  sync(pos: { x: number; z: number }, dt: number, heightAt: (x: number, z: number) => number): void {
    const y = heightAt(pos.x, pos.z);
    this.mesh.position.set(pos.x, y, pos.z);

    this._time += dt;
    // Softly pulse the water emissive for a living glow.
    this._waterMat.emissiveIntensity = 0.6 + 0.2 * Math.sin(this._time * 2.5);
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }

  // ── Mesh: stone basin + glowing blue water ──────────────────────

  private _buildMesh(): THREE.Group {
    const g = new THREE.Group();

    // Stone basin (outer ring)
    const basinGeo = new THREE.CylinderGeometry(38, 42, 18, 16, 1, true);
    const basinMat = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.7,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const basin = new THREE.Mesh(basinGeo, basinMat);
    basin.position.y = 9;
    g.add(basin);

    // Basin floor
    const floorGeo = new THREE.CylinderGeometry(38, 38, 3, 16);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x666666,
      roughness: 0.8,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = 1.5;
    g.add(floor);

    // Glowing water surface
    const waterGeo = new THREE.CylinderGeometry(30, 30, 2, 16);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x3399ff,
      roughness: 0.2,
      metalness: 0.3,
      emissive: 0x2266cc,
      emissiveIntensity: 0.6,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = 11;
    water.name = 'fountainWater';
    g.add(water);

    // Soft blue glow light
    const glow = new THREE.PointLight(0x4488ff, 1.5, 200);
    glow.position.y = 20;
    g.add(glow);

    // Decorative stone pillars (4 corners)
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const px = Math.cos(angle) * 42;
      const pz = Math.sin(angle) * 42;
      const pillarGeo = new THREE.CylinderGeometry(5, 6, 24, 6);
      const pillar = new THREE.Mesh(pillarGeo, basinMat);
      pillar.position.set(px, 12, pz);
      g.add(pillar);
    }

    // Ground ring marking the heal radius
    const ringGeo = new THREE.RingGeometry(28, 32, 32).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.2;
    ring.renderOrder = 5;
    g.add(ring);

    return g;
  }
}
