/**
 * Render-only view of an attackable building (the Defenders-mode castle).
 * Reads a plain `BuildingState` each frame and mirrors hp onto a billboard
 * health bar; on death the keep collapses into a smoked-out rubble tint.
 * Procedural meshes in the FountainView style — no GLB asset needed.
 */
import * as THREE from 'three';
import { BuildingState } from '../sim/state';
import { BUILDING_TYPES } from '../sim/buildingRules';
import { HealthBar } from './HealthBar';

const STONE = 0x9a9186;
const STONE_DARK = 0x6f675e;
const ROOF = 0x4a5a8a;
const RUBBLE_TINT = 0x3a3632;

export class BuildingView {
  readonly mesh: THREE.Group;

  private _healthBar: HealthBar;
  private _materials: THREE.MeshStandardMaterial[] = [];
  private _flashTimer = 0;
  private _dead = false;

  constructor(private _building: { type: BuildingState['type'] }) {
    this.mesh = this._buildMesh(BUILDING_TYPES[_building.type].bodyRadius);

    this._healthBar = new HealthBar(BUILDING_TYPES[_building.type].maxHp);
    this._healthBar.sprite.position.set(0, 210, 0);
    this._healthBar.sprite.scale.set(140, 14, 1);
    this.mesh.add(this._healthBar.sprite);
  }

  /** Mirror sim state onto the meshes. Buildings never move after spawn. */
  sync(state: BuildingState, dt: number, heightAt: (x: number, z: number) => number): void {
    const y = heightAt(state.pos.x, state.pos.z);
    this.mesh.position.set(state.pos.x, y, state.pos.z);

    this._healthBar.setHP(state.hp, BUILDING_TYPES[state.type].maxHp);

    if (this._flashTimer > 0) {
      this._flashTimer = Math.max(0, this._flashTimer - dt);
      const glow = this._flashTimer * 4;
      for (const m of this._materials) m.emissive.setRGB(glow, glow * 0.2, glow * 0.1);
    }

    if (!state.alive && !this._dead) this._collapse();
  }

  /** Red emissive pulse on taking a hit. */
  flashHit(): void {
    this._flashTimer = 0.25;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** Razed: sink the keep, tint it to charred rubble, drop the health bar. */
  private _collapse(): void {
    this._dead = true;
    this._healthBar.hide();
    this.mesh.scale.set(1, 0.35, 1);
    for (const m of this._materials) {
      m.color.setHex(RUBBLE_TINT);
      m.emissive.setRGB(0, 0, 0);
    }
  }

  // ── Mesh: round stone keep, corner towers, banner roof cones ──────

  private _buildMesh(radius: number): THREE.Group {
    const g = new THREE.Group();

    const stone = this._mat(STONE, 0.85);
    const stoneDark = this._mat(STONE_DARK, 0.9);
    const roof = this._mat(ROOF, 0.6);

    // Outer wall drum sized to the sim's body radius.
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.85, radius, 90, 12), stone);
    wall.position.y = 45;
    g.add(wall);

    // Crenellated rim: blocks around the wall top.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const merlon = new THREE.Mesh(new THREE.BoxGeometry(18, 16, 12), stoneDark);
      merlon.position.set(Math.cos(a) * radius * 0.85, 98, Math.sin(a) * radius * 0.85);
      merlon.rotation.y = -a;
      g.add(merlon);
    }

    // Central keep tower + roof cone.
    const keep = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.42, radius * 0.5, 150, 10), stone);
    keep.position.y = 75;
    g.add(keep);
    const keepRoof = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.5, 55, 10), roof);
    keepRoof.position.y = 178;
    g.add(keepRoof);

    // Four corner towers on the wall ring.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const px = Math.cos(a) * radius * 0.8;
      const pz = Math.sin(a) * radius * 0.8;
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(16, 20, 120, 8), stoneDark);
      tower.position.set(px, 60, pz);
      g.add(tower);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(20, 34, 8), roof);
      cone.position.set(px, 137, pz);
      g.add(cone);
    }

    // Ground ring marking the footprint (matches the sim's bodyRadius).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 4, radius, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xccaa66,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.position.y = 0.3;
    ring.renderOrder = 5;
    g.add(ring);

    return g;
  }

  private _mat(color: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
    this._materials.push(m);
    return m;
  }
}
