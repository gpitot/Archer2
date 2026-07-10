import * as THREE from 'three';

export interface ObstacleBounds {
  center: THREE.Vector3;   // world center
  halfExtents: THREE.Vector3; // half-width (x), half-height (y), half-depth (z)
}

/**
 * Registry of obstacle bounding boxes used for projectile collision.
 * Populated when obstacles are created.
 */
export class ObstacleRegistry {
  private _obstacles: ObstacleBounds[] = [];

  register(center: THREE.Vector3, halfWidth: number, height: number, halfDepth: number): void {
    this._obstacles.push({
      center: center.clone(),
      halfExtents: new THREE.Vector3(halfWidth, height / 2, halfDepth),
    });
  }

  /** All registered obstacles (read-only). */
  get obstacles(): readonly ObstacleBounds[] {
    return this._obstacles;
  }

  /**
   * Check if a sphere at `pos` with `radius` intersects any obstacle.
   * Returns the first hit obstacle or null.
   */
  sphereCast(pos: THREE.Vector3, radius: number): ObstacleBounds | null {
    for (const obs of this._obstacles) {
      // AABB vs sphere test
      const closest = new THREE.Vector3(
        Math.max(obs.center.x - obs.halfExtents.x, Math.min(pos.x, obs.center.x + obs.halfExtents.x)),
        Math.max(obs.center.y - obs.halfExtents.y, Math.min(pos.y, obs.center.y + obs.halfExtents.y)),
        Math.max(obs.center.z - obs.halfExtents.z, Math.min(pos.z, obs.center.z + obs.halfExtents.z)),
      );
      const distSq = closest.distanceToSquared(pos);
      if (distSq < radius * radius) {
        return obs;
      }
    }
    return null;
  }
}
