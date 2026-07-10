import * as THREE from 'three';
import { HeightMap } from '../world/HeightMap';
import { NavGrid } from '../navigation/NavGrid';

interface MinimapMarker {
  x: number;
  z: number;
  color: string;
  radius: number;
}

/**
 * 2D canvas minimap rendered as an overlay in the bottom-right corner.
 * Shows terrain coloring, obstacles, and hero positions from a top-down view.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;

  private _width: number;
  private _height: number;
  private _mapSizePx: number; // size of the square map area in the canvas

  private _arenaSize: number; // world units (200)
  private _halfArena: number;

  private _heightMap: HeightMap;
  private _navGrid: NavGrid;

  // Sampling resolution: how many world units per minimap pixel
  private _sampleStep: number;

  private _terrainImage: ImageData | null = null;

  constructor(
    arenaSize: number,
    heightMap: HeightMap,
    navGrid: NavGrid,
    size = 200,
    padding = 8,
  ) {
    this._arenaSize = arenaSize;
    this._halfArena = arenaSize / 2;
    this._heightMap = heightMap;
    this._navGrid = navGrid;

    this._width = size + padding * 2;
    this._height = size + padding * 2;
    this._mapSizePx = size;

    // Sampling: render every Nth world unit. For a 200-unit arena into 200px = 1:1.
    this._sampleStep = arenaSize / size;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this._width;
    this.canvas.height = this._height;
    this.canvas.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 4px;
      background: rgba(0,0,0,0.5);
      z-index: 100;
      pointer-events: none;
    `;
    document.body.appendChild(this.canvas);

    this._ctx = this.canvas.getContext('2d')!;
    this._bakeTerrain();
  }

  /** Pre-render the terrain base layer once. */
  private _bakeTerrain(): void {
    const size = this._mapSizePx;
    this._terrainImage = this._ctx.createImageData(size, size);

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        // Pixel → world coordinates (center of arena is origin)
        const wx = (px / size) * this._arenaSize - this._halfArena;
        const wz = (py / size) * this._arenaSize - this._halfArena;
        const h = this._heightMap.getHeightAt(wx, wz);
        const color = this._heightToTerrainColor(h);

        // Check if cell is blocked (obstacle)
        const { gx, gz } = this._navGrid.worldToGrid(wx, wz);
        const blocked = !this._navGrid.isWalkable(gx, gz);

        const idx = (py * size + px) * 4;
        if (blocked) {
          // Dark overlay for blocked areas
          this._terrainImage!.data[idx] = Math.min(255, color[0] * 0.5);
          this._terrainImage!.data[idx + 1] = Math.min(255, color[1] * 0.5);
          this._terrainImage!.data[idx + 2] = Math.min(255, color[2] * 0.5);
        } else {
          this._terrainImage!.data[idx] = color[0];
          this._terrainImage!.data[idx + 1] = color[1];
          this._terrainImage!.data[idx + 2] = color[2];
        }
        this._terrainImage!.data[idx + 3] = 255;
      }
    }
  }

  private _heightToTerrainColor(h: number): [number, number, number] {
    const t = Math.max(0, Math.min(1, (h + 1) / 10));
    if (h < -0.5) return [38, 77, 64];
    if (h < 0.5) return [64, 115, 38];
    if (h < 2) return [Math.floor(77 + t * 50), Math.floor(128 + t * 25), 46];
    if (h < 4) return [Math.floor(115 + (h - 2) / 2 * 25), Math.floor(140 - (h - 2) / 2 * 25), Math.floor(38 - (h - 2) / 2 * 12)];
    if (h < 6) return [Math.floor(128 + (h - 4) / 2 * 25), Math.floor(107 + (h - 4) / 2 * 12), Math.floor(77 + (h - 4) / 2 * 25)];
    return [140, 128, 115];
  }

  /** World position → minimap pixel (relative to map area, top-left origin). */
  private _worldToPixel(wx: number, wz: number): [number, number] {
    const px = ((wx + this._halfArena) / this._arenaSize) * this._mapSizePx;
    const py = ((wz + this._halfArena) / this._arenaSize) * this._mapSizePx;
    return [px, py];
  }

  /** Draw markers (heroes, etc.) on top of the baked terrain. */
  draw(markers: MinimapMarker[], cameraView?: { cx: number; cz: number; halfW: number }): void {
    const ctx = this._ctx;
    const pad = (this._width - this._mapSizePx) / 2;

    // Clear
    ctx.clearRect(0, 0, this._width, this._height);

    // Draw baked terrain
    if (this._terrainImage) {
      ctx.putImageData(this._terrainImage, pad, pad);
    }

    // Camera view rectangle
    if (cameraView) {
      const [cx, cz] = this._worldToPixel(cameraView.cx, cameraView.cz);
      const hw = (cameraView.halfW / this._arenaSize) * this._mapSizePx;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(pad + cx - hw, pad + cz - hw, hw * 2, hw * 2);
    }

    // Markers
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
