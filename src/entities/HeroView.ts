import * as THREE from 'three';
import { HeroState } from '../sim/state';
import { HERO } from '../sim/rules';
import { RUNE_TYPES, RuneTypeId } from '../sim/runeRules';
import { heroSpeed } from '../sim/stepMatch';
import { HealthBar } from './HealthBar';
import { createHeroRig, HeroRig, MESH_SCALE } from './HeroRig';

/**
 * Render-only view of a hero. Owns the Three.js group, health bar, and the
 * cosmetic flashes; each frame it *reads* a plain `HeroState` produced by the
 * simulation and mirrors it onto the mesh. No gameplay logic lives here.
 *
 * The body mesh + animation is delegated to a HeroRig (classic procedural
 * archer or the GLB ranger — pick with `?hero=classic` / default ranger).
 */
export class HeroView {
  readonly mesh: THREE.Group;
  readonly heroId: string;

  private _rig: HeroRig;
  private _healthBar: HealthBar;
  private _flashGlow: THREE.PointLight;
  private _hitFlashTimer = 0;
  private _healFlashTimer = 0;
  private _wasAlive = true;
  /** Rune-buff indicator sprites floating above the head (DotA-style). */
  private _buffSprites = new Map<RuneTypeId, THREE.Sprite>();
  private _buffTime = 0;
  /** Healing sparkle particle pool. */
  private _healSparkles: { sprite: THREE.Sprite; vy: number; life: number }[] = [];

  constructor(
    heroId: string,
    color: number,
    private _heightAt: (x: number, z: number) => number,
  ) {
    this.heroId = heroId;
    this.mesh = new THREE.Group();
    this.mesh.scale.setScalar(MESH_SCALE);
    this._rig = createHeroRig(color);
    this.mesh.add(this._rig.root);

    // Hitbox ring at feet
    const ringGeo = new THREE.TorusGeometry(HERO.bodyRadius / MESH_SCALE, 0.08, 8, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthTest: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.renderOrder = 0;
    this.mesh.add(ring);

    this._healthBar = new HealthBar(HERO.maxHp);
    this._healthBar.sprite.position.set(0, 2.5, 0); // above archer's head
    this.mesh.add(this._healthBar.sprite);

    // Muzzle-flash glow, pulsed on fire. Kept invisible while idle so it
    // doesn't count toward the forward pipeline's per-fragment light loop.
    this._flashGlow = new THREE.PointLight(0xff6600, 0, 5);
    this._flashGlow.position.set(0, 1.5, 0);
    this._flashGlow.visible = false;
    this.mesh.add(this._flashGlow);

    // Rune-buff indicators — hidden until the matching timer runs.
    const glyphs: Record<RuneTypeId, string> = { doubleDamage: '2×', haste: '≫', invisibility: '◌' };
    for (const type of Object.keys(RUNE_TYPES) as RuneTypeId[]) {
      const sprite = _makeBuffSprite(RUNE_TYPES[type].color, glyphs[type]);
      sprite.visible = false;
      this.mesh.add(sprite);
      this._buffSprites.set(type, sprite);
    }
  }

  /** Pulse the red hit flash (driven by a sim `hit` event). */
  flashHit(): void {
    this._hitFlashTimer = 0.15;
    this._rig.setEmissive(0xff0000, 0.6);
  }

  /** Sparkle + green glow when healed by a fountain (call once per tick while healing). */
  flashHeal(): void {
    this._healFlashTimer = 0.12;
    this._rig.setEmissive(0x22cc88, 0.35);
    // Spawn 1–2 tiny sparkle particles, skipped 25% of the time to keep
    // the effect subtle (avg ~1.1 sparkles per call instead of 1.5).
    if (Math.random() < 0.9) return;
    const count = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < count; i++) this._spawnHealSparkle();
  }

  /** Pulse the muzzle flash (driven by a sim `fire` event). */
  flashFire(): void {
    this._flashGlow.intensity = 3;
    this._flashGlow.color.set(0xff6600);
    this._flashGlow.visible = true;
  }

  /** Play the bow release gesture (driven by a sim `fire` event). */
  playShoot(): void {
    this._rig.playShoot();
  }

  /** Mirror the simulation state onto the mesh for this frame. */
  sync(state: HeroState, dt: number): void {
    // Death / respawn transitions reset the mesh appearance.
    if (state.alive && !this._wasAlive) this._onRespawn();
    this._wasAlive = state.alive;

    if (!state.alive) {
      this.mesh.visible = false;
      this._healthBar.hide();
      return;
    }

    this.mesh.visible = true;
    this._healthBar.show();
    this._healthBar.setHP(state.hp, HERO.maxHp);

    const y = this._heightAt(state.pos.x, state.pos.z) + HERO.groundOffset;
    this.mesh.position.set(state.pos.x, y, state.pos.z);
    this.mesh.rotation.y = state.facing;
    // Animation cadence follows the sim's authoritative speed formula so new
    // speed modifiers can never silently desync the run animation.
    this._rig.update(dt, state.moving, heroSpeed(state));

    // Invulnerability flicker (mirrors the sim's invulnerable timer).
    if (state.invulnerable) {
      const flicker = Math.sin(state.invulnerableTimer * 20) > 0;
      this._rig.setOpacity(flicker ? 0.4 : 0.8);
    } else if (state.invisTimer > 0) {
      // Invisibility shimmer — only ever seen on our own hero (enemies with
      // the buff are hidden outright by the fog-visibility pass).
      this._rig.setOpacity(0.4);
    } else {
      this._rig.setOpacity(1);
    }

    // Rune-buff indicators above the head.
    this._buffTime += dt;
    this._syncBuffs(state);

    // Dodge visual — purple tint while dodging
    if (state.abilities.dodge.active) {
      this._rig.setEmissive(0x8833cc, 0.7);
    } else if (!state.invulnerable && this._hitFlashTimer <= 0 && this._healFlashTimer <= 0) {
      this._rig.setEmissive(0x000000, 0);
    }

    // Decay the cosmetic flashes.
    if (this._hitFlashTimer > 0) {
      this._hitFlashTimer -= dt;
      const t = Math.max(0, this._hitFlashTimer / 0.15);
      if (t > 0) this._rig.setEmissive(0xff0000, t * 0.6);
      else this._rig.setEmissive(0x000000, 0);
    }
    // Heal flash — green glow that fades quickly.
    if (this._healFlashTimer > 0) {
      this._healFlashTimer -= dt;
      const t = Math.max(0, this._healFlashTimer / 0.12);
      if (t > 0) this._rig.setEmissive(0x22cc88, t * 0.35);
      else this._rig.setEmissive(0x000000, 0);
    }
    if (this._flashGlow.intensity > 0) {
      this._flashGlow.intensity = Math.max(0, this._flashGlow.intensity - dt * 8);
      if (this._flashGlow.intensity === 0) this._flashGlow.visible = false;
    }

    // Tick healing sparkle particles.
    this._tickSparkles(dt);
  }

  dispose(): void {
    this._rig.dispose?.();
    for (const sprite of this._buffSprites.values()) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    this.mesh.removeFromParent();
  }

  /** Show one bobbing icon per active rune buff, centered above the health bar. */
  private _syncBuffs(state: HeroState): void {
    const timers: [RuneTypeId, number][] = [
      ['doubleDamage', state.ddTimer],
      ['haste', state.hasteTimer],
      ['invisibility', state.invisTimer],
    ];
    const active = timers.filter(([, t]) => t > 0);
    const spacing = 0.55;
    let slot = 0;
    for (const [type, sprite] of this._buffSprites) {
      const entry = active.find(([t]) => t === type);
      if (!entry) {
        sprite.visible = false;
        continue;
      }
      sprite.visible = true;
      const x = (slot - (active.length - 1) / 2) * spacing;
      sprite.position.set(x, 3.1 + Math.sin(this._buffTime * 3 + slot) * 0.06, 0);
      // Blink during the last 3 seconds as an expiry warning.
      const remaining = entry[1];
      sprite.material.opacity = remaining < 3 && Math.sin(remaining * 12) > 0 ? 0.25 : 0.95;
      slot++;
    }
  }

  private _onRespawn(): void {
    this._hitFlashTimer = 0;
    this._healFlashTimer = 0;
    this._rig.onRespawn();
  }

  // ── Healing sparkle particles ───────────────────────────────────

  /** Create one tiny green sparkle that floats up and fades out. */
  private _spawnHealSparkle(): void {
    const mat = new THREE.SpriteMaterial({
      color: 0x44ffaa,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.15, 0.15, 1);
    sprite.renderOrder = 25;
    // Random offset around the hero's waist
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.3 + Math.random() * 0.5;
    sprite.position.set(
      Math.cos(angle) * radius,
      1.0 + Math.random() * 0.8,
      Math.sin(angle) * radius,
    );
    this.mesh.add(sprite);
    this._healSparkles.push({ sprite, vy: 0.8 + Math.random() * 1.2, life: 0.6 + Math.random() * 0.4 });
  }

  /** Advance all sparkles — float upward, shrink, fade, dispose when spent. */
  private _tickSparkles(dt: number): void {
    for (let i = this._healSparkles.length - 1; i >= 0; i--) {
      const p = this._healSparkles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.material.dispose();
        p.sprite.removeFromParent();
        this._healSparkles.splice(i, 1);
        continue;
      }
      p.sprite.position.y += p.vy * dt;
      p.sprite.material.opacity = Math.max(0, p.life);
    }
  }
}

/** A round badge sprite with a glyph, used as a rune-buff indicator. */
function _makeBuffSprite(color: number, glyph: string): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = `#${color.toString(16).padStart(6, '0')}`;

  // Filled disc with a bright rim.
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = c;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();

  // Glyph.
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.5)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, size / 2, size / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    opacity: 0.95,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.45, 0.45, 1);
  sprite.renderOrder = 20;
  return sprite;
}
