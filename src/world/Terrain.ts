import * as THREE from 'three';
import { NavGrid } from '../navigation/NavGrid';

interface Hill {
  x: number;
  z: number;
  radius: number;
  height: number;
}

/**
 * Hand-placed hills. Most are gentle enough to walk; the last one is a
 * deliberately steep peak that slope-based navigation will block (Phase 3).
 */
const HILLS: Hill[] = [
  { x: 650, z: 520, radius: 640, height: 210 },
  { x: -780, z: -240, radius: 720, height: 260 },
  { x: -320, z: 720, radius: 500, height: 150 },
  { x: 120, z: 120, radius: 420, height: 90 },
  { x: 850, z: -620, radius: 230, height: 360 }, // steep — nav will block its face
];

/**
 * Smooth continuous heightfield over the arena.
 *
 * `heightAt` is the single source of truth for ground elevation — it drives the
 * render mesh, hero/projectile Y, camera framing, and slope-based navigation.
 * It is analytic and cheap (a handful of Gaussians) so it can be called every
 * frame for every entity.
 */
export class Terrain {
  readonly mesh: THREE.Mesh;

  private readonly _half: number;
  private readonly _borderMargin = 320;

  constructor(size: number, segments = 160) {
    this._half = size / 2;
    this.mesh = this._buildMesh(size, segments);
  }

  // ── Sampling ───────────────────────────────────────────────────

  /** Terrain height at a world XZ position. */
  heightAt(wx: number, wz: number): number {
    let h = 0;
    for (const hill of HILLS) {
      const dx = wx - hill.x;
      const dz = wz - hill.z;
      const d2 = dx * dx + dz * dz;
      h += hill.height * Math.exp(-d2 / (2 * hill.radius * hill.radius));
    }
    // Gentle rolling undulation.
    h += 12 * Math.sin(wx * 0.004) * Math.cos(wz * 0.0037);
    // Fade to flat near the arena border.
    return h * this._borderFade(wx, wz);
  }

  /** Gradient magnitude (rise/run) at a world XZ position. */
  slopeAt(wx: number, wz: number): number {
    const e = 8;
    const hx = (this.heightAt(wx + e, wz) - this.heightAt(wx - e, wz)) / (2 * e);
    const hz = (this.heightAt(wx, wz + e) - this.heightAt(wx, wz - e)) / (2 * e);
    return Math.sqrt(hx * hx + hz * hz);
  }

  /** Surface normal at a world XZ position. */
  normalAt(wx: number, wz: number): THREE.Vector3 {
    const e = 8;
    const hx = (this.heightAt(wx + e, wz) - this.heightAt(wx - e, wz)) / (2 * e);
    const hz = (this.heightAt(wx, wz + e) - this.heightAt(wx, wz - e)) / (2 * e);
    return new THREE.Vector3(-hx, 1, -hz).normalize();
  }

  // ── Navigation ─────────────────────────────────────────────────

  /** Block nav cells whose slope exceeds `maxSlope` (too steep to climb). */
  applyToNav(nav: NavGrid, maxSlope = 0.6): void {
    for (let gz = 0; gz < nav.height; gz++) {
      for (let gx = 0; gx < nav.width; gx++) {
        const { wx, wz } = nav.gridToWorld(gx, gz);
        if (this.slopeAt(wx, wz) > maxSlope) {
          nav.setWalkable(gx, gz, false);
        }
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────────

  private _borderFade(wx: number, wz: number): number {
    const edge = Math.min(this._half - Math.abs(wx), this._half - Math.abs(wz));
    return THREE.MathUtils.clamp(edge / this._borderMargin, 0, 1);
  }

  private _buildMesh(size: number, segments: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2); // lay flat: local (x, y, 0) → world (x, 0, -y)

    const pos = geo.attributes.position;

    // Displace vertices and find the max height for color banding.
    let maxH = 1;
    for (let i = 0; i < pos.count; i++) {
      const h = this.heightAt(pos.getX(i), pos.getZ(i));
      pos.setY(i, h);
      if (h > maxH) maxH = h;
    }

    // Vertex colors: grass → dirt (by slope) → rock → snowy peak (by height).
    const grass = new THREE.Color(0x3a6b2a);
    const dirt = new THREE.Color(0x6b5730);
    const rock = new THREE.Color(0x9a968c);
    const peak = new THREE.Color(0xe8e8ee);
    const c = new THREE.Color();
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const t = THREE.MathUtils.clamp(pos.getY(i) / maxH, 0, 1);
      const slope = this.slopeAt(x, z);

      // Grass stays green on gentle ground; dirt only shows on real slopes.
      c.copy(grass).lerp(dirt, THREE.MathUtils.clamp((slope - 0.35) * 3, 0, 1));
      c.lerp(rock, THREE.MathUtils.clamp((t - 0.55) * 2.2, 0, 1));
      c.lerp(peak, THREE.MathUtils.clamp((t - 0.85) * 6, 0, 1));

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    return mesh;
  }
}
