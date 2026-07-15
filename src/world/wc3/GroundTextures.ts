import * as THREE from 'three';

/**
 * Procedurally painted ground-texture atlas in a hand-painted WC3-like
 * style. All art is generated here from scratch on a canvas — no game
 * assets are used.
 *
 * Layout: 4×3 grid of 256px cells. Cells 0–7 follow the w3e ground-tile
 * palette order (Adrt, Adrd, Agrs, Arck, Agrd, Avin, Adrg, Alvd); cells
 * 8–9 are the cliff-wall textures (CAgr grassy rock, CAdi dirt strata).
 *
 * Each cell holds a 224px tileable pattern surrounded by a 16px gutter of
 * wrapped copies so bilinear/mip sampling never bleeds between cells.
 */

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 3;
export const CELL_PX = 256;
export const CONTENT_PX = 224;
export const GUTTER_PX = 16;
export const CLIFF_CELL_GRASS = 8;
export const CLIFF_CELL_DIRT = 9;

export interface GroundAtlas {
  texture: THREE.CanvasTexture;
  /** UV rect of a cell's content area (v is GL-style, bottom-up). */
  uvRect(cell: number): { u0: number; v0: number; u1: number; v1: number };
}

/** Deterministic PRNG so the atlas looks identical every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;

function rgb(r: number, g: number, b: number, a = 1): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

/**
 * Draw `fn` 9 times at ±size offsets so every element wraps around the
 * pattern edges, making the result seamlessly tileable.
 */
function wrapped(ctx: Ctx, size: number, fn: (ctx: Ctx) => void): void {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      ctx.save();
      ctx.translate(ox * size, oy * size);
      fn(ctx);
      ctx.restore();
    }
  }
}

// ── Per-tile painters (224px tileable patterns) ─────────────────

function paintDirt(ctx: Ctx, s: number, rnd: () => number, base: [number, number, number], cracks: boolean): void {
  ctx.fillStyle = rgb(...base);
  ctx.fillRect(0, 0, s, s);
  wrapped(ctx, s, (c) => {
    for (let i = 0; i < 46; i++) {
      const light = rnd() < 0.5 ? -1 : 1;
      const k = 8 + rnd() * 22;
      c.fillStyle = rgb(base[0] + light * k, base[1] + light * k * 0.9, base[2] + light * k * 0.7, 0.28);
      c.beginPath();
      c.ellipse(rnd() * s, rnd() * s, 8 + rnd() * 26, 6 + rnd() * 18, rnd() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
    for (let i = 0; i < 260; i++) {
      const k = (rnd() - 0.5) * 46;
      c.fillStyle = rgb(base[0] + k, base[1] + k, base[2] + k * 0.8, 0.5);
      c.fillRect(rnd() * s, rnd() * s, 1 + rnd(), 1 + rnd());
    }
    if (cracks) {
      c.strokeStyle = rgb(base[0] * 0.45, base[1] * 0.45, base[2] * 0.45, 0.5);
      c.lineWidth = 1;
      for (let i = 0; i < 10; i++) {
        let x = rnd() * s;
        let y = rnd() * s;
        c.beginPath();
        c.moveTo(x, y);
        for (let seg = 0; seg < 5; seg++) {
          x += (rnd() - 0.5) * 34;
          y += (rnd() - 0.5) * 34;
          c.lineTo(x, y);
        }
        c.stroke();
      }
    }
  });
}

function paintGrass(ctx: Ctx, s: number, rnd: () => number, base: [number, number, number], bluish: boolean): void {
  ctx.fillStyle = rgb(...base);
  ctx.fillRect(0, 0, s, s);
  wrapped(ctx, s, (c) => {
    // Soft tonal patches under the blades
    for (let i = 0; i < 18; i++) {
      const k = (rnd() - 0.5) * 28;
      c.fillStyle = rgb(base[0] + k * 0.6, base[1] + k, base[2] + k * (bluish ? 1.1 : 0.5), 0.25);
      c.beginPath();
      c.ellipse(rnd() * s, rnd() * s, 16 + rnd() * 34, 12 + rnd() * 26, rnd() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
    // Blades: short strokes with slight lean
    for (let i = 0; i < 520; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      const len = 3 + rnd() * 5;
      const lean = (rnd() - 0.5) * 2.4;
      const k = (rnd() - 0.5) * 44;
      c.strokeStyle = rgb(
        base[0] + k * 0.5,
        base[1] + k,
        base[2] + k * (bluish ? 1.2 : 0.4),
        0.6,
      );
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + lean, y - len);
      c.stroke();
    }
  });
}

function paintRock(ctx: Ctx, s: number, rnd: () => number, base: [number, number, number]): void {
  ctx.fillStyle = rgb(...base);
  ctx.fillRect(0, 0, s, s);
  wrapped(ctx, s, (c) => {
    // Angular facets
    for (let i = 0; i < 26; i++) {
      const cx = rnd() * s;
      const cy = rnd() * s;
      const r = 12 + rnd() * 30;
      const n = 3 + (rnd() * 3 | 0);
      const k = (rnd() - 0.5) * 40;
      c.fillStyle = rgb(base[0] + k, base[1] + k, base[2] + k, 0.35);
      c.beginPath();
      for (let v = 0; v < n; v++) {
        const ang = (v / n) * Math.PI * 2 + rnd() * 0.9;
        const rr = r * (0.6 + rnd() * 0.5);
        const px = cx + Math.cos(ang) * rr;
        const py = cy + Math.sin(ang) * rr;
        if (v === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.closePath();
      c.fill();
    }
    // Crevices
    c.strokeStyle = rgb(base[0] * 0.5, base[1] * 0.5, base[2] * 0.5, 0.55);
    c.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      let x = rnd() * s;
      let y = rnd() * s;
      c.beginPath();
      c.moveTo(x, y);
      for (let seg = 0; seg < 4; seg++) {
        x += (rnd() - 0.5) * 40;
        y += (rnd() - 0.5) * 24;
        c.lineTo(x, y);
      }
      c.stroke();
    }
  });
}

function paintGrassyDirt(ctx: Ctx, s: number, rnd: () => number): void {
  paintDirt(ctx, s, rnd, [106, 86, 54], false);
  wrapped(ctx, s, (c) => {
    for (let i = 0; i < 22; i++) {
      const cx = rnd() * s;
      const cy = rnd() * s;
      const r = 10 + rnd() * 22;
      c.fillStyle = rgb(84, 112, 52, 0.35);
      c.beginPath();
      c.ellipse(cx, cy, r, r * 0.7, rnd() * Math.PI, 0, Math.PI * 2);
      c.fill();
      for (let b = 0; b < 14; b++) {
        const ang = rnd() * Math.PI * 2;
        const rr = rnd() * r;
        c.strokeStyle = rgb(70 + rnd() * 40, 105 + rnd() * 40, 45, 0.6);
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr);
        c.lineTo(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr - 3 - rnd() * 3);
        c.stroke();
      }
    }
  });
}

function paintVines(ctx: Ctx, s: number, rnd: () => number): void {
  ctx.fillStyle = rgb(66, 96, 56);
  ctx.fillRect(0, 0, s, s);
  wrapped(ctx, s, (c) => {
    for (let i = 0; i < 26; i++) {
      const dark = rnd() < 0.5;
      c.strokeStyle = dark ? rgb(34, 56, 30, 0.7) : rgb(74, 104, 56, 0.55);
      c.lineWidth = 1.5 + rnd() * 1.5;
      let x = rnd() * s;
      let y = rnd() * s;
      c.beginPath();
      c.moveTo(x, y);
      for (let seg = 0; seg < 4; seg++) {
        const nx = x + (rnd() - 0.5) * 50;
        const ny = y + (rnd() - 0.5) * 50;
        c.quadraticCurveTo(x + (rnd() - 0.5) * 30, y + (rnd() - 0.5) * 30, nx, ny);
        x = nx;
        y = ny;
      }
      c.stroke();
    }
    // Leaf dots along the vines
    for (let i = 0; i < 120; i++) {
      c.fillStyle = rgb(60 + rnd() * 40, 95 + rnd() * 40, 46, 0.55);
      c.beginPath();
      c.ellipse(rnd() * s, rnd() * s, 1.5 + rnd() * 2, 1 + rnd(), rnd() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
  });
}

function paintLeaves(ctx: Ctx, s: number, rnd: () => number): void {
  ctx.fillStyle = rgb(84, 74, 42);
  ctx.fillRect(0, 0, s, s);
  wrapped(ctx, s, (c) => {
    for (let i = 0; i < 300; i++) {
      const olive = rnd();
      c.fillStyle = rgb(70 + olive * 50, 62 + olive * 42, 30 + olive * 22, 0.6);
      c.beginPath();
      c.ellipse(rnd() * s, rnd() * s, 3 + rnd() * 3.5, 1.5 + rnd() * 1.5, rnd() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
    // A few darker decayed patches
    for (let i = 0; i < 12; i++) {
      c.fillStyle = rgb(56, 48, 26, 0.3);
      c.beginPath();
      c.ellipse(rnd() * s, rnd() * s, 14 + rnd() * 22, 10 + rnd() * 16, rnd() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
  });
}

/** Cliff wall: horizontal strata with vertical cracks. */
function paintCliff(ctx: Ctx, s: number, rnd: () => number, base: [number, number, number], mossy: boolean): void {
  ctx.fillStyle = rgb(...base);
  ctx.fillRect(0, 0, s, s);
  wrapped(ctx, s, (c) => {
    // Strata bands
    for (let y = 0; y < s; y += 14 + (rnd() * 10 | 0)) {
      const k = (rnd() - 0.5) * 34;
      c.fillStyle = rgb(base[0] + k, base[1] + k, base[2] + k, 0.4);
      c.fillRect(0, y, s, 6 + rnd() * 10);
      c.strokeStyle = rgb(base[0] * 0.55, base[1] * 0.55, base[2] * 0.55, 0.5);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(s, y + (rnd() - 0.5) * 4);
      c.stroke();
    }
    // Vertical cracks
    c.strokeStyle = rgb(base[0] * 0.45, base[1] * 0.45, base[2] * 0.45, 0.5);
    for (let i = 0; i < 8; i++) {
      let x = rnd() * s;
      let y = 0;
      c.beginPath();
      c.moveTo(x, y);
      while (y < s) {
        y += 12 + rnd() * 22;
        x += (rnd() - 0.5) * 10;
        c.lineTo(x, y);
      }
      c.stroke();
    }
    if (mossy) {
      for (let i = 0; i < 40; i++) {
        c.fillStyle = rgb(70 + rnd() * 30, 100 + rnd() * 30, 55, 0.3);
        c.beginPath();
        c.ellipse(rnd() * s, rnd() * s * 0.4, 4 + rnd() * 10, 2 + rnd() * 5, 0, 0, Math.PI * 2);
        c.fill();
      }
    }
  });
}

// ── Atlas assembly ──────────────────────────────────────────────

const PAINTERS: ((ctx: Ctx, s: number, rnd: () => number) => void)[] = [
  (c, s, r) => paintDirt(c, s, r, [122, 90, 58], false),   // 0 Adrt
  (c, s, r) => paintDirt(c, s, r, [100, 72, 46], true),    // 1 Adrd rough
  (c, s, r) => paintGrass(c, s, r, [74, 118, 48], false),  // 2 Agrs
  (c, s, r) => paintRock(c, s, r, [128, 124, 116]),        // 3 Arck
  (c, s, r) => paintGrassyDirt(c, s, r),                   // 4 Agrd
  (c, s, r) => paintVines(c, s, r),                        // 5 Avin
  (c, s, r) => paintGrass(c, s, r, [58, 98, 72], true),    // 6 Adrg dark grass
  (c, s, r) => paintLeaves(c, s, r),                       // 7 Alvd
  (c, s, r) => paintCliff(c, s, r, [125, 122, 114], true), // 8 CAgr
  (c, s, r) => paintCliff(c, s, r, [107, 79, 52], false),  // 9 CAdi
];

export function createGroundAtlas(): GroundAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * CELL_PX;
  canvas.height = ATLAS_ROWS * CELL_PX;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pattern = document.createElement('canvas');
  pattern.width = CONTENT_PX;
  pattern.height = CONTENT_PX;
  const pctx = pattern.getContext('2d')!;

  for (let cell = 0; cell < PAINTERS.length; cell++) {
    pctx.clearRect(0, 0, CONTENT_PX, CONTENT_PX);
    PAINTERS[cell](pctx, CONTENT_PX, mulberry32(1337 + cell * 101));

    // Blit the pattern 9× so the 16px gutter holds wrapped copies.
    const col = cell % ATLAS_COLS;
    const row = (cell / ATLAS_COLS) | 0;
    const x0 = col * CELL_PX;
    const y0 = row * CELL_PX;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, CELL_PX, CELL_PX);
    ctx.clip();
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        ctx.drawImage(pattern, x0 + GUTTER_PX + ox * CONTENT_PX, y0 + GUTTER_PX + oy * CONTENT_PX);
      }
    }
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const w = canvas.width;
  const h = canvas.height;
  return {
    texture,
    uvRect(cell: number) {
      const col = cell % ATLAS_COLS;
      const row = (cell / ATLAS_COLS) | 0;
      const x0 = col * CELL_PX + GUTTER_PX;
      const y0 = row * CELL_PX + GUTTER_PX;
      // CanvasTexture flips Y: v = 1 − y/height
      return {
        u0: x0 / w,
        v0: 1 - (y0 + CONTENT_PX) / h,
        u1: (x0 + CONTENT_PX) / w,
        v1: 1 - y0 / h,
      };
    },
  };
}
