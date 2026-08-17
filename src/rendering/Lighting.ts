import * as THREE from 'three';

/**
 * Scene lighting — and the one hard rule about it.
 *
 * INVARIANT: **the set of lights that can render is fixed at scene build.**
 *
 * The scene is forward-rendered with MeshStandardMaterial almost everywhere.
 * That means two things:
 *
 *  1. Every light that can reach a fragment is evaluated *per fragment*, and
 *     the terrain fills the screen. Each extra light is a full PBR loop over
 *     every pixel.
 *  2. three.js bakes the light counts into `NUM_POINT_LIGHTS` &c. as shader
 *     defines. Adding, removing, or hiding a light changes those counts, which
 *     invalidates the program cache and **recompiles every standard material
 *     in the scene** — a multi-frame stall, in the middle of whatever caused
 *     it. Arrows carrying point lights hitched on every volley for exactly
 *     this reason.
 *
 * So: never `scene.add`/`remove` a light after startup, and never toggle a
 * light's `.visible`. Animating `.intensity`, `.color`, or `.position` on a
 * light that is already in the scene is free — do that instead.
 *
 * For per-entity glows (arrows, runes, muzzle flashes), use the fake decal in
 * `GroundGlow.ts`: an additive quad on the ground reads the same from this
 * camera for one cheap draw call and no shader churn.
 *
 * The only conditional light in the codebase is the fountain's, and it is
 * decided once at construction from the quality tier — fountains are placed at
 * map load and never spawn or despawn, so the count still never moves.
 */
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
