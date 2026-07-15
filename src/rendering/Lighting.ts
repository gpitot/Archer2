import * as THREE from 'three';

export function createLighting(scene: THREE.Scene): void {
  // Cool sky / mossy ground hemisphere — moody Ashenvale ambience.
  const hemi = new THREE.HemisphereLight(0x9db8dc, 0x3d4a30, 1.1);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);

  // Warm key light from the south-west so cliff walls and canopies get
  // readable directional shading.
  const dir = new THREE.DirectionalLight(0xffe0b0, 1.9);
  dir.position.set(-900, 1500, 700);
  scene.add(dir);
}
