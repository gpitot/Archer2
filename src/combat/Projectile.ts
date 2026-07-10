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
  | { status: 'hit'; hero: Hero };

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
  private _owner: Hero | null = null;
  private _collisionRadius = 0.4;

  private _trail: THREE.Mesh;

  constructor(obstacles: ObstacleRegistry, heroesProvider: () => Hero[]) {
    this._obstacles = obstacles;
    this._heroesProvider = heroesProvider;
    this.mesh = this._buildMesh();
    this._trail = this.mesh.getObjectByName('arrowTrail') as THREE.Mesh;
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

    const angle = Math.atan2(this._direction.x, this._direction.z);
    this.mesh.rotation.y = angle;
    const pitch = -Math.asin(this._direction.y);
    this._trail.rotation.x = pitch;
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

    // Obstacle collision
    if (this._obstacles.sphereCast(this.mesh.position, this._collisionRadius)) {
      this.despawn();
      return { status: 'dead', reason: 'obstacle' };
    }

    // Hero collision
    const hero = this._checkHeroCollision();
    if (hero) {
      this.despawn();
      return { status: 'hit', hero };
    }

    // Keep above ground
    if (this.mesh.position.y < 0.3) {
      this.mesh.position.y = 0.3;
    }

    return { status: 'flying' };
  }

  private _checkHeroCollision(): Hero | null {
    const heroes = this._heroesProvider();
    for (const hero of heroes) {
      // Skip the shooter
      if (hero === this._owner) continue;
      if (!hero.isAlive || hero.isInvulnerable) continue;

      // Simple cylinder check
      const dx = this.mesh.position.x - hero.position.x;
      const dz = this.mesh.position.z - hero.position.z;
      const dy = Math.abs(this.mesh.position.y - hero.position.y);
      // Hero height is ~1.9 * scale (body 1.4 + head 0.7). Allow generous Y window.
      if (dy > hero.scale * 2.0) continue;
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

    const shaftGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.2, 6);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0xddcc88, roughness: 0.3, emissive: 0x331100,
    });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.z = 0.6;
    shaft.rotation.x = Math.PI / 2;
    shaft.name = 'arrowTrail';
    group.add(shaft);

    const headGeo = new THREE.ConeGeometry(0.1, 0.35, 6);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xcccccc, roughness: 0.2, metalness: 0.8, emissive: 0x111111,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.z = 1.3;
    head.rotation.x = Math.PI / 2;
    group.add(head);

    const light = new THREE.PointLight(0xffaa44, 3, 3);
    light.position.z = 0.6;
    group.add(light);

    return group;
  }
}
