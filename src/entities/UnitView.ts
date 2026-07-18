import * as THREE from 'three';

/**
 * Thin shared base for unit render-views (heroes, creeps). Owns only what is
 * genuinely identical across every unit today: the outer `mesh` group and the
 * cosmetic foot ring drawn flat on the ground. Body construction, animation,
 * and the per-frame state mirror stay in each subclass — a hero's procedural
 * rig and a creep's async GLB differ too much to hoist here yet.
 *
 * The hit-flash timer decrement and the position/facing/HP mirror in each
 * `sync` are the obvious next things to pull up once they're worth unifying.
 */
export abstract class UnitView {
  /** Outer transform group — created by the subclass and handed to `super`. */
  readonly mesh: THREE.Group;
  /** Seconds remaining on the red damage-flash pulse (shared cadence). */
  protected _hitFlashTimer = 0;

  constructor(mesh: THREE.Group) {
    this.mesh = mesh;
  }

  /**
   * Add the flat ground ring at the unit's feet. `localRadius` is in the mesh
   * group's *local* space, so each caller converts its own world radius (heroes
   * divide by their group's MESH_SCALE; creeps render at world scale and pass
   * the raw body radius). Defaults reproduce the hero ring exactly.
   */
  protected addFootRing(
    localRadius: number,
    color: number,
    opts: { tube?: number; y?: number; opacity?: number } = {},
  ): void {
    const { tube = 0.08, y = 0.05, opacity = 0.25 } = opts;
    const geo = new THREE.TorusGeometry(localRadius, tube, 8, 64);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false });
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = y;
    ring.renderOrder = 0;
    this.mesh.add(ring);
  }
}
