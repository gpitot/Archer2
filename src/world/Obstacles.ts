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
  { x: 100, z: 100, halfWidth: 60, halfDepth: 40, height: 40, color: 0x888888 },
  { x: -60, z: -80, halfWidth: 40, halfDepth: 40, height: 30, color: 0x777777 },
  { x: -120, z: 120, halfWidth: 40, halfDepth: 60, height: 50, color: 0x999999 },
  { x: 240, z: 60, halfWidth: 12, halfDepth: 12, height: 60, color: 0x2d5a27 },
  { x: 300, z: -40, halfWidth: 12, halfDepth: 12, height: 70, color: 0x2d5a27 },
  { x: -200, z: 160, halfWidth: 12, halfDepth: 12, height: 60, color: 0x2d5a27 },
  { x: -240, z: -120, halfWidth: 12, halfDepth: 12, height: 80, color: 0x2d5a27 },
  { x: 160, z: -200, halfWidth: 12, halfDepth: 12, height: 60, color: 0x2d5a27 },
  { x: -100, z: -240, halfWidth: 12, halfDepth: 12, height: 70, color: 0x2d5a27 },
  { x: 360, z: 240, halfWidth: 40, halfDepth: 40, height: 36, color: 0x8a8a8a },
  { x: -300, z: 300, halfWidth: 50, halfDepth: 40, height: 40, color: 0x7a7a7a },
  { x: 200, z: -360, halfWidth: 30, halfDepth: 60, height: 30, color: 0x888880 },
  { x: -360, z: -200, halfWidth: 40, halfDepth: 40, height: 44, color: 0x8a8a8a },
];

export function createObstacles(
  defs: ObstacleDef[],
  navGrid: NavGrid,
  registry: ObstacleRegistry,
  heightAt: (x: number, z: number) => number = () => 0,
): THREE.Group {
  const group = new THREE.Group();

  for (const def of defs) {
    const groundY = heightAt(def.x, def.z);
    const mesh = createObstacleMesh(def, groundY);
    group.add(mesh);

    navGrid.blockRegion(def.x, def.z, def.halfWidth, def.halfDepth);

    registry.register(
      new THREE.Vector3(def.x, groundY + def.height / 2, def.z),
      def.halfWidth,
      def.height,
      def.halfDepth,
    );
  }

  return group;
}

function createObstacleMesh(def: ObstacleDef, groundY = 0): THREE.Group {
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

  group.position.set(def.x, groundY, def.z);
  return group;
}
