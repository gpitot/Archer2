/**
 * Billboarded text label, rendered on a canvas and hung on a sprite.
 *
 * The same recipe as the rune-buff badges in HeroView: draw to an offscreen
 * canvas, wrap it in a CanvasTexture, and let the sprite face the camera for
 * free. `depthTest: false` keeps labels readable over the hero's own mesh —
 * visibility against the world is handled by the parent group being hidden.
 */
import * as THREE from 'three';

export interface TextSpriteOpts {
  color: number;
  /** Height of the sprite in the parent's local units. */
  height?: number;
  fontPx?: number;
  renderOrder?: number;
}

/** Height of the drawing canvas; width is measured from the text. */
const CANVAS_H = 64;
const PAD_X = 16;

export interface TextSprite {
  sprite: THREE.Sprite;
  dispose: () => void;
}

export function makeTextSprite(text: string, opts: TextSpriteOpts): TextSprite {
  const fontPx = opts.fontPx ?? 34;
  const height = opts.height ?? 0.28;
  const font = `bold ${fontPx}px sans-serif`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  // Measure first, then size the canvas — sizing resets the context, so the
  // font has to be set again afterwards.
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  canvas.width = Math.max(CANVAS_H, Math.ceil(textW + PAD_X * 2));
  canvas.height = CANVAS_H;

  const w = canvas.width;
  const h = canvas.height;

  // Dark rounded backing so light-coloured names stay readable over terrain.
  const r = 10;
  ctx.beginPath();
  ctx.moveTo(r, 6);
  ctx.arcTo(w - 1, 6, w - 1, h - 6, r);
  ctx.arcTo(w - 1, h - 6, 1, h - 6, r);
  ctx.arcTo(1, h - 6, 1, 6, r);
  ctx.arcTo(1, 6, w - 1, 6, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = `#${opts.color.toString(16).padStart(6, '0')}`;
  ctx.fillText(text, w / 2, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(height * (w / h), height, 1);
  sprite.renderOrder = opts.renderOrder ?? 21;

  return {
    sprite,
    dispose: () => {
      texture.dispose();
      material.dispose();
      sprite.removeFromParent();
    },
  };
}
