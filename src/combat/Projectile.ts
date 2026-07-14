import * as THREE from 'three';
import { ObstacleRegistry } from '../world/ObstacleRegistry';
import { Hero } from '../entities/Hero';

export interface ProjectileConfig {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  maxRange: number;
  damage: number;
  owner: Hero;
}

export type ProjectileState = 'flying' | 'dead';
export type ProjectileResult =
  | { status: 'flying' }
  | { status: 'dead'; reason: 'range' | 'obstacle' }
  | { status: 'hit'; hero: Hero; source: Hero };

/**
 * A single projectile (arrow) that flies through the world.
 * Designed for object pooling.
 */
export class Projectile {
  readonly mesh: THREE.Group;

  private _state: ProjectileState = 'dead';
  private _direction = new THREE.Vector3();
  private _speed = 0;
  private _maxRange = 0;
  private _traveled = 0;
  private _damage = 0;

  private _obstacles: ObstacleRegistry;
  private _heroesProvider: () => Hero[];
  private _heightAt: (x: number, z: number) => number;
  private _owner: Hero | null = null;
  private _collisionRadius = 8;

  /** Height the arrow flies above the terrain beneath it. */
  static readonly FLY_HEIGHT = 22;

  constructor(
    obstacles: ObstacleRegistry,
    heroesProvider: () => Hero[],
    heightAt: (x: number, z: number) => number = () => 0,
  ) {
    this._obstacles = obstacles;
    this._heroesProvider = heroesProvider;
    this._heightAt = heightAt;
    this.mesh = this._buildMesh();
    this.mesh.visible = false;
  }

  get state(): ProjectileState { return this._state; }
  get damage(): number { return this._damage; }
  get position(): THREE.Vector3 { return this.mesh.position; }

  spawn(config: ProjectileConfig): void {
    this.mesh.position.copy(config.position);
    this._direction.copy(config.direction).normalize();
    this._speed = config.speed;
    this._maxRange = config.maxRange;
    this._damage = config.damage;
    this._owner = config.owner;
    this._traveled = 0;
    this._state = 'flying';
    this.mesh.visible = true;

    // Flight is flat (2D gameplay), so orientation is yaw-only. The shaft and
    // head keep their build-time X-rotations that lay them along local +Z.
    this.mesh.rotation.y = Math.atan2(this._direction.x, this._direction.z);
  }

  despawn(): void {
    this._state = 'dead';
    this.mesh.visible = false;
  }

  /** Advance the projectile. Returns detailed result for hit handling. */
  update(delta: number): ProjectileResult {
    if (this._state !== 'flying') return { status: 'dead', reason: 'range' };

    const step = this._speed * delta;
    this._traveled += step;

    // Max range
    if (this._traveled >= this._maxRange) {
      this.despawn();
      return { status: 'dead', reason: 'range' };
    }

    const movement = this._direction.clone().multiplyScalar(step);
    this.mesh.position.add(movement);

    // Ride at a fixed height above the terrain — arrows fly OVER hills and
    // never collide with slopes (WC3-style constant fly-height). Y is visual;
    // all collision below is 2D on the XZ plane.
    this.mesh.position.y =
      this._heightAt(this.mesh.position.x, this.mesh.position.z) +
      Projectile.FLY_HEIGHT;

    // Obstacle collision (rocks/trees are ground features)
    if (this._obstacles.sphereCast(this.mesh.position, this._collisionRadius)) {
      this.despawn();
      return { status: 'dead', reason: 'obstacle' };
    }

    // Hero collision
    const hero = this._checkHeroCollision();
    if (hero) {
      this.despawn();
      return { status: 'hit', hero, source: this._owner! };
    }

    return { status: 'flying' };
  }

  private _checkHeroCollision(): Hero | null {
    const heroes = this._heroesProvider();
    for (const hero of heroes) {
      // Skip the shooter
      if (hero === this._owner) continue;
      if (!hero.isAlive || hero.isInvulnerable) continue;

      // 2D hit test — height is ignored (gameplay is on the XZ plane).
      const dx = this.mesh.position.x - hero.position.x;
      const dz = this.mesh.position.z - hero.position.z;
      const distSq = dx * dx + dz * dz;
      const hitRadius = hero.bodyRadius + this._collisionRadius;

      if (distSq < hitRadius * hitRadius) {
        return hero;
      }
    }
    return null;
  }

  // ── Mesh ──────────────────────────────────────────────────────

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
    group.add(light);

    return group;
  }
}
