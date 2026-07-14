import * as THREE from 'three';

/** One purchasable item in a shop. */
export interface ShopItem {
  id: string;
  name: string;
  cost: number;
  description: string;
  /** Apply effect to buyer, return ownership data for inventory. */
  apply: (hero: import('../entities/Hero').Hero) => void;
}

/**
 * A shop building in the world. Heroes near it can buy items.
 */
export class Shop {
  readonly mesh: THREE.Group;
  readonly position: THREE.Vector3;
  readonly items: ShopItem[];
  readonly interactRadius = 120; // how close hero must be

  constructor(position: THREE.Vector3, items: ShopItem[]) {
    this.position = position.clone();
    this.items = items;
    this.mesh = this._buildMesh();
  }

  /** Check if a hero is in range to interact. */
  canInteract(heroPos: THREE.Vector3): boolean {
    return this.position.distanceTo(heroPos) <= this.interactRadius;
  }

  /** Try to buy an item. Returns the item if successful, null otherwise. */
  buy(hero: import('../entities/Hero').Hero, itemIndex: number): ShopItem | null {
    if (itemIndex < 0 || itemIndex >= this.items.length) return null;
    if (!this.canInteract(hero.position)) return null;
    const item = this.items[itemIndex];
    if (hero.gold < item.cost) return null;
    if (hero.hasItem(item.id)) return null; // already owned
    const slot = hero.addItem(item.id);
    if (slot === -1) return null; // inventory full
    hero.addGold(-item.cost);
    item.apply(hero);
    return item;
  }

  private _buildMesh(): THREE.Group {
    const g = new THREE.Group();

    // Base — stone floor
    const baseGeo = new THREE.CylinderGeometry(16, 16, 4, 8);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.9 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 2;
    g.add(base);

    // Pillar
    const pillarGeo = new THREE.CylinderGeometry(4, 5, 24, 8);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xaa9966, roughness: 0.5 });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.y = 14;
    g.add(pillar);

    // Roof
    const roofGeo = new THREE.ConeGeometry(14, 8, 8);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x884422, roughness: 0.7 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = 28;
    g.add(roof);

    // Gold glow ring at base
    const ringGeo = new THREE.TorusGeometry(14, 1.5, 8, 24);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xffcc44, roughness: 0.3, emissive: 0x332200, emissiveIntensity: 0.5 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 4.5;
    g.add(ring);

    g.position.copy(this.position);
    return g;
  }
}
