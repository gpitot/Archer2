import * as THREE from 'three';
import type { StatLine } from '../ui/Tooltip';

/** One purchasable item in a shop (display fields only; buy logic lives in the sim). */
export interface ShopItem {
  id: string;
  name: string;
  cost: number;
  description: string;
  /** Stat rows (bonuses, cooldowns, …) shown on the shop card. */
  stats?: readonly StatLine[];
  /** Stackable items (e.g. ward charges) can be re-bought while owned. */
  stackable?: boolean;
}

/**
 * A shop building in the world — rendering only. Buy validation and item
 * application are handled by the authoritative simulation (`stepMatch`).
 */
export class Shop {
  readonly mesh: THREE.Group;
  readonly position: THREE.Vector3;
  readonly items: ShopItem[];
  readonly interactRadius = 180;

  constructor(position: THREE.Vector3, items: ShopItem[]) {
    this.position = position.clone();
    this.items = items;
    this.mesh = this._buildMesh();
    this.mesh.position.copy(position);
  }

  private _buildMesh(): THREE.Group {
    const g = new THREE.Group();

    // Base — stone floor
    const baseGeo = new THREE.CylinderGeometry(80, 80, 20, 8);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.9 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 10;
    g.add(base);

    // Pillar
    const pillarGeo = new THREE.CylinderGeometry(20, 25, 120, 8);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xaa9966, roughness: 0.5 });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.y = 70;
    g.add(pillar);

    // Roof
    const roofGeo = new THREE.ConeGeometry(70, 40, 8);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x884422, roughness: 0.7 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = 140;
    g.add(roof);

    // Gold glow ring at base
    const ringGeo = new THREE.TorusGeometry(70, 7.5, 8, 24);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xffcc44, roughness: 0.3, emissive: 0x332200, emissiveIntensity: 0.5 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 22.5;
    g.add(ring);

    return g;
  }
}
