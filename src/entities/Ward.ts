import * as THREE from 'three';

/**
 * A placed sentry ward: a static vision source for its team that expires
 * after a fixed duration (WC3 sentry-ward style). Satisfies the
 * `VisionSource` shape used by `FogOfWar`.
 */
export class Ward {
  /** How far the ward sees (world units). */
  static readonly SIGHT_RADIUS = 700;
  /** Lifetime in seconds (WC3 sentry ward: 300s). */
  static readonly DURATION = 300;

  readonly mesh: THREE.Group;
  readonly team: number;
  readonly sightRadius = Ward.SIGHT_RADIUS;

  private _life = Ward.DURATION;
  private _eyeMat!: THREE.MeshStandardMaterial; // assigned in _buildMesh()

  constructor(team: number, position: THREE.Vector3) {
    this.team = team;
    this.mesh = this._buildMesh();
    this.mesh.position.copy(position);
  }

  get position(): THREE.Vector3 {
    return this.mesh.position;
  }

  /** Vision-source liveness: expired wards grant no vision. */
  get active(): boolean {
    return this._life > 0;
  }

  get expired(): boolean {
    return this._life <= 0;
  }

  get remainingLife(): number {
    return Math.max(0, this._life);
  }

  update(delta: number): void {
    if (this._life <= 0) return;
    this._life -= delta;

    // Blink the eye during the last 10 seconds as an expiry warning.
    if (this._life < 10) {
      const blink = Math.sin(this._life * 12) > 0;
      this._eyeMat.emissiveIntensity = blink ? 1.2 : 0.2;
    }
  }

  private _buildMesh(): THREE.Group {
    const g = new THREE.Group();

    // Wooden stake
    const stakeGeo = new THREE.CylinderGeometry(2, 3, 18, 6);
    const stakeMat = new THREE.MeshStandardMaterial({ color: 0x6b4a26, roughness: 0.9 });
    const stake = new THREE.Mesh(stakeGeo, stakeMat);
    stake.position.y = 9;
    g.add(stake);

    // Glowing eye orb on top
    const eyeGeo = new THREE.SphereGeometry(5, 12, 10);
    this._eyeMat = new THREE.MeshStandardMaterial({
      color: 0x66ff88,
      roughness: 0.3,
      emissive: 0x22cc55,
      emissiveIntensity: 0.9,
    });
    const eye = new THREE.Mesh(eyeGeo, this._eyeMat);
    eye.position.y = 21;
    g.add(eye);

    return g;
  }
}
