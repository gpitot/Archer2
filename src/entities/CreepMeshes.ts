/**
 * Low-poly jungle creep meshes (ghoul, dragon), built in world units.
 *
 * Unlike `ArcherMesh` (unique geometries + materials per hero, fine for ≤8
 * heroes), creeps are always present, so geometries and static materials are
 * built ONCE per type in a module cache and shared by every instance. Only
 * the body material is cloned per creep — it carries the per-instance hit
 * flash. No lights: dynamic lights per always-on unit would dominate the
 * frame cost.
 */
import * as THREE from 'three';
import { CreepTypeId } from '../sim/creepRules';

interface CreepAssets {
  geometries: Record<string, THREE.BufferGeometry>;
  /** Shared static materials (never mutated per instance). */
  materials: Record<string, THREE.MeshStandardMaterial>;
  /** Template for the per-instance (flashable) body material. */
  bodyMaterial: THREE.MeshStandardMaterial;
}

const _cache = new Map<CreepTypeId, CreepAssets>();

function mat(color: number, rough = 0.8): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true });
}

function getAssets(type: CreepTypeId): CreepAssets {
  let assets = _cache.get(type);
  if (!assets) {
    assets = type === 'ghoul' ? buildGhoulAssets() : buildDragonAssets();
    _cache.set(type, assets);
  }
  return assets;
}

function buildGhoulAssets(): CreepAssets {
  return {
    geometries: {
      body: new THREE.SphereGeometry(16, 10, 8),
      head: new THREE.SphereGeometry(8, 8, 6),
      arm: new THREE.BoxGeometry(5, 26, 5),
      leg: new THREE.BoxGeometry(6, 16, 6),
    },
    materials: {
      limb: mat(0x5a6a42),
      head: mat(0x8a9a6a),
    },
    bodyMaterial: mat(0x7a8a5a), // sickly green — clearly not a player color
  };
}

function buildDragonAssets(): CreepAssets {
  return {
    geometries: {
      body: new THREE.SphereGeometry(20, 10, 8),
      head: new THREE.ConeGeometry(9, 24, 8),
      wing: new THREE.BoxGeometry(34, 2, 16),
      tail: new THREE.ConeGeometry(6, 28, 6),
    },
    materials: {
      wing: mat(0x7a2a20),
      head: mat(0xb04a32),
    },
    bodyMaterial: mat(0xa03a2a), // dull red
  };
}

/**
 * Build one creep instance. Geometries and static materials are shared; the
 * returned group's `creepBody` mesh carries a cloned material for hit
 * flashes. Named nodes (`armL`/`armR` or `wingL`/`wingR`) are animation
 * pivots for CreepView.
 */
export function buildCreepMesh(type: CreepTypeId): THREE.Group {
  const a = getAssets(type);
  const root = new THREE.Group();
  const bodyMat = a.bodyMaterial.clone();

  if (type === 'ghoul') {
    const body = new THREE.Mesh(a.geometries.body, bodyMat);
    body.name = 'creepBody';
    body.position.y = 30;
    body.scale.set(0.9, 1.25, 0.8);
    body.rotation.x = 0.35; // hunched forward
    body.castShadow = true;
    root.add(body);

    const head = new THREE.Mesh(a.geometries.head, a.materials.head);
    head.position.set(0, 46, 10);
    head.castShadow = true;
    root.add(head);

    for (const side of [-1, 1] as const) {
      const arm = new THREE.Group();
      arm.name = side === -1 ? 'armL' : 'armR';
      arm.position.set(side * 14, 40, 6);
      const armMesh = new THREE.Mesh(a.geometries.arm, a.materials.limb);
      armMesh.position.y = -12; // hang from the shoulder pivot
      armMesh.castShadow = true;
      arm.add(armMesh);
      arm.rotation.x = 0.5; // claws reach forward
      root.add(arm);

      const leg = new THREE.Group();
      leg.name = side === -1 ? 'legL' : 'legR';
      leg.position.set(side * 7, 16, 0);
      const legMesh = new THREE.Mesh(a.geometries.leg, a.materials.limb);
      legMesh.position.y = -8;
      legMesh.castShadow = true;
      leg.add(legMesh);
      root.add(leg);
    }
  } else {
    const body = new THREE.Mesh(a.geometries.body, bodyMat);
    body.name = 'creepBody';
    body.position.y = 34;
    body.scale.set(0.85, 0.8, 1.3);
    body.castShadow = true;
    root.add(body);

    const head = new THREE.Mesh(a.geometries.head, a.materials.head);
    head.position.set(0, 40, 30);
    head.rotation.x = Math.PI / 2; // cone points forward (+z = facing)
    head.castShadow = true;
    root.add(head);

    const tail = new THREE.Mesh(a.geometries.tail, a.materials.wing);
    tail.position.set(0, 34, -30);
    tail.rotation.x = -Math.PI / 2;
    root.add(tail);

    for (const side of [-1, 1] as const) {
      const wing = new THREE.Group();
      wing.name = side === -1 ? 'wingL' : 'wingR';
      wing.position.set(side * 12, 42, 0);
      const wingMesh = new THREE.Mesh(a.geometries.wing, a.materials.wing);
      wingMesh.position.x = side * 17; // extend outward from the shoulder pivot
      wingMesh.castShadow = true;
      wing.add(wingMesh);
      root.add(wing);
    }
  }

  return root;
}
