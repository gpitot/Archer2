import * as THREE from 'three';

export function createScene(): THREE.Scene {
  const scene = new THREE.Scene();
  // Ashenvale mood: cool, slightly desaturated sky; fog scaled to the
  // full-size map so distant chunks fade instead of popping.
  scene.background = new THREE.Color(0x7b93b8);
  scene.fog = new THREE.Fog(0x7b93b8, 4500, 10000);
  return scene;
}
