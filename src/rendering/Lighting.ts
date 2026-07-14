import * as THREE from 'three';

export function createLighting(scene: THREE.Scene): void {
  const ambient = new THREE.AmbientLight(0xccddff, 0.8);
  scene.add(ambient);

  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(20, 40, 10);
  scene.add(dir);
}
