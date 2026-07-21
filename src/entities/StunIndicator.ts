/**
 * The "seeing stars" badge that orbits above a stunned unit.
 *
 * Built from the same recipe as the rune-buff badges and name plates: draw
 * once to an offscreen canvas, share that texture across a few sprites, and
 * let billboarding face the camera for free. The stars orbit a horizontal
 * ring, and the two on the far side are drawn smaller and dimmer so the ring
 * reads as a circle rather than a line even from a top-down camera.
 *
 * Purely cosmetic: it mirrors `stunTimer` from the sim and owns no state that
 * gameplay reads.
 */
import * as THREE from 'three';

/** Stars in the orbiting ring. */
const STAR_COUNT = 3;
/** Orbit revolutions per second. */
const SPIN_SPEED = 1.4;

/** The star texture is identical for every indicator — build it once. */
let sharedTexture: THREE.CanvasTexture | null = null;

function starTexture(): THREE.CanvasTexture {
  if (sharedTexture) return sharedTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Five-pointed star, alternating outer and inner radius.
  const cx = size / 2;
  const cy = size / 2;
  const outer = size * 0.45;
  const inner = outer * 0.42;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    // Start at -90° so a point faces up.
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffdd44';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(90,60,0,0.9)';
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  sharedTexture = texture;
  return texture;
}

export interface StunIndicatorOpts {
  /** Height above the unit's origin, in the parent group's local units. */
  height: number;
  /** Orbit radius, in the parent group's local units. */
  radius: number;
  /** Size of one star, in the parent group's local units. */
  starSize: number;
}

export class StunIndicator {
  private _sprites: THREE.Sprite[] = [];
  private _time = 0;
  private _opts: StunIndicatorOpts;

  /** Mounts itself into `parent`, hidden until `update` sees a live stun. */
  constructor(parent: THREE.Group, opts: StunIndicatorOpts) {
    this._opts = opts;
    const map = starTexture();
    for (let i = 0; i < STAR_COUNT; i++) {
      const material = new THREE.SpriteMaterial({
        map,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(opts.starSize, opts.starSize, 1);
      sprite.renderOrder = 26;
      sprite.visible = false;
      parent.add(sprite);
      this._sprites.push(sprite);
    }
  }

  /**
   * Move the ring up or down. Creeps only learn their true model height once
   * the GLB has loaded, so the indicator is re-seated then.
   */
  setHeight(height: number): void {
    this._opts.height = height;
  }

  /**
   * Mirror the sim's `stunTimer`. Call once per frame with the unit's current
   * value — 0 hides the ring, anything positive spins it.
   */
  update(stunTimer: number, dt: number): void {
    if (stunTimer <= 0) {
      if (this._sprites[0].visible) {
        for (const s of this._sprites) s.visible = false;
      }
      return;
    }

    this._time += dt;
    const { height, radius } = this._opts;
    const spin = this._time * SPIN_SPEED * Math.PI * 2;

    for (let i = 0; i < this._sprites.length; i++) {
      const sprite = this._sprites[i];
      const angle = spin + (i / STAR_COUNT) * Math.PI * 2;
      // z is the depth axis of the orbit; sin(angle) < 0 is the far half.
      const depth = Math.sin(angle);
      sprite.visible = true;
      sprite.position.set(
        Math.cos(angle) * radius,
        height + depth * radius * 0.25,
        depth * radius,
      );
      // Fake depth: stars on the far side shrink and dim.
      const near = (depth + 1) / 2; // 0 = far, 1 = near
      const scale = this._opts.starSize * (0.65 + near * 0.35);
      sprite.scale.set(scale, scale, 1);
      sprite.material.opacity = 0.55 + near * 0.45;
    }
  }

  dispose(): void {
    for (const sprite of this._sprites) {
      sprite.material.dispose();
      sprite.removeFromParent();
    }
    this._sprites.length = 0;
  }
}
