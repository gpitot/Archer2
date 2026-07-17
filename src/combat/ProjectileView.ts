/**
 * Render-only view of a projectile (arrow). Owns the Three.js mesh; each
 * frame it *reads* a plain `ProjectileState` and mirrors it onto the mesh.
 * No gameplay logic lives here — the sim is the source of truth.
 */
import * as THREE from 'three';
import { ProjectileState } from '../sim/state';
import { ARROW } from '../sim/rules';

export type ProjectileStyle = 'arrow' | 'fireball' | 'scout' | 'ice';

export class ProjectileView {
  readonly mesh: THREE.Group;
  readonly projectileId: string;

  private _light: THREE.PointLight;
  private _trailMat: THREE.MeshStandardMaterial;
  private _arrowParts!: THREE.Group;
  private _fireball!: THREE.Mesh;
  private _snowParticles!: THREE.Points;
  private _arrowHeadMat!: THREE.MeshStandardMaterial;
  private _shaftMat!: THREE.MeshStandardMaterial;
  private _featherMat!: THREE.MeshStandardMaterial[];
  private _style: ProjectileStyle = 'arrow';

  constructor(projectileId: string) {
    this.projectileId = projectileId;
    this.mesh = this._buildMesh();
    this.mesh.visible = false;
    this._light = this.mesh.getObjectByName('arrowLight') as THREE.PointLight;
    this._trailMat = (this.mesh.getObjectByName('arrowTrail') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    this._snowParticles = this.mesh.getObjectByName('snowParticles') as THREE.Points;
    this._arrowHeadMat = (this.mesh.getObjectByName('arrowHead') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    this._shaftMat = (this.mesh.getObjectByName('arrowShaft') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    this._featherMat = [0, 1, 2].map((i) =>
      ((this.mesh.getObjectByName(`arrowFeather${i}`) as THREE.Mesh)
        .material as THREE.MeshStandardMaterial),
    );
  }

  /**
   * Switch between the arrow look and the creep fireball look. Views are
   * pooled, so a style is re-asserted on every acquire (cheap no-op when
   * unchanged).
   */
  setStyle(style: ProjectileStyle): void {
    if (style === this._style) return;
    this._style = style;
    const orb = style === 'fireball' || style === 'scout'; // fireball & scout share the sphere core
    this._arrowParts.visible = !orb;
    this._fireball.visible = orb;
    const fireballMat = this._fireball.material as THREE.MeshStandardMaterial;
    if (style === 'scout') {
      // Scout: cool blue vision orb.
      fireballMat.color.set(0x55ccff);
      fireballMat.emissive.set(0x1166cc);
      this._trailMat.color.set(0x99ddff);
      this._trailMat.emissive.set(0x113355);
      this._light.color.set(0x66bbff);
    } else if (style === 'fireball') {
      fireballMat.color.set(0xff7733);
      fireballMat.emissive.set(0xdd3300);
      this._trailMat.color.set(0xff6633);
      this._trailMat.emissive.set(0x662200);
      this._light.color.set(0xff5522);
    } else if (style === 'ice') {
      // Ice arrow: frosty blue-white with snow particles.
      this._shaftMat.color.set(0x88bbee);
      this._shaftMat.emissive.set(0x112244);
      this._arrowHeadMat.color.set(0xccddff);
      this._arrowHeadMat.emissive.set(0x335577);
      this._trailMat.color.set(0xaaccff);
      this._trailMat.emissive.set(0x223366);
      this._light.color.set(0x88ccff);
      for (const fm of this._featherMat) {
        fm.color.set(0x5599dd);
      }
    } else {
      // Default arrow: warm wood.
      this._shaftMat.color.set(0xc49a6c);
      this._shaftMat.emissive.set(0x000000);
      this._arrowHeadMat.color.set(0xd8d8d8);
      this._arrowHeadMat.emissive.set(0x111111);
      this._trailMat.color.set(0xffddaa);
      this._trailMat.emissive.set(0x331100);
      this._light.color.set(0xff9944);
      for (const fm of this._featherMat) {
        fm.color.set(0xe84040);
      }
    }
    this._snowParticles.visible = style === 'ice';
  }

  /** Mirror the simulation state onto the mesh for this frame. */
  sync(state: ProjectileState, heightAt: (x: number, z: number) => number, isIce = false): void {
    if (isIce) {
      this.setStyle('ice');
    } else {
      this.setStyle(
        state.ownerKind === 'creep' ? 'fireball' : state.kind === 'scout' ? 'scout' : 'arrow',
      );
    }
    this.mesh.visible = true;
    this.mesh.position.set(
      state.pos.x,
      heightAt(state.pos.x, state.pos.z) + ARROW.flyHeight,
      state.pos.z,
    );
    this.mesh.rotation.y = Math.atan2(state.dir.x, state.dir.z);

    // Pulse the trail opacity for a subtle living feel
    const pulse = 0.25 + 0.08 * Math.sin(performance.now() * 0.015);
    this._trailMat.opacity = pulse;

    // Animate snow particles for ice arrows
    if (isIce && this._snowParticles.visible) {
      this._tickSnowParticles();
    }
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }

  // ── Mesh ────────────────────────────────────────────────────────

  private _buildMesh(): THREE.Group {
    const root = new THREE.Group();
    const group = new THREE.Group(); // arrow-only parts, hidden in fireball style
    this._arrowParts = group;
    root.add(group);

    // ── Fireball core (creep projectiles) ──
    const coreGeo = new THREE.SphereGeometry(7, 10, 8);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0xff7733,
      emissive: 0xdd3300,
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });
    this._fireball = new THREE.Mesh(coreGeo, coreMat);
    this._fireball.position.z = 20;
    this._fireball.visible = false;
    root.add(this._fireball);

    // ── Shaft (wooden body) ──
    const shaftGeo = new THREE.CylinderGeometry(1.8, 1.8, 32, 8);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0xc49a6c, roughness: 0.55, metalness: 0.05,
    });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.z = 14;
    shaft.rotation.x = Math.PI / 2;
    shaft.name = 'arrowShaft';
    group.add(shaft);

    // ── Arrowhead (metallic, sharp) ──
    const headGeo = new THREE.ConeGeometry(2.6, 10, 8);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xd8d8d8, roughness: 0.15, metalness: 0.9, emissive: 0x111111,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.z = 35;
    head.rotation.x = Math.PI / 2;
    head.name = 'arrowHead';
    group.add(head);

    // ── Fletching (3 feathers at the tail) ──
    const featherMat = new THREE.MeshStandardMaterial({
      color: 0xe84040, roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
    });
    const nockMat = new THREE.MeshStandardMaterial({
      color: 0x333333, roughness: 0.4, metalness: 0.3,
    });

    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const featherGeo = new THREE.ConeGeometry(1.4, 9, 4);
      const feather = new THREE.Mesh(featherGeo, featherMat.clone());
      feather.position.set(
        Math.cos(angle) * 1.8,
        Math.sin(angle) * 1.8,
        -3,
      );
      feather.rotation.x = Math.PI / 2;
      feather.name = `arrowFeather${i}`;
      group.add(feather);
    }

    // Nock (small cylinder at the very back)
    const nockGeo = new THREE.CylinderGeometry(1.3, 1.5, 3, 8);
    const nock = new THREE.Mesh(nockGeo, nockMat);
    nock.position.z = -2;
    nock.rotation.x = Math.PI / 2;
    group.add(nock);

    // ── Motion trail (long tapering semi-transparent cone behind) ──
    const trailGeo = new THREE.CylinderGeometry(1.6, 0.2, 50, 8, 1, true);
    const trailMat = new THREE.MeshStandardMaterial({
      color: 0xffddaa,
      roughness: 0.5,
      emissive: 0x331100,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.position.z = -20; // extend behind the arrow
    trail.rotation.x = Math.PI / 2;
    trail.name = 'arrowTrail';
    trail.renderOrder = 1;
    root.add(trail); // shared by both styles

    // ── Point light (warm glow around the arrowhead) ──
    const light = new THREE.PointLight(0xff9944, 80, 90);
    light.position.z = 30;
    light.name = 'arrowLight';
    root.add(light); // shared by both styles

    // ── Snow particles (trailing behind ice arrows) ──
    this._snowParticles = this._buildSnowParticles();
    this._snowParticles.visible = false;
    this._snowParticles.name = 'snowParticles';
    root.add(this._snowParticles);

    return root;
  }

  // ── Snow particle system ──────────────────────────────────────────

  private _snowPositions!: Float32Array;
  private _snowVelocities!: Float32Array;
  private _snowCount = 30;

  private _buildSnowParticles(): THREE.Points {
    const count = this._snowCount;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    this._snowPositions = positions;
    this._snowVelocities = velocities;

    // Distribute particles randomly in a cone behind the arrow
    for (let i = 0; i < count; i++) {
      // Radial distance from arrow axis (0–5 unit radius)
      const r = Math.random() * 5;
      const angle = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(angle) * r;     // x (local right)
      positions[i * 3 + 1] = Math.sin(angle) * r; // y (local up)
      positions[i * 3 + 2] = -(Math.random() * 40 + 5); // z (local behind, 5–45 units back)

      // Initial velocity for drifting
      velocities[i * 3] = (Math.random() - 0.5) * 3;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 2 - 1; // slight upward then fall
      velocities[i * 3 + 2] = Math.random() * 8 + 2; // drift backward
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xccddff,
      size: 1.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.7,
    });

    return new THREE.Points(geo, mat);
  }

  /** Animate snow particles each frame — drift, swirl, re-spawn behind. */
  private _tickSnowParticles(): void {
    const p = this._snowPositions;
    const v = this._snowVelocities;
    const count = this._snowCount;
    const now = performance.now() * 0.001;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      // Apply velocity
      p[i3] += v[i3] * 0.016;
      p[i3 + 1] += v[i3 + 1] * 0.016;
      p[i3 + 2] += v[i3 + 2] * 0.016;

      // Gentle swirl
      const swirl = Math.sin(now * 3 + i * 0.5) * 0.3;
      p[i3] += swirl * 0.016;
      p[i3 + 1] += Math.cos(now * 2.5 + i * 0.7) * 0.2 * 0.016;

      // If particle drifts too far back or too far out, respawn it
      if (p[i3 + 2] < -55 || Math.abs(p[i3]) > 8 || Math.abs(p[i3 + 1]) > 8) {
        const r = Math.random() * 5;
        const angle = Math.random() * Math.PI * 2;
        p[i3] = Math.cos(angle) * r;
        p[i3 + 1] = Math.sin(angle) * r;
        p[i3 + 2] = -(Math.random() * 10 + 5);
        v[i3] = (Math.random() - 0.5) * 3;
        v[i3 + 1] = (Math.random() - 0.5) * 2 - 1;
        v[i3 + 2] = Math.random() * 8 + 2;
      }
    }

    (this._snowParticles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
