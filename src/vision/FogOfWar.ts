import * as THREE from 'three';

/** Per-cell visibility states, Warcraft 3 style. */
export const FOG_HIDDEN = 0; // never seen — black mask
export const FOG_EXPLORED = 1; // seen before — terrain remembered, units hidden
export const FOG_VISIBLE = 2; // currently in sight

/** World-space rectangle a fog grid covers. */
export interface FogBounds {
  minX: number;
  minZ: number;
  width: number;
  height: number;
}

/**
 * Anything that grants vision: heroes, wards, (later) buildings and allies.
 * Structural — Hero and Ward satisfy this without importing the interface.
 */
export interface VisionSource {
  /** Live world position of the source. */
  readonly position: THREE.Vector3;
  /** How far this source can see (world units). */
  readonly sightRadius: number;
  /** Inactive sources contribute no vision (dead hero, expired ward). */
  readonly active: boolean;
  /** Team whose fog this source reveals. */
  readonly team: number;
}

/**
 * Warcraft-3-style fog of war.
 *
 * The playable area is divided into a coarse grid. Each *team* owns a
 * visibility map (hidden / explored / visible) that is the union of what all
 * of that team's vision sources can see — so teammates and their wards
 * automatically share vision. A cell is in sight of a source when it is
 * inside the source's sight radius AND the heightfield line-of-sight test
 * passes:
 *
 *  - **High ground advantage**: the sight line runs from the source's eye
 *    (ground + EYE_HEIGHT) to the target cell (ground + TARGET_HEIGHT).
 *    Terrain rising above that line blocks it, so a unit downhill cannot see
 *    up past a crest, while a unit on the crest sees down freely — WC3's
 *    high-ground rule, adapted to a smooth heightfield.
 *  - **Sight blockers**: trees and rocks raise the blocking height of the
 *    cells they cover, so forests occlude vision like WC3 tree walls.
 *
 * Visibility is recomputed on a fixed interval (not every frame); renderers
 * smooth the transitions.
 */
export class FogOfWar {
  /** Eye height added above the ground at the source's cell. */
  static readonly EYE_HEIGHT = 25;
  /** Height above the ground a cell must be seen at to count as visible. */
  static readonly TARGET_HEIGHT = 12;

  /** Seconds between visibility recomputes. */
  readonly recomputeInterval = 0.15;

  readonly cellsX: number;
  readonly cellsZ: number;
  readonly cellSize: number;
  /** World coordinate of the grid's min corner. */
  readonly originX: number;
  readonly originZ: number;
  /** World extent covered by the grid. */
  readonly worldWidth: number;
  readonly worldHeight: number;

  private _groundH: Float32Array; // terrain height per cell
  private _blockH: Float32Array; // sight-blocking height per cell (terrain + doodads)
  private _teams = new Map<number, Uint8Array>();
  private _sources: VisionSource[] = [];
  private _timer = 0; // time until next recompute; 0 → recompute on next update

  constructor(
    bounds: FogBounds,
    cellSize: number,
    heightAt: (x: number, z: number) => number,
  ) {
    this.cellSize = cellSize;
    this.cellsX = Math.max(1, Math.round(bounds.width / cellSize));
    this.cellsZ = Math.max(1, Math.round(bounds.height / cellSize));
    this.worldWidth = this.cellsX * cellSize;
    this.worldHeight = this.cellsZ * cellSize;
    this.originX = bounds.minX;
    this.originZ = bounds.minZ;

    const n = this.cellsX * this.cellsZ;
    this._groundH = new Float32Array(n);
    this._blockH = new Float32Array(n);
    for (let cz = 0; cz < this.cellsZ; cz++) {
      for (let cx = 0; cx < this.cellsX; cx++) {
        const h = heightAt(
          this.originX + (cx + 0.5) * cellSize,
          this.originZ + (cz + 0.5) * cellSize,
        );
        this._groundH[cz * this.cellsX + cx] = h;
        this._blockH[cz * this.cellsX + cx] = h;
      }
    }
  }

  // ── Setup ──────────────────────────────────────────────────────

  /** Raise the sight-blocking height over a rectangular footprint (tree/rock). */
  addSightBlocker(wx: number, wz: number, halfWidth: number, halfDepth: number, height: number): void {
    const minX = this._clampCellX(Math.floor((wx - halfWidth - this.originX) / this.cellSize));
    const maxX = this._clampCellX(Math.floor((wx + halfWidth - this.originX) / this.cellSize));
    const minZ = this._clampCellZ(Math.floor((wz - halfDepth - this.originZ) / this.cellSize));
    const maxZ = this._clampCellZ(Math.floor((wz + halfDepth - this.originZ) / this.cellSize));
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const idx = cz * this.cellsX + cx;
        this._blockH[idx] = Math.max(this._blockH[idx], this._groundH[idx] + height);
      }
    }
  }

  addSource(source: VisionSource): void {
    if (!this._sources.includes(source)) this._sources.push(source);
    this._timer = 0; // fold the new source in on the next update
  }

  removeSource(source: VisionSource): void {
    const i = this._sources.indexOf(source);
    if (i !== -1) this._sources.splice(i, 1);
  }

  // ── Queries ────────────────────────────────────────────────────

  /** The team's visibility map (creating it hidden-everywhere on first use). */
  team(team: number): Uint8Array {
    let map = this._teams.get(team);
    if (!map) {
      map = new Uint8Array(this.cellsX * this.cellsZ); // FOG_HIDDEN
      this._teams.set(team, map);
    }
    return map;
  }

  /** Visibility state of a world position for a team. */
  stateAt(team: number, wx: number, wz: number): number {
    const cx = Math.floor((wx - this.originX) / this.cellSize);
    const cz = Math.floor((wz - this.originZ) / this.cellSize);
    if (cx < 0 || cx >= this.cellsX || cz < 0 || cz >= this.cellsZ) return FOG_HIDDEN;
    return this.team(team)[cz * this.cellsX + cx];
  }

  isVisible(team: number, wx: number, wz: number): boolean {
    return this.stateAt(team, wx, wz) === FOG_VISIBLE;
  }

  isExplored(team: number, wx: number, wz: number): boolean {
    return this.stateAt(team, wx, wz) >= FOG_EXPLORED;
  }

  // ── Update ─────────────────────────────────────────────────────

  update(delta: number): void {
    this._timer -= delta;
    if (this._timer > 0) return;
    this._timer = this.recomputeInterval;
    this._recompute();
  }

  /** Force an immediate recompute (e.g. right after setup). */
  recomputeNow(): void {
    this._timer = this.recomputeInterval;
    this._recompute();
  }

  // ── Internal ───────────────────────────────────────────────────

  private _recompute(): void {
    // Currently-visible decays to explored; sources then re-light their cells.
    for (const map of this._teams.values()) {
      for (let i = 0; i < map.length; i++) {
        if (map[i] === FOG_VISIBLE) map[i] = FOG_EXPLORED;
      }
    }
    for (const src of this._sources) {
      if (!src.active) continue;
      this._sweep(this.team(src.team), src);
    }
  }

  /** Mark every cell the source can see as visible. */
  private _sweep(map: Uint8Array, src: VisionSource): void {
    const cx = this._clampCellX(Math.floor((src.position.x - this.originX) / this.cellSize));
    const cz = this._clampCellZ(Math.floor((src.position.z - this.originZ) / this.cellSize));
    const eyeH = this._groundH[cz * this.cellsX + cx] + FogOfWar.EYE_HEIGHT;

    const rCells = Math.ceil(src.sightRadius / this.cellSize);
    const r2 = rCells * rCells;
    const minX = this._clampCellX(cx - rCells);
    const maxX = this._clampCellX(cx + rCells);
    const minZ = this._clampCellZ(cz - rCells);
    const maxZ = this._clampCellZ(cz + rCells);

    for (let tz = minZ; tz <= maxZ; tz++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const dx = tx - cx;
        const dz = tz - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        // Immediate surroundings are always seen, even inside a tree line.
        if (d2 <= 2 || this._lineOfSight(cx, cz, tx, tz, eyeH)) {
          map[tz * this.cellsX + tx] = FOG_VISIBLE;
        }
      }
    }
  }

  /**
   * March the sight line over the blocking heightfield. Endpoints are skipped
   * so a unit hugging a tree still sees its own cell and the tree's.
   */
  private _lineOfSight(cx: number, cz: number, tx: number, tz: number, eyeH: number): boolean {
    const dx = tx - cx;
    const dz = tz - cz;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    if (steps <= 1) return true;

    const targetH = this._groundH[tz * this.cellsX + tx] + FogOfWar.TARGET_HEIGHT;
    const inv = 1 / steps;
    for (let i = 1; i < steps; i++) {
      const t = i * inv;
      const sx = Math.round(cx + dx * t);
      const sz = Math.round(cz + dz * t);
      const lineH = eyeH + (targetH - eyeH) * t;
      if (this._blockH[sz * this.cellsX + sx] > lineH) return false;
    }
    return true;
  }

  private _clampCellX(c: number): number {
    return THREE.MathUtils.clamp(c, 0, this.cellsX - 1);
  }

  private _clampCellZ(c: number): number {
    return THREE.MathUtils.clamp(c, 0, this.cellsZ - 1);
  }
}
