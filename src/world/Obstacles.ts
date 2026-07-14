import * as THREE from 'three';
import { NavGrid } from '../navigation/NavGrid';
import { ObstacleRegistry } from './ObstacleRegistry';

export interface ObstacleDef {
  x: number;
  z: number;
  halfWidth: number;
  halfDepth: number;
  height: number;
  color: number;
}

export const DEFAULT_OBSTACLES: ObstacleDef[] = [
  { x: 5, z: 5, halfWidth: 3, halfDepth: 2, height: 2, color: 0x888888 },
  { x: -3, z: -4, halfWidth: 2, halfDepth: 2, height: 1.5, color: 0x777777 },
  { x: -6, z: 6, halfWidth: 2, halfDepth: 3, height: 2.5, color: 0x999999 },
  { x: 12, z: 3, halfWidth: 0.6, halfDepth: 0.6, height: 3, color: 0x2d5a27 },
  { x: 15, z: -2, halfWidth: 0.6, halfDepth: 0.6, height: 3.5, color: 0x2d5a27 },
  { x: -10, z: 8, halfWidth: 0.6, halfDepth: 0.6, height: 3, color: 0x2d5a27 },
  { x: -12, z: -6, halfWidth: 0.6, halfDepth: 0.6, height: 4, color: 0x2d5a27 },
  { x: 8, z: -10, halfWidth: 0.6, halfDepth: 0.6, height: 3, color: 0x2d5a27 },
  { x: -5, z: -12, halfWidth: 0.6, halfDepth: 0.6, height: 3.5, color: 0x2d5a27 },
  { x: 18, z: 12, halfWidth: 2, halfDepth: 2, height: 1.8, color: 0x8a8a8a },
  { x: -15, z: 15, halfWidth: 2.5, halfDepth: 2, height: 2, color: 0x7a7a7a },
  { x: 10, z: -18, halfWidth: 1.5, halfDepth: 3, height: 1.5, color: 0x888880 },
  { x: -18, z: -10, halfWidth: 2, halfDepth: 2, height: 2.2, color: 0x8a8a8a },
];

export function createObstacles(
  defs: ObstacleDef[],
  navGrid: NavGrid,
  registry: ObstacleRegistry,
): THREE.Group {
  const group = new THREE.Group();

  for (const def of defs) {
    const mesh = createObstacleMesh(def);
    group.add(mesh);

    navGrid.blockRegion(def.x, def.z, def.halfWidth, def.halfDepth);

    registry.register(
      new THREE.Vector3(def.x, def.height / 2, def.z),
      def.halfWidth,
      def.height,
      def.halfDepth,
    );
  }

  return group;
}

function createObstacleMesh(def: ObstacleDef): THREE.Group {
  const group = new THREE.Group();

  if (def.halfWidth === def.halfDepth && def.height > 2) {
    // Tree
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.4, def.height * 0.6, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = def.height * 0.3;
    group.add(trunk);

    const canopyGeo = new THREE.SphereGeometry(def.halfWidth * 1.2, 8, 6);
    const canopyMat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.8 });
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    canopy.position.y = def.height * 0.7;
    group.add(canopy);
  } else {
    // Rock
    const geo = new THREE.BoxGeometry(def.halfWidth * 2, def.height, def.halfDepth * 2);
    const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = def.height / 2;
    group.add(mesh);
  }

  group.position.set(def.x, 0, def.z);
  return group;
}
