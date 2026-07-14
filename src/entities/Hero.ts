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
  readonly baseSpeed = 480;
  private _speedBonus = 0; // from items like Boots

  get speed(): number { return this.baseSpeed + this._speedBonus; }

  /** Add permanent speed from an item. */
  addSpeedBonus(amount: number): void { this._speedBonus += amount; }

  // ── Inventory (6 slots) ──
  private _inventory: (string | null)[] = [null, null, null, null, null, null];

  get inventory(): readonly (string | null)[] { return this._inventory; }

  /** Check if item is already owned. */
  hasItem(itemId: string): boolean { return this._inventory.includes(itemId); }

  /** Add item to first empty slot. Returns slot index or -1 if full. */
  addItem(itemId: string): number {
    for (let i = 0; i < 6; i++) {
      if (this._inventory[i] === null) {
        this._inventory[i] = itemId;
        return i;
      }
    }
    return -1;
  }
  readonly scale: number;

  /** Height above the sampled terrain the hero mesh sits at. */
  static readonly GROUND_OFFSET = 0.5;

  private _pathfinder: Pathfinder;
  private _navGrid: NavGrid;
  private _heightAt: (x: number, z: number) => number;
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

  // XP & Levels
  private _xp = 0;
  private _level = 1;
  private _skillPoints = 1; // 1 point to spend at level 1
  readonly maxLevel = 10;
  // XP needed to reach each level (index = target level)
  private static readonly _xpTable = [0, 0, 200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400];

  // Gold & K/D
  private _gold = 0;
  private _kills = 0;
  private _deaths = 0;
  private _killStreak = 0;   // consecutive kills without dying
  private _multiKillCount = 0;
  private _multiKillTimer = 0; // seconds since last kill in chain

  // First blood flag (shared across all heroes)
  private static _firstBlood = true;

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

  constructor(
    pathfinder: Pathfinder,
    navGrid: NavGrid,
    scale = 3,
    heightAt: (x: number, z: number) => number = () => 0,
  ) {
    this._pathfinder = pathfinder;
    this._navGrid = navGrid;
    this._heightAt = heightAt;
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
  get isShooting(): boolean {
    return this.ability?.state === 'cooldown';
  }
  get xp(): number { return this._xp; }
  get level(): number { return this._level; }
  get skillPoints(): number { return this._skillPoints; }
  get gold(): number { return this._gold; }
  get kills(): number { return this._kills; }
  get deaths(): number { return this._deaths; }
  /** Total XP needed to reach the given level. */
  static xpForLevel(level: number): number {
    return Hero._xpTable[Math.min(level, 10)] ?? 5400;
  }

  /** Passive gold per second based on K/D. */
  get passiveIncome(): number {
    if (this._kills === 0) return 5;
    const raw = (this._deaths * 2) / this._kills;
    return Math.max(1, Math.min(30, Math.round(raw)));
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

    const path = this._pathfinder.findSmoothedPath(
      this.mesh.position.x,
      this.mesh.position.z,
      worldPos.x,
      worldPos.z,
    );

    if (path && path.length > 1) {
      // path[0] is the hero's current position — walk the rest.
      this._waypoints = path.slice(1).map((p) =>
        new THREE.Vector3(
          p.wx,
          this._heightAt(p.wx, p.wz) + Hero.GROUND_OFFSET,
          p.wz,
        ),
      );
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

  fireAbility(aimPos?: THREE.Vector3): void {
    if (!this._alive) return;
    this.ability?.fire(aimPos);
  }

  // ── Health & Damage ───────────────────────────────────────────

  /**
   * Apply damage from a source hero. Awards XP to the source on kill.
   * Returns true if the hero died from this hit.
   */
  takeDamage(source: Hero, amount: number): boolean {
    if (!this._alive || this._invulnerable) return false;

    this._hp = Math.max(0, this._hp - amount);
    this._healthBar.setHP(this._hp, this.maxHP);

    // Hit flash
    this._hitFlashTimer = 0.15;
    this._bodyMat.emissive?.set(0xff0000);
    this._bodyMat.emissiveIntensity = 0.6;

    if (this._hp <= 0) {
      this._die();
      // Track K/D
      this._deaths++;
      this._killStreak = 0; // victim loses streak
      source._kills++;
      source._killStreak++;

      // Award gold & XP
      source._awardKillGold(this);
      source.addXP(this._xpReward(source));

      // Multi-kill tracking
      source._multiKillTimer = 0.5; // reset multi-kill window
      source._multiKillCount++;

      return true;
    }
    return false;
  }

  /** XP the killer earns for killing this hero. */
  private _xpReward(killer: Hero): number {
    // Base XP from victim's level (WC3 hero kill table)
    const baseTable = [0, 100, 120, 160, 220, 300, 300, 300, 300, 300, 300];
    let xp = baseTable[Math.min(this._level, 10)];
    // Underdog bonus: 50 × level difference if victim is higher
    if (this._level > killer._level) {
      xp += (this._level - killer._level) * 50;
    }
    return xp;
  }

  /** Award kill gold (base + spree + bounty + multi-kill). */
  private _awardKillGold(victim: Hero): void {
    let total = 0;
    const msgs: string[] = [];

    // Base kill
    total += 5;

    // First blood
    if (Hero._firstBlood) {
      Hero._firstBlood = false;
      total += 5;
      msgs.push('First Blood!');
    }

    // Spree bonus (awarded to killer when reaching a spree level)
    if (this._killStreak >= 3) {
      const spreeBonus = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 7];
      const bonus = spreeBonus[Math.min(this._killStreak, 10)] ?? 7;
      total += bonus;
      if (bonus > 0) msgs.push(`+${bonus}g spree`);
    }

    // Bounty for ending victim's streak
    if (victim._killStreak >= 4) {
      const bountyTable = [0, 0, 0, 0, 1, 3, 6, 10, 15, 21, 28];
      const bounty = bountyTable[Math.min(victim._killStreak, 10)] ?? 28;
      total += bounty;
      msgs.push(`+${bounty}g bounty`);
    }

    // Multi-kill
    if (this._multiKillCount === 2) {
      total += 15;
      msgs.push('Double Kill! +15g');
    } else if (this._multiKillCount >= 3) {
      total += 30;
      msgs.push('Triple Kill! +30g');
    }

    this._gold += total;
    if (msgs.length > 0) {
      // will add floating text later; for now just add silently
    }
  }

  /** Add XP, triggering level-ups as needed. */
  addXP(amount: number): void {
    this._xp += amount;
    while (this._level < this.maxLevel && this._xp >= Hero._xpTable[this._level + 1]) {
      this._level++;
      this._skillPoints++;
    }
  }

  /** Add gold (external source like passive income). */
  addGold(amount: number): void {
    this._gold += amount;
  }

  /** Spend a skill point to level up or learn an ability. */
  spendSkillPoint(): boolean {
    if (this._skillPoints <= 0 || !this.ability) return false;
    if (this.ability.level >= 4) return false;
    this._skillPoints--;
    this.ability.levelUp();
    return true;
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

    // Multi-kill window decay
    if (this._multiKillTimer > 0) {
      this._multiKillTimer -= delta;
      if (this._multiKillTimer <= 0) {
        this._multiKillCount = 0;
      }
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

    // Follow the terrain surface (Y is presentation only; gameplay is 2D).
    this.mesh.position.y =
      this._heightAt(this.mesh.position.x, this.mesh.position.z) +
      Hero.GROUND_OFFSET;
  }

  /** Returns true if respawn is ready (timer expired). */
  isRespawnReady(): boolean {
    return !this._alive && this._respawnTimer <= 0;
  }

  // ── Private ────────────────────────────────────────────────────

  private _die(): void {
    this._alive = false;
    this._respawnTimer = this._respawnDelay;

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
