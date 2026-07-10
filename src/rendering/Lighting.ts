import * as THREE from 'three';

export function createLighting(scene: THREE.Scene): void {
  // Ambient — fills shadows so they are never completely black
  const ambient = new THREE.AmbientLight(0x8899aa, 0.6);
  scene.add(ambient);

  // Main directional light (sun)
  const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
  sun.position.set(50, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.camera.left = -50;
  sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50;
  sun.shadow.camera.bottom = -50;
  sun.shadow.bias = -0.0001;
  scene.add(sun);

  // Hemisphere light — sky/ground gradient for outdoor feel
  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x556b2f, 0.4);
  scene.add(hemi);
}
