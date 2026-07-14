import * as THREE from "three";
import { Pathfinder } from "../navigation/Pathfinder";
import { NavGrid } from "../navigation/NavGrid";
import { ArrowAbility } from "../combat/ArrowAbility";
import { HealthBar } from "./HealthBar";

export type HeroState = "idle" | "moving";

/** Build a simple flat circle mesh for the hero. */
function buildHeroCircle(radius: number, color: number): THREE.Group {
  const group = new THREE.Group();

  // Body — flat disc
  const bodyGeo = new THREE.CylinderGeometry(radius, radius, 0.15, 24);
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.name = 'heroBody';
  group.add(body);

  // Direction indicator — small triangle to show facing
  const triShape = new THREE.Shape();
  triShape.moveTo(0, -radius * 1.2);
  triShape.lineTo(-radius * 0.35, -radius * 0.5);
  triShape.lineTo(radius * 0.35, -radius * 0.5);
  triShape.closePath();
  const triGeo = new THREE.ShapeGeometry(triShape);
  const triMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, side: THREE.DoubleSide });
  const tri = new THREE.Mesh(triGeo, triMat);
  tri.rotation.x = -Math.PI / 2; // lay flat on XZ
  tri.position.y = 0.08;
  tri.name = 'heroFacing';
  group.add(tri);

  // Shadow disc
  const shadowGeo = new THREE.CylinderGeometry(radius * 0.9, radius * 0.9, 0.05, 24);
  const shadowMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, transparent: true, opacity: 0.25 });
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.position.y = -0.1;
  shadow.name = 'heroShadow';
  group.add(shadow);

  return group;
}

/**
 * Player-controlled hero entity.
 *
 * Owns its Three.js mesh, manages movement, ability charging,
 * health, death, and respawn. Movement and charging are independent.
 */
export class Hero {
  readonly mesh: THREE.Group;
  readonly speed = 24;
  readonly scale: number;

  private _pathfinder: Pathfinder;
  private _navGrid: NavGrid;
  private _waypoints: THREE.Vector3[] = [];
  private _state: HeroState = "idle";

  // Smooth facing
  private _currentFacing = 0;
  private _targetFacing = 0;
  private _turnSpeed = 12;

  // Health
  readonly maxHP = 100;
  private _hp: number;
  private _alive = true;
  private _invulnerable = false;
  private _invulnerableTimer = 0;
  private _respawnTimer = 0;
  private _respawnDelay = 3; // seconds

  // Hit flash
  private _hitFlashTimer = 0;
  private _bodyMat: THREE.MeshStandardMaterial;

  // Health bar
  private _healthBar: HealthBar;

  // Ability
  ability: ArrowAbility | null = null;

  // Sub-mesh refs
  private _body: THREE.Mesh;
  private _shadow: THREE.Mesh;

  constructor(pathfinder: Pathfinder, navGrid: NavGrid, scale = 3) {
    this._pathfinder = pathfinder;
    this._navGrid = navGrid;
    this._hp = this.maxHP;
    this.scale = scale;

    this.mesh = buildHeroCircle(0.45, 0x4488cc);
    this.mesh.scale.setScalar(this.scale);
    this._body = this.mesh.getObjectByName("heroBody") as THREE.Mesh;
    this._bodyMat = this._body.material as THREE.MeshStandardMaterial;
    this._shadow = this.mesh.getObjectByName("heroShadow") as THREE.Mesh;

    // Health bar as child of mesh (group scale handles sizing & position)
    this._healthBar = new HealthBar(this.maxHP);
    this.mesh.add(this._healthBar.sprite);
  }

  // ── Public getters ────────────────────────────────────────────

  get state(): HeroState {
    return this._state;
  }
  get isCharging(): boolean {
    return this.ability?.state === "charging";
  }
  get isAlive(): boolean {
    return this._alive;
  }
  get hp(): number {
    return this._hp;
  }
  get hpRatio(): number {
    return this._hp / this.maxHP;
  }
  get isInvulnerable(): boolean {
    return this._invulnerable;
  }
  get respawnTimer(): number {
    return this._respawnTimer;
  }
  /** Approximate collision radius of the hero's body (scaled). */
  get bodyRadius(): number {
    return 0.45 * this.scale;
  }

  get position(): THREE.Vector3 {
    return this.mesh.position;
  }
  get waypointCount(): number {
    return this._waypoints.length;
  }
  get facing(): number {
    return this._currentFacing;
  }

  // ── Movement ──────────────────────────────────────────────────

  setDestination(worldPos: THREE.Vector3): void {
    if (!this._alive) return;

    const start = this._navGrid.worldToGrid(
      this.mesh.position.x,
      this.mesh.position.z,
    );
    const goal = this._navGrid.worldToGrid(worldPos.x, worldPos.z);
    const path = this._pathfinder.findPath(
      start.gx,
      start.gz,
      goal.gx,
      goal.gz,
    );

    if (path && path.length > 1) {
      this._waypoints = path.slice(1).map((p) => {
        const w = this._navGrid.gridToWorld(p.gx, p.gz);
        return new THREE.Vector3(w.wx, 0.5, w.wz);
      });
      this._state = "moving";
    } else {
      this._waypoints = [];
      this._state = "idle";
    }
  }

  stop(): void {
    this._waypoints = [];
    this._state = "idle";
  }

  // ── Ability ───────────────────────────────────────────────────

  beginCharge(): void {
    if (!this._alive) return;
    this.ability?.startCharge(performance.now() / 1000);
  }

  releaseCharge(aimPos?: THREE.Vector3): void {
    if (!this._alive) return;
    this.ability?.releaseCharge(aimPos);
  }

  // ── Health & Damage ───────────────────────────────────────────

  /**
   * Apply damage. Respects invulnerability. Triggers hit effects.
   * Returns true if the hero died from this hit.
   */
  takeDamage(amount: number): boolean {
    if (!this._alive || this._invulnerable) return false;

    this._hp = Math.max(0, this._hp - amount);
    this._healthBar.setHP(this._hp, this.maxHP);

    // Hit flash
    this._hitFlashTimer = 0.15;
    this._bodyMat.emissive?.set(0xff0000);
    this._bodyMat.emissiveIntensity = 0.6;

    if (this._hp <= 0) {
      this._die();
      return true;
    }
    return false;
  }

  /**
   * Respawn the hero at the given world position.
   * Restores HP, shows mesh, grants brief invulnerability.
   */
  respawn(position: THREE.Vector3): void {
    this.mesh.position.copy(position);
    this._hp = this.maxHP;
    this._alive = true;
    this._invulnerable = true;
    this._invulnerableTimer = 1.5;
    this._respawnTimer = 0;
    this._waypoints = [];
    this._state = "idle";
    this._hitFlashTimer = 0;

    this.mesh.visible = true;
    this._healthBar.setHP(this._hp, this.maxHP);
    this._healthBar.show();

    // Reset body appearance
    this._bodyMat.emissive?.set(0x000000);
    this._bodyMat.emissiveIntensity = 0;
    this._bodyMat.transparent = false;
    this._bodyMat.opacity = 1;
  }

  // ── Update ────────────────────────────────────────────────────

  update(delta: number): void {
    if (!this._alive) {
      // Tick respawn timer
      this._respawnTimer -= delta;
      return;
    }

    // Tick ability
    this.ability?.update(delta, performance.now() / 1000);

    // Invulnerability countdown
    if (this._invulnerable) {
      this._invulnerableTimer -= delta;
      if (this._invulnerableTimer <= 0) {
        this._invulnerable = false;
        this._bodyMat.transparent = false;
        this._bodyMat.opacity = 1;
      } else {
        // Flicker during invulnerability
        const flicker = Math.sin(this._invulnerableTimer * 20) > 0;
        this._bodyMat.transparent = true;
        this._bodyMat.opacity = flicker ? 0.4 : 0.8;
      }
    }

    // Hit flash countdown
    if (this._hitFlashTimer > 0) {
      this._hitFlashTimer -= delta;
      const t = this._hitFlashTimer / 0.15;
      this._bodyMat.emissiveIntensity = t * 0.6;
      if (this._hitFlashTimer <= 0) {
        this._bodyMat.emissive?.set(0x000000);
      }
    }

    // Movement
    if (this._state === "moving" && this._waypoints.length > 0) {
      this._moveAlongPath(delta);
    } else if (this._waypoints.length === 0) {
      this._state = "idle";
    }

    this._updateFacing(delta);
  }

  /** Returns true if respawn is ready (timer expired). */
  isRespawnReady(): boolean {
    return !this._alive && this._respawnTimer <= 0;
  }

  // ── Private ────────────────────────────────────────────────────

  private _die(): void {
    this._alive = false;
    this._respawnTimer = this._respawnDelay;

    // Cancel any active charge
    this.ability?.cancelCharge();

    // Hide mesh
    this.mesh.visible = false;
    this._healthBar.hide();
  }

  private _moveAlongPath(delta: number): void {
    const target = this._waypoints[0];
    const dir = new THREE.Vector3().subVectors(target, this.mesh.position);
    dir.y = 0;
    const dist = dir.length();

    if (dist < 0.1) {
      this.mesh.position.copy(target);
      this._waypoints.shift();
      if (this._waypoints.length === 0) this._state = "idle";
    } else {
      const step = Math.min(this.speed * delta, dist);
      dir.normalize();
      this.mesh.position.add(dir.clone().multiplyScalar(step));
      this._targetFacing = Math.atan2(dir.x, dir.z);
    }
  }

  private _updateFacing(delta: number): void {
    let diff = this._targetFacing - this._currentFacing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    const maxTurn = this._turnSpeed * delta;
    if (Math.abs(diff) < maxTurn) {
      this._currentFacing = this._targetFacing;
    } else {
      this._currentFacing += Math.sign(diff) * maxTurn;
    }
    this.mesh.rotation.y = this._currentFacing;
  }

  // ── Mesh ──────────────────────────────────────────────────────
}
