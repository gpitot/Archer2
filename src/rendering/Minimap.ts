import * as THREE from 'three';
import { NavGrid } from '../navigation/NavGrid';

interface MinimapMarker {
  x: number;
  z: number;
  color: string;
  radius: number;
}

/**
 * 2D canvas minimap rendered as an overlay in the bottom-right corner.
 * Top-down flat representation — terrain is a simple grass green,
 * blocked cells are darkened.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;

  private _width: number;
  private _mapSizePx: number;
  private _arenaSize: number;
  private _halfArena: number;
  private _navGrid: NavGrid;
  private _terrainImage: ImageData | null = null;

  /** Called with world (x, z) when minimap is clicked. */
  onClick: ((wx: number, wz: number) => void) | null = null;

  constructor(arenaSize: number, navGrid: NavGrid, size = 200, padding = 8) {
    this._arenaSize = arenaSize;
    this._halfArena = arenaSize / 2;
    this._navGrid = navGrid;

    this._width = size + padding * 2;
    this._mapSizePx = size;
    const pad = padding;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this._width;
    this.canvas.height = this._width;
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

    // Click → world coords
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left - pad;
      const py = e.clientY - rect.top - pad;
      if (px < 0 || px > size || py < 0 || py > size) return;
      const wx = (px / size) * this._arenaSize - this._halfArena;
      // Invert Y: canvas py=0 = top = +Z (north)
      const wz = -((size - py) / size * this._arenaSize - this._halfArena);
      this.onClick?.(wx, wz);
    });

    this._bakeTerrain();
  }

  private _bakeTerrain(): void {
    const size = this._mapSizePx;
    this._terrainImage = this._ctx.createImageData(size, size);

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const wx = (px / size) * this._arenaSize - this._halfArena;
        const wz = (py / size) * this._arenaSize - this._halfArena;
        const { gx, gz } = this._navGrid.worldToGrid(wx, wz);
        const blocked = !this._navGrid.isWalkable(gx, gz);

        const idx = (py * size + px) * 4;
        if (blocked) {
          this._terrainImage!.data[idx] = 32;
          this._terrainImage!.data[idx + 1] = 40;
          this._terrainImage!.data[idx + 2] = 24;
        } else {
          // Flat grass green
          this._terrainImage!.data[idx] = 34;
          this._terrainImage!.data[idx + 1] = 90;
          this._terrainImage!.data[idx + 2] = 30;
        }
        this._terrainImage!.data[idx + 3] = 255;
      }
    }
  }

  private _worldToPixel(wx: number, wz: number): [number, number] {
    const px = ((wx + this._halfArena) / this._arenaSize) * this._mapSizePx;
    // Canvas Y=0 is top, so invert Z: +Z (north) → top, -Z (south) → bottom
    const py = this._mapSizePx - ((-wz + this._halfArena) / this._arenaSize) * this._mapSizePx;
    return [px, py];
  }

  draw(markers: MinimapMarker[], cameraView?: { cx: number; cz: number; halfW: number }): void {
    const ctx = this._ctx;
    const pad = (this._width - this._mapSizePx) / 2;

    ctx.clearRect(0, 0, this._width, this._width);

    // Baked terrain
    if (this._terrainImage) {
      ctx.putImageData(this._terrainImage, pad, pad);
    }

    // Camera view rectangle (axis-aligned — matches top-down world)
    if (cameraView) {
      const [cx, cz] = this._worldToPixel(cameraView.cx, cameraView.cz);
      const hw = (cameraView.halfW / this._arenaSize) * this._mapSizePx;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(pad + cx - hw, pad + cz - hw, hw * 2, hw * 2);
    }

    // Hero markers
    for (const m of markers) {
      const [px, py] = this._worldToPixel(m.x, m.z);
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
    ctx.strokeRect(pad, pad, this._mapSizePx, this._mapSizePx);
  }

  destroy(): void {
    this.canvas.remove();
  }
}
