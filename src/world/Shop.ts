import * as THREE from 'three';
import type { StatLine } from '../ui/Tooltip';

/** One purchasable item in a shop (display fields only; buy logic lives in the sim). */
export interface ShopItem {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  cost: number;
  description: string;
  /** Stat rows (bonuses, cooldowns, …) shown on the shop card. */
  stats?: readonly StatLine[];
  /** Stackable items (e.g. ward charges) can be re-bought while owned. */
  stackable?: boolean;
  /** Consumed on purchase — never occupies an inventory slot. */
  consumable?: boolean;
}

/**
 * A shop building in the world — rendering only. Buy validation and item
 * application are handled by the authoritative simulation (`stepMatch`).
 */
export class Shop {
  readonly mesh: THREE.Group;
  readonly position: THREE.Vector3;
  readonly items: ShopItem[];
  readonly interactRadius = 85;

  constructor(position: THREE.Vector3, items: ShopItem[]) {
    this.position = position.clone();
    this.items = items;
    this.mesh = this._buildMesh();
    this.mesh.position.copy(position);
  }

  /**
   * A timber-framed medieval tavern, built from primitives: stone plinth,
   * whitewashed daub walls crossed by dark beams, a shingled gable roof, a
   * lit doorway, and a swinging sign out front. The building faces +Z.
   */
  private _buildMesh(): THREE.Group {
    const g = new THREE.Group();

    // ── Dimensions (walls are the reference; everything hangs off these) ──
    const W = 170;          // width  (X)
    const D = 130;          // depth  (Z)
    const PLINTH_H = 16;    // stone base height
    const WALL_H = 100;
    const EAVE = PLINTH_H + WALL_H;   // y of the wall top / roof eave
    const RISE = 70;                  // ridge height above the eave
    const RIDGE = EAVE + RISE;
    // The ridge runs front-to-back (along Z) so the gable end faces the
    // camera: from the game's fixed viewpoint the tavern reads as a house
    // with a peaked facade rather than a slab of roof.
    const SLOPE = Math.hypot(W / 2, RISE);
    const PITCH = Math.atan2(RISE, W / 2);

    const M = {
      stone: new THREE.MeshStandardMaterial({ color: 0x6b6355, roughness: 0.95 }),
      daub: new THREE.MeshStandardMaterial({ color: 0xd9cba6, roughness: 0.85 }),
      beam: new THREE.MeshStandardMaterial({ color: 0x4a3320, roughness: 0.8 }),
      shingle: new THREE.MeshStandardMaterial({ color: 0x5c3a26, roughness: 0.9 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.75 }),
      iron: new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.5, metalness: 0.6 }),
      lit: new THREE.MeshStandardMaterial({
        color: 0xffcc66, roughness: 0.4,
        emissive: 0xffa733, emissiveIntensity: 1.3,
      }),
      gold: new THREE.MeshStandardMaterial({
        color: 0xffcc44, roughness: 0.3,
        emissive: 0x553300, emissiveIntensity: 0.6,
      }),
    };

    /** Add an axis-aligned box; `rot` is an optional [x,y,z] rotation. */
    const box = (
      w: number, h: number, d: number,
      x: number, y: number, z: number,
      mat: THREE.Material,
      rot?: [number, number, number],
      parent: THREE.Object3D = g,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
      parent.add(m);
      return m;
    };

    // ── Stone plinth ──
    box(W + 16, PLINTH_H, D + 16, 0, PLINTH_H / 2, 0, M.stone);
    // Rough foundation stones peeking out along the front edge.
    for (let i = -2; i <= 2; i++) {
      box(26, 12, 14, i * 38, 6, D / 2 + 12, M.stone, [0, i * 0.12, 0]);
    }

    // ── Walls ──
    box(W, WALL_H, D, 0, PLINTH_H + WALL_H / 2, 0, M.daub);

    // ── Timber frame ──
    const wallMidY = PLINTH_H + WALL_H / 2;
    // Corner posts
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        box(14, WALL_H, 14, sx * (W / 2 - 5), wallMidY, sz * (D / 2 - 5), M.beam);
      }
    }
    // Sill, mid-rail and top plate on the long faces (front/back).
    for (const sz of [-1, 1]) {
      const z = sz * (D / 2 + 1);
      box(W, 10, 8, 0, PLINTH_H + 5, z, M.beam);
      box(W, 9, 8, 0, PLINTH_H + WALL_H * 0.55, z, M.beam);
      box(W + 8, 12, 8, 0, EAVE - 5, z, M.beam);
    }
    // Same on the gable ends (left/right).
    for (const sx of [-1, 1]) {
      const x = sx * (W / 2 + 1);
      box(8, 10, D, x, PLINTH_H + 5, 0, M.beam);
      box(8, 12, D + 8, x, EAVE - 5, 0, M.beam);
    }
    // Diagonal braces flanking the door — the tell-tale half-timber look.
    for (const sx of [-1, 1]) {
      box(58, 8, 6, sx * 56, PLINTH_H + WALL_H * 0.78, D / 2 + 1, M.beam, [0, 0, sx * 0.62]);
      box(58, 8, 6, sx * 56, PLINTH_H + WALL_H * 0.78, -D / 2 - 1, M.beam, [0, 0, sx * 0.62]);
    }
    // Vertical studs between the rails, front face.
    for (const x of [-30, 30]) {
      box(7, WALL_H * 0.45, 6, x, PLINTH_H + WALL_H * 0.775, D / 2 + 1, M.beam);
    }

    // ── Gable roof ──
    // One group per pitch, so slabs and shingle courses share the rotation.
    for (const sx of [-1, 1]) {
      const side = new THREE.Group();
      side.position.set(sx * (W / 4), (RIDGE + EAVE) / 2, 0);
      // Local +X runs down-slope from the ridge to this side's eave.
      side.rotation.z = -sx * PITCH;
      g.add(side);

      // The pitch itself, overhanging the walls on all sides.
      box(SLOPE + 16, 9, D + 26, 0, 0, 0, M.shingle, undefined, side);
      // Shingle courses — thin ledges proud of the slab.
      for (let i = -1; i <= 1; i++) {
        box(5, 5, D + 26, i * (SLOPE / 3.2), 6, 0, M.beam, undefined, side);
      }
      // Eave board along the bottom edge.
      box(6, 12, D + 26, sx * (SLOPE / 2 + 6), -3, 0, M.wood, undefined, side);
    }
    // Ridge beam capping the join.
    box(12, 10, D + 30, 0, RIDGE + 2, 0, M.wood);

    // ── Gable-end triangles filling the wall under each pitch ──
    const gable = new THREE.Shape();
    gable.moveTo(-W / 2, 0);
    gable.lineTo(W / 2, 0);
    gable.lineTo(0, RISE);
    gable.closePath();
    const gableGeo = new THREE.ShapeGeometry(gable);
    // Double-sided: the two ends face opposite ways, so one would be culled.
    const gableMat = new THREE.MeshStandardMaterial({
      color: 0xd9cba6, roughness: 0.85, side: THREE.DoubleSide,
    });
    for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(gableGeo, gableMat);
      m.position.set(0, EAVE, sz * (D / 2));
      g.add(m);
    }
    // Barge boards tracing the front gable's two rakes.
    for (const sx of [-1, 1]) {
      box(SLOPE, 8, 7, sx * (W / 4), EAVE + RISE / 2, D / 2 + 4, M.beam,
        [0, 0, -sx * PITCH]);
    }
    // Lit attic window in the front gable.
    const attic = new THREE.Mesh(new THREE.OctahedronGeometry(13), M.lit);
    attic.position.set(0, EAVE + RISE * 0.42, D / 2 + 3);
    g.add(attic);
    box(34, 7, 6, 0, EAVE + RISE * 0.42 - 15, D / 2 + 4, M.beam);

    // ── Chimney ──
    const chimX = -W / 2 + 32;
    const chimH = RIDGE - PLINTH_H + 22;
    box(30, chimH, 30, chimX, PLINTH_H + chimH / 2, -D / 2 + 34, M.stone);
    box(38, 8, 38, chimX, RIDGE + 24, -D / 2 + 34, M.beam);

    // ── Door ──
    const frontZ = D / 2 + 2;
    box(50, 68, 8, 0, PLINTH_H + 34, frontZ, M.beam);          // frame
    box(40, 60, 6, 0, PLINTH_H + 32, frontZ + 3, M.wood);      // planks
    box(40, 6, 5, 0, PLINTH_H + 50, frontZ + 5, M.iron);       // iron band
    box(40, 6, 5, 0, PLINTH_H + 16, frontZ + 5, M.iron);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(3.5, 8, 6), M.iron);
    knob.position.set(13, PLINTH_H + 32, frontZ + 7);
    g.add(knob);
    // Lit transom over the door — the tavern is open.
    box(36, 8, 5, 0, PLINTH_H + 64, frontZ + 4, M.lit);

    // ── Windows — small, lit, with mullions ──
    for (const sx of [-1, 1]) {
      const x = sx * 56;
      box(34, 30, 6, x, PLINTH_H + 58, frontZ, M.lit);
      box(40, 8, 8, x, PLINTH_H + 76, frontZ + 1, M.beam);     // lintel
      box(40, 6, 10, x, PLINTH_H + 41, frontZ + 1, M.wood);    // sill
      box(5, 30, 8, x, PLINTH_H + 58, frontZ + 2, M.beam);     // mullion
      box(34, 4, 8, x, PLINTH_H + 58, frontZ + 2, M.beam);     // transom
    }
    // One lit window on each gable end, so the tavern reads from any angle.
    for (const sx of [-1, 1]) {
      const x = sx * (W / 2 + 2);
      box(6, 28, 32, x, PLINTH_H + 58, 0, M.lit);
      box(8, 6, 38, x, PLINTH_H + 74, 0, M.beam);
      box(8, 28, 5, x, PLINTH_H + 58, 0, M.beam);
    }

    // ── Hanging sign ──
    // The board faces +Z, square to the default camera, so the tankard on it
    // is legible from the angle the player actually approaches from.
    const signX = W / 2 - 4;
    const postZ = D / 2 + 16;
    const boardZ = postZ + 34;
    box(10, 100, 10, signX, PLINTH_H + 50, postZ, M.wood);           // post
    box(10, 8, 40, signX, PLINTH_H + 96, postZ + 18, M.wood);        // arm
    box(4, 16, 4, signX, PLINTH_H + 86, boardZ, M.iron);             // chain
    box(50, 34, 5, signX, PLINTH_H + 62, boardZ, M.wood);            // board
    box(54, 38, 3, signX, PLINTH_H + 62, boardZ - 2, M.gold);        // gilt border
    // A tankard painted on the board — body plus handle.
    box(16, 18, 3, signX - 3, PLINTH_H + 60, boardZ + 3, M.lit);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(7, 2, 6, 12), M.lit);
    handle.position.set(signX + 9, PLINTH_H + 60, boardZ + 3);
    g.add(handle);

    // ── Barrels and a crate by the door ──
    const barrelGeo = new THREE.CylinderGeometry(15, 15, 34, 10);
    for (const [bx, bz] of [[-70, D / 2 + 26], [-42, D / 2 + 34]] as const) {
      const b = new THREE.Mesh(barrelGeo, M.wood);
      b.position.set(bx, PLINTH_H + 17, bz);
      g.add(b);
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(15.5, 1.8, 6, 14), M.iron);
      hoop.rotation.x = -Math.PI / 2;
      hoop.position.set(bx, PLINTH_H + 26, bz);
      g.add(hoop);
    }
    box(26, 26, 26, -96, PLINTH_H + 13, D / 2 + 20, M.wood, [0, 0.4, 0]);

    // ── Lantern beside the door ──
    box(5, 26, 5, 34, PLINTH_H + 76, frontZ + 4, M.iron);
    const lantern = new THREE.Mesh(new THREE.OctahedronGeometry(9), M.lit);
    lantern.position.set(34, PLINTH_H + 60, frontZ + 4);
    g.add(lantern);

    // ── Gold glow ring — marks the interact radius on the ground ──
    const ring = new THREE.Mesh(new THREE.TorusGeometry(this.interactRadius - 8, 6, 8, 32), M.gold);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 4;
    g.add(ring);

    return g;
  }
}
