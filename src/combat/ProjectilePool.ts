import * as THREE from 'three';
import { Projectile, ProjectileConfig } from './Projectile';
import { ObstacleRegistry } from '../world/ObstacleRegistry';
import { FloatingTextManager } from '../ui/FloatingText';
import { Hero } from '../entities/Hero';

/**
 * Object pool for Projectile instances.
 * Pre-allocates projectiles and recycles them.
 */
export class ProjectilePool {
  private _pool: Projectile[] = [];
  private _active: Projectile[] = [];
  private _group = new THREE.Group();
  private _floatingText: FloatingTextManager;

  constructor(
    size: number,
    obstacles: ObstacleRegistry,
    heroesProvider: () => Hero[],
    floatingText: FloatingTextManager,
    heightAt: (x: number, z: number) => number = () => 0,
  ) {
    this._floatingText = floatingText;
    for (let i = 0; i < size; i++) {
      const p = new Projectile(obstacles, heroesProvider, heightAt);
      this._group.add(p.mesh);
      this._pool.push(p);
    }
  }

  get group(): THREE.Group { return this._group; }
  get active(): readonly Projectile[] { return this._active; }

  fire(config: ProjectileConfig): Projectile | null {
    const p = this._pool.pop();
    if (!p) return null;
    p.spawn(config);
    this._active.push(p);
    return p;
  }

  /**
   * Update all active projectiles. On hero hit, applies damage and despawns.
   */
  update(delta: number): void {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const p = this._active[i];
      const result = p.update(delta);

      if (result.status === 'flying') continue;

      // Remove from active
      this._active.splice(i, 1);
      this._pool.push(p);

      // Apply damage on hero hit
      if (result.status === 'hit') {
        result.hero.takeDamage(result.source, p.damage);
        this._floatingText.spawn(result.hero.position, p.damage);
      }
    }
  }
}
