import * as THREE from 'three';

export interface ObstacleBounds {
  center: THREE.Vector3;   // world center
  halfExtents: THREE.Vector3; // half-width (x), half-height (y), half-depth (z)
}

const BUCKET_SIZE = 256; // world units per spatial-hash bucket

/**
 * Registry of obstacle bounding boxes used for projectile collision.
 *
 * Backed by a spatial hash on XZ so `sphereCast` stays O(1) with thousands
 * of registered obstacles (the original map places ~4k solid doodads).
 */
export class ObstacleRegistry {
  private _obstacles: ObstacleBounds[] = [];
  private _buckets = new Map<number, number[]>();

  register(center: THREE.Vector3, halfWidth: number, height: number, halfDepth: number): void {
    const bounds: ObstacleBounds = {
      center: center.clone(),
      halfExtents: new THREE.Vector3(halfWidth, height / 2, halfDepth),
    };
    const index = this._obstacles.length;
    this._obstacles.push(bounds);

    const minBX = Math.floor((center.x - halfWidth) / BUCKET_SIZE);
    const maxBX = Math.floor((center.x + halfWidth) / BUCKET_SIZE);
    const minBZ = Math.floor((center.z - halfDepth) / BUCKET_SIZE);
    const maxBZ = Math.floor((center.z + halfDepth) / BUCKET_SIZE);
    for (let bz = minBZ; bz <= maxBZ; bz++) {
      for (let bx = minBX; bx <= maxBX; bx++) {
        const key = this._key(bx, bz);
        let bucket = this._buckets.get(key);
        if (!bucket) {
          bucket = [];
          this._buckets.set(key, bucket);
        }
        bucket.push(index);
      }
    }
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
    const minBX = Math.floor((pos.x - radius) / BUCKET_SIZE);
    const maxBX = Math.floor((pos.x + radius) / BUCKET_SIZE);
    const minBZ = Math.floor((pos.z - radius) / BUCKET_SIZE);
    const maxBZ = Math.floor((pos.z + radius) / BUCKET_SIZE);
    const r2 = radius * radius;

    for (let bz = minBZ; bz <= maxBZ; bz++) {
      for (let bx = minBX; bx <= maxBX; bx++) {
        const bucket = this._buckets.get(this._key(bx, bz));
        if (!bucket) continue;
        for (const i of bucket) {
          const obs = this._obstacles[i];
          // AABB vs sphere test
          const cx = Math.max(obs.center.x - obs.halfExtents.x, Math.min(pos.x, obs.center.x + obs.halfExtents.x));
          const cy = Math.max(obs.center.y - obs.halfExtents.y, Math.min(pos.y, obs.center.y + obs.halfExtents.y));
          const cz = Math.max(obs.center.z - obs.halfExtents.z, Math.min(pos.z, obs.center.z + obs.halfExtents.z));
          const dx = cx - pos.x;
          const dy = cy - pos.y;
          const dz = cz - pos.z;
          if (dx * dx + dy * dy + dz * dz < r2) {
            return obs;
          }
        }
      }
    }
    return null;
  }

  private _key(bx: number, bz: number): number {
    // Offset to keep both components positive; maps are < 2^12 buckets wide.
    return (bx + 2048) * 4096 + (bz + 2048);
  }
}
