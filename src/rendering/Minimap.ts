import { MapData, ArenaRect, PATH_CELL_SIZE } from '../world/wc3/MapData';
import { FLAG_WATER } from '../world/wc3/W3EParser';
import { isCellWalkable } from '../world/wc3/WpmParser';
import { TILE_BASE_COLORS, WATER_SHALLOW, WATER_DEEP } from '../world/wc3/TilePalette';
import { FogOfWar, FOG_EXPLORED, FOG_VISIBLE } from '../vision/FogOfWar';

interface MinimapMarker {
  x: number;
  z: number;
  color: string;
  radius: number;
}

/**
 * 2D canvas minimap rendered as an overlay in the bottom-right corner.
 *
 * Shows the active arena rect (like WC3's camera-bounds-driven minimap),
 * baked from the original tile data: ground tile colors, cliff-layer
 * shading, water, blocked pathing cells, and tree doodads.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;

  private _view: ArenaRect;
  private _pxW: number;
  private _pxH: number;
  private _pad: number;
  private _baked: HTMLCanvasElement;

  // Fog-of-war overlay (small offscreen canvas scaled up with smoothing)
  private _fog: FogOfWar | null = null;
  private _fogTeam = 0;
  private _fogCanvas: HTMLCanvasElement | null = null;
  private _fogCtx: CanvasRenderingContext2D | null = null;
  private _fogImage: ImageData | null = null;
  private _fogVersion = -1;

  // Drag state
  private _dragging = false;
  private _dragStartPx = 0;
  private _dragStartPy = 0;
  private static readonly _DRAG_THRESHOLD = 3; // px — below this it's a click

  /** Called with world (x, z) when minimap is clicked (no drag). */
  onClick: ((wx: number, wz: number) => void) | null = null;
  /** Called with world (x, z) continuously while the minimap is being dragged. */
  onDrag: ((wx: number, wz: number) => void) | null = null;

  constructor(map: MapData, view: ArenaRect, size = 200, padding = 8) {
    this._view = view;
    this._pad = padding;

    // Fit the view rect into a size×size box, preserving aspect.
    const scale = size / Math.max(view.width, view.height);
    this._pxW = Math.round(view.width * scale);
    this._pxH = Math.round(view.height * scale);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this._pxW + padding * 2;
    this.canvas.height = this._pxH + padding * 2;
    this.canvas.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 4px;
      background: rgba(0,0,0,0.5);
      z-index: 100;
      pointer-events: auto;
      cursor: pointer;
    `;
    document.body.appendChild(this.canvas);
    this._ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left - padding;
      const py = e.clientY - rect.top - padding;
      if (px < 0 || px > this._pxW || py < 0 || py > this._pxH) return;
      this._dragging = true;
      this._dragStartPx = px;
      this._dragStartPy = py;
      this.canvas.setPointerCapture(e.pointerId);
      // Immediately jump to the pointer position.
      const wx = this._view.minX + (px / this._pxW) * this._view.width;
      const wz = this._view.minZ + (py / this._pxH) * this._view.height;
      this.onDrag?.(wx, wz);
      e.preventDefault();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const rect = this.canvas.getBoundingClientRect();
      let px = e.clientX - rect.left - padding;
      let py = e.clientY - rect.top - padding;
      // Clamp so the camera doesn't fly outside the view rect bounds.
      px = Math.max(0, Math.min(px, this._pxW));
      py = Math.max(0, Math.min(py, this._pxH));
      const wx = this._view.minX + (px / this._pxW) * this._view.width;
      const wz = this._view.minZ + (py / this._pxH) * this._view.height;
      this.onDrag?.(wx, wz);
    });

    const endDrag = (e: PointerEvent) => {
      if (!this._dragging) return;
      this._dragging = false;
      this.canvas.releasePointerCapture(e.pointerId);
      // If the pointer barely moved, treat it as a click.
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left - padding;
      const py = e.clientY - rect.top - padding;
      const dx = px - this._dragStartPx;
      const dy = py - this._dragStartPy;
      if (Math.sqrt(dx * dx + dy * dy) < Minimap._DRAG_THRESHOLD
          && px >= 0 && px <= this._pxW && py >= 0 && py <= this._pxH) {
        const wx = this._view.minX + (px / this._pxW) * this._view.width;
        const wz = this._view.minZ + (py / this._pxH) * this._view.height;
        this.onClick?.(wx, wz);
      }
    };

    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointerleave', endDrag);

    this._baked = this._bakeTerrain(map);
  }

  /** Attach a fog-of-war overlay drawn from the given team's point of view. */
  setFog(fog: FogOfWar, team: number): void {
    this._fog = fog;
    this._fogTeam = team;
    this._fogCanvas = document.createElement('canvas');
    this._fogCanvas.width = fog.cellsX;
    this._fogCanvas.height = fog.cellsZ;
    this._fogCtx = this._fogCanvas.getContext('2d')!;
    this._fogImage = this._fogCtx.createImageData(fog.cellsX, fog.cellsZ);
    this._fogVersion = -1;
  }

  /**
   * Bake the arena's tile data into an offscreen canvas at one pixel per
   * pathing cell, later drawn scaled onto the display canvas.
   */
  private _bakeTerrain(map: MapData): HTMLCanvasElement {
    const { terrain, pathing, doodads } = map;
    const view = this._view;

    const cols = Math.max(1, Math.round(view.width / PATH_CELL_SIZE));
    const rows = Math.max(1, Math.round(view.height / PATH_CELL_SIZE));
    const off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    const ctx = off.getContext('2d')!;
    const img = ctx.createImageData(cols, rows);

    for (let py = 0; py < rows; py++) {
      for (let px = 0; px < cols; px++) {
        // Pixel center in world space (canvas top = min Z = north)
        const wx = view.minX + (px + 0.5) * PATH_CELL_SIZE;
        const wz = view.minZ + (py + 0.5) * PATH_CELL_SIZE;

        // Nearest tilepoint (tilepoint rows run south → north)
        const ti = Math.min(Math.max(Math.round((wx - terrain.offsetX) / 128), 0), terrain.width - 1);
        const tj = Math.min(Math.max(Math.round((-wz - terrain.offsetY) / 128), 0), terrain.height - 1);
        const k = tj * terrain.width + ti;

        const base = TILE_BASE_COLORS[terrain.groundTiles[terrain.texture[k]]] ?? [255, 0, 255];
        const shade = 0.75 + 0.13 * (terrain.layer[k] - 1);
        let r = base[0] * shade;
        let g = base[1] * shade;
        let b = base[2] * shade;

        const depth = terrain.finalWaterHeight[k] - terrain.finalHeight[k];
        if ((terrain.flags[k] & FLAG_WATER) !== 0 && depth > 0) {
          const deep = Math.min(depth / 128, 1);
          r = WATER_SHALLOW[0] + (WATER_DEEP[0] - WATER_SHALLOW[0]) * deep;
          g = WATER_SHALLOW[1] + (WATER_DEEP[1] - WATER_SHALLOW[1]) * deep;
          b = WATER_SHALLOW[2] + (WATER_DEEP[2] - WATER_SHALLOW[2]) * deep;
        } else {
          // Pathing cell (data row 0 = south)
          const col = Math.floor((wx - terrain.offsetX) / PATH_CELL_SIZE);
          const row = Math.floor((-wz - terrain.offsetY) / PATH_CELL_SIZE);
          if (!isCellWalkable(pathing, col, row)) {
            r *= 0.55; g *= 0.55; b *= 0.55;
          }
        }

        const o = (py * cols + px) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Tree doodads as dark dots
    ctx.fillStyle = 'rgb(20,46,24)';
    for (const d of doodads) {
      const wx = d.x;
      const wz = -d.y;
      if (wx < view.minX || wx > view.maxX || wz < view.minZ || wz > view.maxZ) continue;
      const px = Math.floor(((wx - view.minX) / view.width) * cols);
      const py = Math.floor(((wz - view.minZ) / view.height) * rows);
      ctx.fillRect(px, py, 1, 1);
    }

    return off;
  }

  private _worldToPixel(wx: number, wz: number): [number, number] {
    const px = ((wx - this._view.minX) / this._view.width) * this._pxW;
    const py = ((wz - this._view.minZ) / this._view.height) * this._pxH;
    return [px, py];
  }

  draw(markers: MinimapMarker[], cameraView?: { cx: number; cz: number; halfW: number }): void {
    const ctx = this._ctx;
    const pad = this._pad;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._baked, pad, pad, this._pxW, this._pxH);

    // Fog-of-war overlay: hidden = near-black, explored = dimmed, visible = clear.
    // The fog grid covers the same arena rect as the view, row 0 = min Z = top.
    if (this._fog && this._fogCtx && this._fogImage && this._fogCanvas) {
      // The offscreen fog canvas only needs rebuilding when visibility
      // actually changed; the scaled blit below stays per-frame.
      if (this._fog.version !== this._fogVersion) {
        this._fogVersion = this._fog.version;
        const states = this._fog.team(this._fogTeam);
        const data = this._fogImage.data;
        for (let i = 0; i < states.length; i++) {
          const alpha =
            states[i] === FOG_VISIBLE ? 0 :
            states[i] === FOG_EXPLORED ? 110 : 235;
          data[i * 4] = 0;
          data[i * 4 + 1] = 0;
          data[i * 4 + 2] = 0;
          data[i * 4 + 3] = alpha;
        }
        this._fogCtx.putImageData(this._fogImage, 0, 0);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this._fogCanvas, pad, pad, this._pxW, this._pxH);
    }

    // Camera view rectangle (axis-aligned — matches top-down world)
    if (cameraView) {
      const [cx, cz] = this._worldToPixel(cameraView.cx, cameraView.cz);
      const hw = (cameraView.halfW / this._view.width) * this._pxW;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(pad + cx - hw, pad + cz - hw, hw * 2, hw * 2);
    }

    // Hero markers
    for (const m of markers) {
      const [px, py] = this._worldToPixel(m.x, m.z);
      if (px < -4 || px > this._pxW + 4 || py < -4 || py > this._pxH + 4) continue;
      ctx.beginPath();
      ctx.arc(pad + px, pad + py, m.radius, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, this._pxW, this._pxH);
  }

  destroy(): void {
    this.canvas.remove();
  }
}
