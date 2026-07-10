import * as THREE from 'three';
import { HeightMap } from './HeightMap';
import { generateTerrainHeight } from './TerrainGenerator';

/**
 * Creates the full arena terrain: heightmap mesh + debug grid overlay.
 */
export function createTerrain(heightMap: HeightMap): THREE.Group {
  const group = new THREE.Group();

  // Generate height data
  heightMap.generate(generateTerrainHeight);

  // Terrain mesh with vertex colors
  group.add(heightMap.createMesh());

  // Debug grid (wireframe overlay at y=0 for reference)
  const gridGeo = new THREE.PlaneGeometry(
    heightMap.width * heightMap.cellSize,
    heightMap.depth * heightMap.cellSize,
    heightMap.width,
    heightMap.depth,
  );
  const gridMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    wireframe: true,
    transparent: true,
    opacity: 0.06,
    depthTest: true,
  });
  const grid = new THREE.Mesh(gridGeo, gridMat);
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = 0.02;
  grid.name = 'grid';
  group.add(grid);

  return group;
}
