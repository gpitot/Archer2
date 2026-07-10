import * as THREE from 'three';

export function createScene(): THREE.Scene {
  const scene = new THREE.Scene();

  // Sky-like background colour
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 50, 200);

  return scene;
}
