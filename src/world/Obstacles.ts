import * as THREE from 'three';
import { NavGrid } from '../navigation/NavGrid';
import { ObstacleRegistry } from './ObstacleRegistry';
import { HeightMap } from './HeightMap';

export interface ObstacleDef {
  x: number;
  z: number;
  halfWidth: number;  // X extent
  halfDepth: number;  // Z extent
  height: number;
  color: number;
}

/**
 * Default obstacle layout for the test arena.
 */
export const DEFAULT_OBSTACLES: ObstacleDef[] = [
  // Central rock cluster
  { x: 5, z: 5, halfWidth: 3, halfDepth: 2, height: 2, color: 0x888888 },
  { x: -3, z: -4, halfWidth: 2, halfDepth: 2, height: 1.5, color: 0x777777 },
  { x: -6, z: 6, halfWidth: 2, halfDepth: 3, height: 2.5, color: 0x999999 },

  // Trees (tall thin cylinders)
  { x: 12, z: 3, halfWidth: 0.6, halfDepth: 0.6, height: 3, color: 0x2d5a27 },
  { x: 15, z: -2, halfWidth: 0.6, halfDepth: 0.6, height: 3.5, color: 0x2d5a27 },
  { x: -10, z: 8, halfWidth: 0.6, halfDepth: 0.6, height: 3, color: 0x2d5a27 },
  { x: -12, z: -6, halfWidth: 0.6, halfDepth: 0.6, height: 4, color: 0x2d5a27 },
  { x: 8, z: -10, halfWidth: 0.6, halfDepth: 0.6, height: 3, color: 0x2d5a27 },
  { x: -5, z: -12, halfWidth: 0.6, halfDepth: 0.6, height: 3.5, color: 0x2d5a27 },

  // More rocks
  { x: 18, z: 12, halfWidth: 2, halfDepth: 2, height: 1.8, color: 0x8a8a8a },
  { x: -15, z: 15, halfWidth: 2.5, halfDepth: 2, height: 2, color: 0x7a7a7a },
  { x: 10, z: -18, halfWidth: 1.5, halfDepth: 3, height: 1.5, color: 0x888880 },
  { x: -18, z: -10, halfWidth: 2, halfDepth: 2, height: 2.2, color: 0x8a8a8a },
];

/**
 * Creates 3D obstacle meshes and registers them as blocked cells in the NavGrid.
 * Returns a group containing all obstacle meshes.
 */
export function createObstacles(
  defs: ObstacleDef[],
  navGrid: NavGrid,
  registry: ObstacleRegistry,
  heightMap?: HeightMap,
): THREE.Group {
  const group = new THREE.Group();

  for (const def of defs) {
    const terrainY = heightMap?.getHeightAt(def.x, def.z) ?? 0;
    const mesh = createObstacleMesh(def, terrainY);
    group.add(mesh);

    // Block the corresponding nav grid cells
    navGrid.blockRegion(def.x, def.z, def.halfWidth, def.halfDepth);

    // Register for projectile collision (at terrain height)
    registry.register(
      new THREE.Vector3(def.x, terrainY + def.height / 2, def.z),
      def.halfWidth,
      def.height,
      def.halfDepth,
    );
  }

  return group;
}

function createObstacleMesh(def: ObstacleDef, terrainY: number): THREE.Group {
  const group = new THREE.Group();

  if (def.halfWidth === def.halfDepth && def.height > 2) {
    // Tall, narrow — treat as tree (cylinder trunk + sphere canopy)
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.4, def.height * 0.6, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = def.height * 0.3;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    group.add(trunk);

    const canopyGeo = new THREE.SphereGeometry(def.halfWidth * 1.2, 8, 6);
    const canopyMat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.8 });
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    canopy.position.y = def.height * 0.7;
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    group.add(canopy);
  } else {
    // Rock — box geometry
    const geo = new THREE.BoxGeometry(def.halfWidth * 2, def.height, def.halfDepth * 2);
    const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = def.height / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  group.position.set(def.x, terrainY, def.z);
  return group;
}
