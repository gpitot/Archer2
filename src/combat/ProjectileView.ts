/**
 * Render-only view of a projectile (arrow). Owns the Three.js mesh; each
 * frame it *reads* a plain `ProjectileState` and mirrors it onto the mesh.
 * No gameplay logic lives here — the sim is the source of truth.
 */
import * as THREE from 'three';
import { ProjectileState } from '../sim/state';
import { ARROW } from '../sim/rules';

export type ProjectileStyle = 'arrow' | 'fireball' | 'scout' | 'ice' | 'fire';

/** Per-style look-up table: colours for every recolourable part of the arrow. */
interface StyleColors {
  shaft: number;
  shaftEmissive: number;
  head: number;
  headEmissive: number;
  feather: number;
  glow: number; // additive halo sheath + tip orb
  trail: number; // additive motion streak
  light: number; // point light tint
}

const STYLES: Record<'arrow' | 'ice' | 'fire', StyleColors> = {
  // Default arrow: warm wood shaft, bright steel head, gold energy halo so it
  // reads clearly against grass and shadow from the top-down camera.
  arrow: {
    shaft: 0xc49a6c,
    shaftEmissive: 0x2a1c0a,
    head: 0xf2f2f2,
    headEmissive: 0x554422,
    feather: 0xef3b3b,
    glow: 0xffcc55,
    trail: 0xffd27a,
    light: 0xffbb55,
  },
  // Ice arrow: frosty blue-white with a cold cyan halo and drifting snow.
  ice: {
    shaft: 0x9fd0f5,
    shaftEmissive: 0x1c3a5c,
    head: 0xeaf6ff,
    headEmissive: 0x3f7fb8,
    feather: 0x6fb2e6,
    glow: 0x9fe4ff,
    trail: 0xbfe8ff,
    light: 0x7fd0ff,
  },
  // Fire arrow: charred shaft, molten head, orange flame halo and rising embers.
  // Purely cosmetic for now — wired for a future fire-bow item.
  fire: {
    shaft: 0x3a2417,
    shaftEmissive: 0x120704,
    head: 0xffd27a,
    headEmissive: 0xff5a1e,
    feather: 0xff9d3c,
    glow: 0xff8a33,
    trail: 0xffb347,
    light: 0xff6a22,
  },
};

export class ProjectileView {
  readonly mesh: THREE.Group;
  readonly projectileId: string;

  private _light: THREE.PointLight;
  private _trailMat: THREE.MeshBasicMaterial;
  private _glowMat: THREE.MeshBasicMaterial;
  private _arrowParts!: THREE.Group;
  private _fireball!: THREE.Mesh;
  private _particles!: THREE.Points;
  private _particleMat!: THREE.PointsMaterial;
  private _arrowHeadMat!: THREE.MeshStandardMaterial;
  private _shaftMat!: THREE.MeshStandardMaterial;
  private _featherMat!: THREE.MeshStandardMaterial[];
  private _style: ProjectileStyle = 'arrow';
  private _particleMode: 'snow' | 'ember' = 'snow';

  constructor(projectileId: string) {
    this.projectileId = projectileId;
    this.mesh = this._buildMesh();
    this.mesh.visible = false;
    this._light = this.mesh.getObjectByName('arrowLight') as THREE.PointLight;
    this._trailMat = (this.mesh.getObjectByName('arrowTrail') as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    this._glowMat = (this.mesh.getObjectByName('arrowGlow') as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
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
   * Switch between the arrow looks and the creep fireball look. Views are
   * pooled, so a style is re-asserted on every acquire (cheap no-op when
   * unchanged).
   */
  setStyle(style: ProjectileStyle): void {
    if (style === this._style) return;
    this._style = style;
    const orb = style === 'fireball' || style === 'scout'; // fireball & scout share the sphere core
    this._arrowParts.visible = !orb;
    this._glowMat.visible = !orb;
    this._fireball.visible = orb;
    const fireballMat = this._fireball.material as THREE.MeshStandardMaterial;

    if (style === 'scout') {
      // Scout: cool blue vision orb.
      fireballMat.color.set(0x55ccff);
      fireballMat.emissive.set(0x1166cc);
      this._trailMat.color.set(0x99ddff);
      this._light.color.set(0x66bbff);
    } else if (style === 'fireball') {
      fireballMat.color.set(0xff7733);
      fireballMat.emissive.set(0xdd3300);
      this._trailMat.color.set(0xff6633);
      this._light.color.set(0xff5522);
    } else {
      // Arrow family (arrow / ice / fire) — recolour every arrow part from the
      // shared palette so the shot reads instantly at a glance.
      const c = STYLES[style];
      this._shaftMat.color.set(c.shaft);
      this._shaftMat.emissive.set(c.shaftEmissive);
      this._arrowHeadMat.color.set(c.head);
      this._arrowHeadMat.emissive.set(c.headEmissive);
      this._glowMat.color.set(c.glow);
      this._trailMat.color.set(c.trail);
      this._light.color.set(c.light);
      for (const fm of this._featherMat) fm.color.set(c.feather);
    }

    // Particle system: snow for ice, embers for fire, off otherwise.
    const showParticles = style === 'ice' || style === 'fire';
    this._particles.visible = showParticles;
    if (style === 'ice') {
      this._particleMode = 'snow';
      this._particleMat.color.set(0xdcefff);
      this._particleMat.size = 1.3;
    } else if (style === 'fire') {
      this._particleMode = 'ember';
      this._particleMat.color.set(0xff8a3c);
      this._particleMat.size = 1.8;
    }
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

    const t = performance.now();
    // Pulse the trail + halo opacity for a subtle living feel.
    this._trailMat.opacity = 0.42 + 0.12 * Math.sin(t * 0.015);
    this._glowMat.opacity = 0.5 + 0.14 * Math.sin(t * 0.02);
    // Gentle spin on the halo/tip so the glow shimmers rather than sits flat.
    this._light.intensity = 130 + 30 * Math.sin(t * 0.02);

    // Animate the particle system for ice/fire arrows.
    if (this._particles.visible) this._tickParticles();
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

    // ── Shaft (wooden body) — a touch thicker & longer than before ──
    const shaftGeo = new THREE.CylinderGeometry(2.1, 2.1, 40, 10);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0xc49a6c, roughness: 0.5, metalness: 0.05, emissive: 0x2a1c0a,
      emissiveIntensity: 0.6,
    });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.z = 16;
    shaft.rotation.x = Math.PI / 2;
    shaft.name = 'arrowShaft';
    group.add(shaft);

    // ── Arrowhead (bigger, metallic, sharp) ──
    const headGeo = new THREE.ConeGeometry(3.4, 13, 10);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xf2f2f2, roughness: 0.12, metalness: 0.95, emissive: 0x554422,
      emissiveIntensity: 0.9,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.z = 42;
    head.rotation.x = Math.PI / 2;
    head.name = 'arrowHead';
    group.add(head);

    // ── Fletching (3 feathers at the tail) ──
    const featherMat = new THREE.MeshStandardMaterial({
      color: 0xef3b3b, roughness: 0.55, metalness: 0, side: THREE.DoubleSide,
      emissive: 0x220000, emissiveIntensity: 0.5,
    });
    const nockMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a, roughness: 0.4, metalness: 0.3,
    });

    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const featherGeo = new THREE.ConeGeometry(1.8, 11, 4);
      const feather = new THREE.Mesh(featherGeo, featherMat.clone());
      feather.position.set(
        Math.cos(angle) * 2.1,
        Math.sin(angle) * 2.1,
        -4,
      );
      feather.rotation.x = Math.PI / 2;
      feather.name = `arrowFeather${i}`;
      group.add(feather);
    }

    // Nock (small cylinder at the very back)
    const nockGeo = new THREE.CylinderGeometry(1.5, 1.7, 3.5, 8);
    const nock = new THREE.Mesh(nockGeo, nockMat);
    nock.position.z = -3;
    nock.rotation.x = Math.PI / 2;
    group.add(nock);

    // ── Energy halo (additive sheath hugging the shaft) ──
    // The single biggest readability win: a bright, camera-agnostic glow that
    // wraps the whole arrow so it never disappears into the terrain.
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffcc55,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const sheathGeo = new THREE.CylinderGeometry(3.2, 4.6, 56, 12, 1, true);
    const sheath = new THREE.Mesh(sheathGeo, glowMat);
    sheath.position.z = 18;
    sheath.rotation.x = Math.PI / 2;
    sheath.name = 'arrowGlow';
    sheath.renderOrder = 2;
    group.add(sheath);

    // Bright tip orb — a hot point of light at the head, reads as a clear dot
    // from directly overhead. Shares the halo material so it recolours in sync.
    const tipGeo = new THREE.SphereGeometry(5, 14, 12);
    const tip = new THREE.Mesh(tipGeo, glowMat);
    tip.position.z = 44;
    tip.renderOrder = 2;
    group.add(tip);

    // ── Motion trail (long tapering additive streak behind) ──
    const trailGeo = new THREE.CylinderGeometry(2.4, 0.2, 68, 10, 1, true);
    const trailMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.position.z = -28; // extend behind the arrow
    trail.rotation.x = Math.PI / 2;
    trail.name = 'arrowTrail';
    trail.renderOrder = 1;
    root.add(trail); // shared by both styles

    // ── Point light (glow around the arrowhead, colours the ground) ──
    const light = new THREE.PointLight(0xffbb55, 130, 120);
    light.position.z = 34;
    light.name = 'arrowLight';
    root.add(light); // shared by both styles

    // ── Particle system (snow for ice, embers for fire) ──
    this._particles = this._buildParticles();
    this._particles.visible = false;
    this._particles.name = 'projectileParticles';
    root.add(this._particles);

    return root;
  }

  // ── Particle system (ice snow / fire embers) ──────────────────────

  private _partPositions!: Float32Array;
  private _partVelocities!: Float32Array;
  private _partCount = 34;

  private _buildParticles(): THREE.Points {
    const count = this._partCount;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    this._partPositions = positions;
    this._partVelocities = velocities;

    for (let i = 0; i < count; i++) {
      this._seedParticle(positions, velocities, i);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this._particleMat = new THREE.PointsMaterial({
      color: 0xdcefff,
      size: 1.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.8,
    });

    return new THREE.Points(geo, this._particleMat);
  }

  /** (Re)seed one particle in the cone trailing behind the arrow. */
  private _seedParticle(p: Float32Array, v: Float32Array, i: number): void {
    const i3 = i * 3;
    const r = Math.random() * 5;
    const angle = Math.random() * Math.PI * 2;
    p[i3] = Math.cos(angle) * r;
    p[i3 + 1] = Math.sin(angle) * r;
    p[i3 + 2] = -(Math.random() * 12 + 4);
    v[i3] = (Math.random() - 0.5) * 3;
    v[i3 + 1] = (Math.random() - 0.5) * 2 - 1;
    v[i3 + 2] = Math.random() * 8 + 2; // drift backward
  }

  /** Animate particles each frame — drift, swirl, re-spawn behind the arrow. */
  private _tickParticles(): void {
    const p = this._partPositions;
    const v = this._partVelocities;
    const count = this._partCount;
    const now = performance.now() * 0.001;
    // Embers rise & flicker; snow settles gently downward.
    const buoyancy = this._particleMode === 'ember' ? 2.2 : -0.6;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      p[i3] += v[i3] * 0.016;
      p[i3 + 1] += (v[i3 + 1] + buoyancy) * 0.016;
      p[i3 + 2] += v[i3 + 2] * 0.016;

      // Gentle swirl.
      const swirl = Math.sin(now * 3 + i * 0.5) * 0.3;
      p[i3] += swirl * 0.016;
      p[i3 + 1] += Math.cos(now * 2.5 + i * 0.7) * 0.2 * 0.016;

      // Respawn once it drifts too far back or out of the cone.
      if (p[i3 + 2] < -60 || Math.abs(p[i3]) > 9 || Math.abs(p[i3 + 1]) > 9) {
        this._seedParticle(p, v, i);
      }
    }

    (this._particles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
