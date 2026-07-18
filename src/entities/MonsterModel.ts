/**
 * Shared loader for the jungle-monster models (Quaternius "Ultimate Monsters",
 * CC0). One rigged glTF per creep type; each is fetched and parsed once, then
 * every creep instance gets its own deep clone (SkeletonUtils.clone for a fresh
 * skeleton) with per-instance materials so hit-flashes don't leak between
 * creeps — the same pattern as `RangerModel`.
 *
 * Models arrive at wildly different native scales, so each instance is
 * uniformly scaled to a per-type target world height (`worldHeight`) measured
 * from its own bind-pose bounding box. The `clips` config maps our five
 * gameplay animation slots onto each pack's clip names (Blob/Big/Flying packs
 * name them differently), tried in order so a missing name falls through.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CreepTypeId } from '../sim/creepRules';

import mushnubUrl from '../../assets/models/monsters/Mushnub.gltf?url';
import cactoroUrl from '../../assets/models/monsters/Cactoro.gltf?url';
import orcUrl from '../../assets/models/monsters/Orc.gltf?url';
import dinoUrl from '../../assets/models/monsters/Dino.gltf?url';
import yetiUrl from '../../assets/models/monsters/Yeti.gltf?url';
import ghostUrl from '../../assets/models/monsters/Ghost.gltf?url';
import dragonUrl from '../../assets/models/monsters/Dragon.gltf?url';

/** Candidate clip names per gameplay slot, tried first-match. */
export interface MonsterClips {
  idle: string[];
  move: string[];
  attack: string[];
  death: string[];
  hit: string[];
}

export interface MonsterModelConfig {
  url: string;
  /** Uniform target height in world units (models are auto-fit to this). */
  worldHeight: number;
  clips: MonsterClips;
  /** World units to float above the ground (flyers hover). */
  hover?: number;
  /** Yaw offset (radians) if the model's forward axis isn't +Z. */
  yaw?: number;
}

// Big/Blob packs walk on the ground; the Flying pack hovers and has its own
// clip names (Flying_Idle / Fast_Flying, no Walk).
const GROUND_CLIPS: MonsterClips = {
  idle: ['Idle'],
  move: ['Walk', 'Run'],
  attack: ['Punch', 'Bite_Front', 'Headbutt'],
  death: ['Death'],
  hit: ['HitReact', 'HitRecieve', 'HitReceive'],
};

const FLYING_CLIPS: MonsterClips = {
  idle: ['Flying_Idle', 'Idle'],
  move: ['Fast_Flying', 'Flying_Idle'],
  attack: ['Headbutt', 'Punch'],
  death: ['Death'],
  hit: ['HitReact', 'HitRecieve'],
};

export const MONSTER_MODELS: Record<CreepTypeId, MonsterModelConfig> = {
  ghoul: { url: mushnubUrl, worldHeight: 62, clips: GROUND_CLIPS },
  cactoro: { url: cactoroUrl, worldHeight: 78, clips: GROUND_CLIPS },
  orc: { url: orcUrl, worldHeight: 94, clips: GROUND_CLIPS },
  dino: { url: dinoUrl, worldHeight: 104, clips: GROUND_CLIPS },
  yeti: { url: yetiUrl, worldHeight: 124, clips: GROUND_CLIPS },
  ghost: { url: ghostUrl, worldHeight: 82, clips: FLYING_CLIPS, hover: 30 },
  dragon: { url: dragonUrl, worldHeight: 96, clips: FLYING_CLIPS, hover: 34 },
};

export interface MonsterInstance {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** Per-instance material clones (for emissive hit flashes). */
  materials: THREE.MeshStandardMaterial[];
  config: MonsterModelConfig;
}

const _loader = new GLTFLoader();
const _baseCache = new Map<string, Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[] }>>();

function loadBase(url: string) {
  let p = _baseCache.get(url);
  if (!p) {
    p = _loader.loadAsync(url).then((gltf) => ({ scene: gltf.scene, clips: gltf.animations }));
    _baseCache.set(url, p);
  }
  return p;
}

/** First clip in `candidates` that exists in `clips`, or null. */
export function pickClip(clips: THREE.AnimationClip[], candidates: string[]): THREE.AnimationClip | null {
  for (const name of candidates) {
    const c = THREE.AnimationClip.findByName(clips, name);
    if (c) return c;
  }
  return null;
}

export async function createMonsterInstance(type: CreepTypeId): Promise<MonsterInstance> {
  const config = MONSTER_MODELS[type];
  const base = await loadBase(config.url);
  const scene = cloneSkinned(base.scene) as THREE.Group;

  // Rebuild materials as lit MeshStandardMaterials (the source is authored
  // unlit) so creeps receive scene lighting and can flash. Dedupe by source
  // material name so shared textures aren't converted repeatedly.
  const byName = new Map<string, THREE.MeshStandardMaterial>();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const src = mesh.material as THREE.MeshStandardMaterial & { map?: THREE.Texture };
    let converted = byName.get(src.name);
    if (!converted) {
      converted = new THREE.MeshStandardMaterial({
        name: src.name,
        map: src.map ?? null,
        color: (src.color ?? new THREE.Color(0xffffff)).clone(),
        roughness: 0.85,
        metalness: 0,
        flatShading: true,
      });
      byName.set(src.name, converted);
    }
    mesh.material = converted;
  });

  // Auto-fit: uniformly scale so the model stands `worldHeight` units tall.
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const nativeHeight = Math.max(size.y, 1e-3);
  scene.scale.setScalar(config.worldHeight / nativeHeight);

  return { scene, clips: base.clips, materials: [...byName.values()], config };
}
