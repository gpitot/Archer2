import * as THREE from 'three';

export function createScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb4d6); // daytime sky
  scene.fog = new THREE.Fog(0x8fb4d6, 3200, 6500);
  return scene;
}
