/**
 * Shared loader for the ranger hero model (Quaternius "RPG Characters", CC0).
 *
 * The GLB is fetched and parsed once; each hero gets its own deep clone
 * (SkeletonUtils.clone so the skinned mesh gets a fresh skeleton) with
 * per-instance materials so tints/flashes don't leak between heroes.
 *
 * The source asset is authored with KHR_materials_unlit, which GLTFLoader
 * maps to MeshBasicMaterial (no lighting, no emissive). We rebuild each
 * material as MeshStandardMaterial so the hero receives scene lighting and
 * supports the emissive hit/dodge flashes, like every other mesh in the game.
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
    const src = mesh.material as THREE.MeshBasicMaterial;
    let converted = materials.get(src.name);
    if (!converted) {
      converted = new THREE.MeshStandardMaterial({
        name: src.name,
        map: src.map,
        color: src.color.clone(),
        roughness: 0.9,
        metalness: 0,
      });
      materials.set(src.name, converted);
    }
    mesh.material = converted;
  });

  return { scene, clips: base.clips, materials };
}
