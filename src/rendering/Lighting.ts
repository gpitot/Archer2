import * as THREE from 'three';

export function createLighting(scene: THREE.Scene): void {
  // Sky/ground hemisphere fill so slopes read even in shade.
  const hemi = new THREE.HemisphereLight(0xbdd7ff, 0x4a5a38, 0.7);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(ambient);

  // Key light from the NW, angled so hills cast readable shading.
  const dir = new THREE.DirectionalLight(0xfff2d8, 0.9);
  dir.position.set(-800, 1400, 600);
  scene.add(dir);
}
