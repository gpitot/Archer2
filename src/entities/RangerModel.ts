/**
 * Shared loader for the ranger hero model (Quaternius "RPG Characters", CC0).
 *
 * The GLB is fetched and parsed once; each hero gets its own deep clone
 * (SkeletonUtils.clone so the skinned mesh gets a fresh skeleton) with
 * per-instance materials so tints/flashes don't leak between heroes.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import rangerUrl from '../../assets/models/ranger.glb?url';

export interface RangerInstance {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** Per-instance material clones, keyed by material name from the GLB. */
  materials: Map<string, THREE.MeshStandardMaterial>;
}

let basePromise: Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[] }> | null = null;

function loadBase() {
  basePromise ??= new GLTFLoader()
    .loadAsync(rangerUrl)
    .then((gltf) => ({ scene: gltf.scene, clips: gltf.animations }));
  return basePromise;
}

export async function createRangerInstance(): Promise<RangerInstance> {
  const base = await loadBase();
  const scene = cloneSkinned(base.scene) as THREE.Group;

  const materials = new Map<string, THREE.MeshStandardMaterial>();
  scene.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const src = mesh.material as THREE.MeshStandardMaterial;
    let cloned = materials.get(src.name);
    if (!cloned) {
      cloned = src.clone();
      materials.set(src.name, cloned);
    }
    mesh.material = cloned;
  });

  return { scene, clips: base.clips, materials };
}
