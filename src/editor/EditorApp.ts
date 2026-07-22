/**
 * The map editor: a three.js view built from the game's own renderer
 * pieces (Wc3Terrain, Water, Doodads, IsometricCamera) around a mutable
 * MapSource, plus paint/place tools, undo, and save/playtest.
 *
 * Editing mutates `_src` only; every visual (terrain mesh, water, doodads,
 * pathing overlay, markers) is re-derived from it through the exact same
 * `buildCustomMap` the game loads with — the editor cannot show something
 * the game would disagree with.
 */
import * as THREE from 'three';
import { Renderer } from '../rendering/Renderer';
import { createScene } from '../rendering/Scene';
import { createLighting } from '../rendering/Lighting';
import { IsometricCamera } from '../rendering/Camera';
import { Wc3Terrain } from '../world/Wc3Terrain';
import { Water } from '../world/Water';
import { Doodads } from '../world/Doodads';
import { ObstacleRegistry } from '../world/ObstacleRegistry';
import { buildSimWorld } from '../sim/buildWorld';
import type { SimWorld } from '../sim/world';
import { buildCustomMap, CustomMap } from '../world/custom/buildCustomMap';
import {
  MapSource, DoodadKind, createEmptyMapSource, cloneMapSource, validateMapName,
  SRC_FLAG_RAMP, SRC_FLAG_WATER, pointsX, pointsZ,
} from '../world/custom/mapSource';
import { TILE_SIZE } from '../world/wc3/W3EParser';
import { worldToTile } from '../world/wc3/MapData';
import { RUNE } from '../sim/runeRules';
import { SHOP_ITEMS } from '../sim/shopItems';
import { Overlays, disposeObject } from './overlays';
import { EditorUI } from './ui';
import { ToolId, TOOL_BY_KEY, CAMP_PRESETS, DECO_KINDS, TEXTURES } from './tools';
import { listMaps, loadMapSource, saveMapSource, rememberLastMap, lastMapName } from './store';

const MAX_SPAWNS = 4;
const MAX_CAMPS = 8;
const MAX_RUNES = 6;
const MAX_SHOPS = 4;
const MAX_FOUNTAINS = 4;
/** Min distance between drag-scattered trees. */
const SCATTER_SPACING = 70;
const REBUILD_THROTTLE_MS = 130;

export class EditorApp {
  private _renderer = new Renderer();
  private _scene = createScene();
  private _camera = new IsometricCamera();
  private _overlays = new Overlays();
  private _ui: EditorUI;

  private _src: MapSource = createEmptyMapSource('untitled', 32, 32);
  private _custom!: CustomMap;
  private _world!: SimWorld;
  private _terrain: Wc3Terrain | null = null;
  private _waterView: Water | null = null;
  private _doodadsGroup: THREE.Group | null = null;

  private _tool: ToolId = 'pan';
  private _activeTexture = 2;
  private _campPreset = 1;
  private _decoIndex = 0;
  private _brushSize = 1;
  private _placeAngle = 0;
  private _placeScale = 1;

  private _undo: MapSource[] = [];
  private _redo: MapSource[] = [];
  private _dirty = false;

  private _hover: { wx: number; wz: number } | null = null;
  private _stroke: { targetLayer: number; touched: Set<number> } | null = null;
  private _cameraDrag = false;
  private _lastRebuild = 0;
  private _rebuildTimer: number | null = null;
  private _raycaster = new THREE.Raycaster();

  constructor() {
    this._ui = new EditorUI({
      onSelectTool: (id) => this._setTool(id),
      onSelectTexture: (i) => {
        this._activeTexture = i;
        this._ui.setActiveTexture(i);
      },
      onSelectCampPreset: (i) => {
        this._campPreset = i;
        this._ui.setActiveCampPreset(i);
      },
      onSelectDeco: (i) => {
        this._decoIndex = i;
        this._ui.setActiveDeco(i);
        this._refreshGhost();
      },
      onNewMap: (name, x, z) => this._newMap(name, x, z),
      onLoadMap: (name) => void this._loadMap(name),
      onRename: (name) => this._rename(name),
      onSave: () => void this._save(),
      onPlaytest: () => void this._playtest(),
      onUndo: () => this._popUndo(),
      onRedo: () => this._popRedo(),
      onTogglePathing: () => {
        this._ui.setPathingActive(this._overlays.togglePathing());
      },
    });

    createLighting(this._scene);
    this._scene.add(this._overlays.group);

    const holder = document.getElementById('viewport')!;
    holder.appendChild(this._renderer.domElement);
    this._renderer.resize(holder.clientWidth, holder.clientHeight);

    // Editor framing: allow further zoom-out than gameplay permits.
    (this._camera as unknown as { _minDist: number })._minDist = 400;
    (this._camera as unknown as { _maxDist: number })._maxDist = 9000;
    this._camera.zoom(1200);

    this._bindInput(this._renderer.domElement);
    window.addEventListener('resize', () => this._onResize());

    this._ui.setActiveTool(this._tool);
    this._ui.setActiveTexture(this._activeTexture);
    this._ui.setActiveCampPreset(this._campPreset);
    this._ui.setActiveDeco(this._decoIndex);
    this._ui.setPathingActive(true);
  }

  async start(): Promise<void> {
    const names = await listMaps();
    this._ui.setMapList(names);

    const urlName = new URLSearchParams(location.search).get('map');
    const boot = urlName ?? lastMapName() ?? names[0] ?? null;
    if (boot && names.includes(boot)) {
      await this._loadMap(boot);
    } else {
      this._rebuild('full');
      this._frameMap();
    }

    const tick = () => {
      this._renderer.render(this._scene, this._camera.camera);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    this._updateStatus();
  }

  // ── Map lifecycle ─────────────────────────────────────────────

  private _newMap(name: string, tilesX: number, tilesZ: number): void {
    try {
      validateMapName(name);
      this._src = createEmptyMapSource(name, tilesX, tilesZ);
    } catch (err) {
      this._ui.flash(String(err));
      return;
    }
    this._undo = [];
    this._redo = [];
    this._dirty = true;
    this._rebuild('full');
    this._frameMap();
    this._updateStatus();
  }

  private async _loadMap(name: string): Promise<void> {
    try {
      this._src = await loadMapSource(name);
    } catch (err) {
      this._ui.flash(String(err));
      return;
    }
    rememberLastMap(name);
    this._undo = [];
    this._redo = [];
    this._dirty = false;
    this._rebuild('full');
    this._frameMap();
    this._ui.flash(`loaded '${name}'`);
    this._updateStatus();
  }

  private _rename(name: string): void {
    try {
      validateMapName(name);
    } catch (err) {
      this._ui.flash(String(err));
      this._updateStatus();
      return;
    }
    if (name !== this._src.name) {
      this._src.name = name;
      this._dirty = true;
      this._updateStatus();
    }
  }

  private async _save(): Promise<boolean> {
    try {
      const { jsonBytes, amapBytes } = await saveMapSource(this._src);
      this._dirty = false;
      rememberLastMap(this._src.name);
      this._ui.setMapList(await listMaps());
      this._ui.flash(`saved maps/${this._src.name}.map.json (${jsonBytes} B) + .amap (${amapBytes} B)`);
      this._updateStatus();
      return true;
    } catch (err) {
      this._ui.flash(String(err));
      return false;
    }
  }

  private async _playtest(): Promise<void> {
    if (await this._save()) {
      window.open(`/?map=${encodeURIComponent(this._src.name)}`, '_blank');
    }
  }

  // ── Rebuild pipeline ──────────────────────────────────────────

  /** Re-derive the world from `_src` and swap the affected scene groups. */
  private _rebuild(kind: 'full' | 'doodads'): void {
    this._custom = buildCustomMap(this._src);
    const { data } = this._custom;

    if (kind === 'full' || !this._terrain) {
      if (this._terrain) {
        this._scene.remove(this._terrain.mesh);
        disposeObject(this._terrain.mesh);
      }
      if (this._waterView) {
        this._scene.remove(this._waterView.group);
        disposeObject(this._waterView.group);
      }
      this._terrain = new Wc3Terrain(data);
      this._scene.add(this._terrain.mesh);
      this._waterView = new Water(data);
      this._scene.add(this._waterView.group);
      this._camera.setBounds(data.bounds.minX, data.bounds.minZ, data.bounds.maxX, data.bounds.maxZ);
    }

    if (this._doodadsGroup) {
      this._scene.remove(this._doodadsGroup);
      disposeObject(this._doodadsGroup);
    }
    const heightAt = (x: number, z: number) => this._terrain!.heightAt(x, z);
    const doodads = new Doodads(data, heightAt, new ObstacleRegistry());
    this._doodadsGroup = doodads.group;
    this._scene.add(this._doodadsGroup);

    this._world = buildSimWorld(
      data.pathing,
      { minX: data.bounds.minX, minZ: data.bounds.minZ },
      { ...this._custom.arena },
      data.doodads,
    );
    this._world.obstacles = this._custom.obstacles;

    // Override fountain positions from map source
    this._world.fountains = this._custom.fountains;

    // Override shop positions from map source
    if (this._src.shops.length > 0) {
      // Sync sim world shops array
      this._world.shops = this._src.shops.map((s) => ({
        pos: { x: s.x, z: s.z },
        interactRadius: 85,
        buyRadius: 400,
        items: SHOP_ITEMS,
      }));
    }

    this._overlays.refresh(this._src, this._custom, this._world.navGrid, heightAt);
    this._lastRebuild = performance.now();
  }

  /** Throttled rebuild for mid-stroke feedback. */
  private _requestRebuild(kind: 'full' | 'doodads'): void {
    if (performance.now() - this._lastRebuild >= REBUILD_THROTTLE_MS) {
      this._rebuild(kind);
      return;
    }
    if (this._rebuildTimer === null) {
      this._rebuildTimer = window.setTimeout(() => {
        this._rebuildTimer = null;
        this._rebuild(kind);
      }, REBUILD_THROTTLE_MS);
    }
  }

  private _frameMap(): void {
    const c = this._custom.data.bounds;
    const y = this._terrain ? this._terrain.heightAt(c.centerX, c.centerZ) : 0;
    this._camera.setTarget(new THREE.Vector3(c.centerX, y, c.centerZ));
  }

  // ── Input ─────────────────────────────────────────────────────

  private _bindInput(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2 || this._tool === 'pan') {
        this._cameraDrag = true;
        return;
      }
      if (e.button === 0) this._beginStroke(e.altKey);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this._cameraDrag) {
        const scale = this._camera.target.distanceTo(this._camera.camera.position) / 900;
        this._camera.panScreen(-e.movementX * scale, e.movementY * scale);
        return;
      }
      this._updateHover(e);
      if (this._stroke) this._applyTool(e.altKey, true);
    });

    canvas.addEventListener('pointerup', (e) => {
      canvas.releasePointerCapture(e.pointerId);
      if (this._cameraDrag) {
        this._cameraDrag = false;
        return;
      }
      if (this._stroke) {
        this._stroke = null;
        this._rebuild(this._isTerrainTool() ? 'full' : 'doodads');
        this._updateStatus();
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._camera.zoom(e.deltaY * 1.2);
    }, { passive: false });

    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  private _onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this._save();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this._popRedo();
      else this._popUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this._popRedo();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;

    const key = e.key.toLowerCase();
    switch (key) {
      case 'escape':
        this._setTool('pan');
        return;
      case 'o':
        this._ui.setPathingActive(this._overlays.togglePathing());
        return;
      case '?':
      case 'h':
        this._ui.toggleHelp();
        return;
      case '[':
        this._cycleOption(-1);
        return;
      case ']':
        this._cycleOption(1);
        return;
      case ',':
        this._placeAngle -= Math.PI / 12;
        this._updateStatus();
        return;
      case '.':
        this._placeAngle += Math.PI / 12;
        this._updateStatus();
        return;
      case '-':
        this._adjustSize(-1);
        return;
      case '=':
        this._adjustSize(1);
        return;
      case 'arrowup':
      case 'arrowdown':
      case 'arrowleft':
      case 'arrowright': {
        const step = 80;
        this._camera.panScreen(
          key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0,
          key === 'arrowup' ? step : key === 'arrowdown' ? -step : 0,
        );
        return;
      }
    }
    // WASD pan unless the key selects a tool that shadows it (w = green tree
    // wins; use arrows for pan when placing trees).
    const tool = TOOL_BY_KEY.get(key);
    if (tool) {
      this._setTool(tool);
      return;
    }
    if (key === 'a' || key === 's' || key === 'd') {
      const step = 80;
      this._camera.panScreen(key === 'a' ? -step : key === 'd' ? step : 0, key === 's' ? -step : 0);
    }
  }

  private _cycleOption(dir: number): void {
    if (this._tool === 'paint') {
      this._activeTexture = (this._activeTexture + dir + TEXTURES.length) % TEXTURES.length;
      this._ui.setActiveTexture(this._activeTexture);
    } else if (this._tool === 'camp') {
      this._campPreset = (this._campPreset + dir + CAMP_PRESETS.length) % CAMP_PRESETS.length;
      this._ui.setActiveCampPreset(this._campPreset);
    } else if (this._tool === 'deco') {
      this._decoIndex = (this._decoIndex + dir + DECO_KINDS.length) % DECO_KINDS.length;
      this._ui.setActiveDeco(this._decoIndex);
      this._refreshGhost();
    }
    this._updateStatus();
  }

  private _adjustSize(dir: number): void {
    if (this._isTerrainTool()) {
      this._brushSize = Math.min(4, Math.max(1, this._brushSize + dir));
    } else {
      this._placeScale = Math.min(1.8, Math.max(0.6, Math.round((this._placeScale + dir * 0.1) * 10) / 10));
    }
    this._updateStatus();
  }

  private _setTool(id: ToolId): void {
    this._tool = id;
    this._ui.setActiveTool(id);
    this._refreshGhost();
    this._updateStatus();
  }

  private _isTerrainTool(): boolean {
    return ['raise', 'lower', 'ramp', 'water', 'paint'].includes(this._tool);
  }

  private _placedKind(): DoodadKind | null {
    switch (this._tool) {
      case 'treeDark':
      case 'treeGreen':
      case 'treeTeal':
      case 'rock':
        return this._tool;
      case 'deco':
        return DECO_KINDS[this._decoIndex];
      default:
        return null;
    }
  }

  private _refreshGhost(): void {
    const kind = this._placedKind();
    if (kind) {
      const isTree = kind.startsWith('tree');
      this._overlays.setGhost(isTree ? 'tree' : kind === 'rock' ? 'rock' : 'deco', isTree ? 24 : kind === 'rock' ? 40 : 20);
    } else if (this._tool === 'camp') {
      this._overlays.setGhost('camp', 80);
    } else if (this._tool === 'spawn') {
      this._overlays.setGhost('spawn', 35);
    } else if (this._tool === 'rune') {
      this._overlays.setGhost('rune', RUNE.pickupRadius);
    } else if (this._tool === 'shop') {
      this._overlays.setGhost('shop', 120);
    } else if (this._tool === 'fountain') {
      this._overlays.setGhost('fountain', 200);
    } else {
      this._overlays.setGhost(null, 0);
    }
  }

  // ── Hover + tool application ──────────────────────────────────

  private _updateHover(e: PointerEvent): void {
    if (!this._terrain) return;
    const rect = this._renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(ndc, this._camera.camera);
    const hits = this._raycaster.intersectObject(this._terrain.mesh, true);
    if (hits.length === 0) {
      this._hover = null;
      this._overlays.hideTileHighlight();
      this._overlays.moveGhost(0, 0, 0, false);
      return;
    }
    const p = hits[0].point;
    this._hover = { wx: p.x, wz: p.z };

    const t = this._custom.data.terrain;
    if (this._isTerrainTool()) {
      const { i, j } = this._hoverTile();
      const span = this._brushSpan(i, j);
      this._overlays.showTileHighlight(
        t.offsetX, t.offsetY,
        span.i0, span.j0, span.i1, span.j1,
        (x, z) => this._terrain!.heightAt(x, z),
      );
      this._overlays.moveGhost(0, 0, 0, false);
    } else {
      this._overlays.hideTileHighlight();
      this._overlays.moveGhost(p.x, this._terrain.heightAt(p.x, p.z), p.z, true);
    }
    this._updateStatus();
  }

  private _hoverTile(): { i: number; j: number } {
    const t = this._custom.data.terrain;
    const { u, v } = worldToTile(t, this._hover!.wx, this._hover!.wz);
    return {
      i: Math.min(Math.max(Math.floor(u), 0), this._src.tilesX - 1),
      j: Math.min(Math.max(Math.floor(v), 0), this._src.tilesZ - 1),
    };
  }

  private _beginStroke(alt: boolean): void {
    if (!this._hover || this._tool === 'pan') return;
    this._pushUndo();

    let targetLayer = 0;
    if (this._tool === 'raise' || this._tool === 'lower') {
      const { i, j } = this._hoverTile();
      const px = pointsX(this._src);
      const base = Math.max(
        this._src.layer[j * px + i], this._src.layer[j * px + i + 1],
        this._src.layer[(j + 1) * px + i], this._src.layer[(j + 1) * px + i + 1],
      );
      targetLayer = this._tool === 'raise' ? Math.min(8, base + 1) : Math.max(1, base - 1);
    }
    this._stroke = { targetLayer, touched: new Set() };
    this._applyTool(alt, false);
  }

  private _applyTool(alt: boolean, fromDrag: boolean): void {
    if (!this._hover || !this._stroke) return;

    switch (this._tool) {
      case 'raise':
      case 'lower':
      case 'water':
      case 'paint':
        this._paintTiles(alt);
        this._requestRebuild('full');
        break;
      case 'ramp':
        this._paintRampPoint(alt);
        this._requestRebuild('full');
        break;
      case 'treeDark':
      case 'treeGreen':
      case 'treeTeal':
        if (alt) this._eraseAt();
        else this._placeDoodad(fromDrag);
        this._requestRebuild('doodads');
        break;
      case 'rock':
      case 'deco':
        if (alt) this._eraseAt();
        else if (!fromDrag) this._placeDoodad(false);
        this._requestRebuild('doodads');
        break;
      case 'camp':
        if (!fromDrag) this._placeCamp();
        break;
      case 'spawn':
        if (!fromDrag) this._placeSpawn();
        break;
      case 'rune':
        if (!fromDrag) this._placeRune();
        break;
      case 'shop':
        if (!fromDrag) this._placeShop();
        break;
      case 'fountain':
        if (!fromDrag) this._placeFountain();
        break;
      case 'erase':
        this._eraseAt();
        this._requestRebuild('doodads');
        break;
    }
    this._dirty = true;
  }

  /**
   * Tile span of the active terrain brush. Water paints one extra tile
   * east/south: ponds need ≥2×2 tiles before any tilepoint classifies as
   * interior "floor" and the water surface becomes visible.
   */
  private _brushSpan(ci: number, cj: number): { i0: number; i1: number; j0: number; j1: number } {
    const r = this._brushSize - 1;
    const extra = this._tool === 'water' ? 1 : 0;
    return { i0: ci - r, i1: ci + r + extra, j0: cj - r, j1: cj + r + extra };
  }

  /** Apply the active terrain tool to the brush square around the hover tile. */
  private _paintTiles(alt: boolean): void {
    const { i: ci, j: cj } = this._hoverTile();
    const px = pointsX(this._src);
    const { i0, i1, j0, j1 } = this._brushSpan(ci, cj);

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (i < 0 || j < 0 || i >= this._src.tilesX || j >= this._src.tilesZ) continue;
        const tileKey = j * this._src.tilesX + i;
        if (this._stroke!.touched.has(tileKey)) continue;
        this._stroke!.touched.add(tileKey);

        const corners = [j * px + i, j * px + i + 1, (j + 1) * px + i, (j + 1) * px + i + 1];
        for (const k of corners) {
          switch (this._tool) {
            case 'raise':
              this._src.layer[k] = Math.max(this._src.layer[k], this._stroke!.targetLayer);
              break;
            case 'lower':
              this._src.layer[k] = Math.min(this._src.layer[k], this._stroke!.targetLayer);
              break;
            case 'water':
              if (alt) {
                this._src.flags[k] &= ~SRC_FLAG_WATER;
              } else {
                this._src.flags[k] |= SRC_FLAG_WATER;
                this._src.texture[k] = 1; // rough-dirt pond bed
              }
              break;
            case 'paint':
              this._src.texture[k] = this._activeTexture;
              break;
          }
        }
      }
    }
  }

  private _paintRampPoint(alt: boolean): void {
    const t = this._custom.data.terrain;
    const { u, v } = worldToTile(t, this._hover!.wx, this._hover!.wz);
    const px = pointsX(this._src);
    const pz = pointsZ(this._src);
    const i = Math.min(Math.max(Math.round(u), 0), px - 1);
    const j = Math.min(Math.max(Math.round(v), 0), pz - 1);
    const k = j * px + i;
    if (alt) this._src.flags[k] &= ~SRC_FLAG_RAMP;
    else this._src.flags[k] |= SRC_FLAG_RAMP;
  }

  private _placeDoodad(fromDrag: boolean): void {
    const kind = this._placedKind();
    if (!kind) return;
    const { wx, wz } = this._hover!;

    if (fromDrag) {
      // Scatter: respect spacing so a drag reads as a forest, not a wall.
      const spacing = SCATTER_SPACING * this._placeScale;
      for (const d of this._src.doodads) {
        if (Math.hypot(d.x - wx, d.z - wz) < spacing) return;
      }
    }

    const isTree = kind.startsWith('tree');
    this._src.doodads.push({
      kind,
      x: wx,
      z: wz,
      angle: this._placeAngle,
      scale: this._placeScale,
    });
    // Vary tree angles automatically so hand-planted forests look organic.
    if (isTree) this._placeAngle = (this._placeAngle + 2.39996) % (2 * Math.PI); // golden angle
  }

  private _placeCamp(): void {
    if (this._src.camps.length >= MAX_CAMPS) {
      this._ui.flash(`max ${MAX_CAMPS} camps`);
      return;
    }
    this._src.camps.push({
      x: this._hover!.wx,
      z: this._hover!.wz,
      units: CAMP_PRESETS[this._campPreset].slice(),
    });
    this._rebuild('doodads');
  }

  private _placeSpawn(): void {
    if (this._src.spawns.length >= MAX_SPAWNS) {
      this._ui.flash(`max ${MAX_SPAWNS} spawns`);
      return;
    }
    this._src.spawns.push({ x: this._hover!.wx, z: this._hover!.wz });
    this._rebuild('doodads');
  }

  private _placeRune(): void {
    if (this._src.runes.length >= MAX_RUNES) {
      this._ui.flash(`max ${MAX_RUNES} rune spots`);
      return;
    }
    this._src.runes.push({ x: this._hover!.wx, z: this._hover!.wz });
    this._rebuild('doodads');
  }

  private _placeShop(): void {
    if (this._src.shops.length >= MAX_SHOPS) {
      this._ui.flash(`max ${MAX_SHOPS} shops`);
      return;
    }
    this._src.shops.push({ x: this._hover!.wx, z: this._hover!.wz });
    this._rebuild('doodads');
  }

  private _placeFountain(): void {
    if (this._src.fountains.length >= MAX_FOUNTAINS) {
      this._ui.flash(`max ${MAX_FOUNTAINS} fountains`);
      return;
    }
    this._src.fountains.push({ x: this._hover!.wx, z: this._hover!.wz });
    this._rebuild('doodads');
  }

  private _eraseAt(): void {
    const { wx, wz } = this._hover!;
    const candidates: { dist: number; remove: () => void }[] = [];

    this._src.doodads.forEach((d, i) => {
      const dist = Math.hypot(d.x - wx, d.z - wz);
      if (dist < 60) candidates.push({ dist, remove: () => this._src.doodads.splice(i, 1) });
    });
    this._src.camps.forEach((c, i) => {
      const dist = Math.hypot(c.x - wx, c.z - wz);
      if (dist < 90) candidates.push({ dist, remove: () => this._src.camps.splice(i, 1) });
    });
    this._src.spawns.forEach((s, i) => {
      const dist = Math.hypot(s.x - wx, s.z - wz);
      if (dist < 90) candidates.push({ dist, remove: () => this._src.spawns.splice(i, 1) });
    });
    this._src.runes.forEach((r, i) => {
      const dist = Math.hypot(r.x - wx, r.z - wz);
      if (dist < 90) candidates.push({ dist, remove: () => this._src.runes.splice(i, 1) });
    });
    this._src.shops.forEach((s, i) => {
      const dist = Math.hypot(s.x - wx, s.z - wz);
      if (dist < 120) candidates.push({ dist, remove: () => this._src.shops.splice(i, 1) });
    });
    this._src.fountains.forEach((f, i) => {
      const dist = Math.hypot(f.x - wx, f.z - wz);
      if (dist < 120) candidates.push({ dist, remove: () => this._src.fountains.splice(i, 1) });
    });

    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.dist - b.dist)[0].remove();
  }

  // ── Undo / redo ───────────────────────────────────────────────

  private _pushUndo(): void {
    this._undo.push(cloneMapSource(this._src));
    if (this._undo.length > 100) this._undo.shift();
    this._redo = [];
  }

  private _popUndo(): void {
    const prev = this._undo.pop();
    if (!prev) {
      this._ui.flash('nothing to undo');
      return;
    }
    this._redo.push(cloneMapSource(this._src));
    this._src = prev;
    this._dirty = true;
    this._rebuild('full');
    this._updateStatus();
  }

  private _popRedo(): void {
    const next = this._redo.pop();
    if (!next) {
      this._ui.flash('nothing to redo');
      return;
    }
    this._undo.push(cloneMapSource(this._src));
    this._src = next;
    this._dirty = true;
    this._rebuild('full');
    this._updateStatus();
  }

  // ── Misc ──────────────────────────────────────────────────────

  private _onResize(): void {
    const holder = document.getElementById('viewport')!;
    this._renderer.resize(holder.clientWidth, holder.clientHeight);
    this._camera.camera.aspect = holder.clientWidth / holder.clientHeight;
    this._camera.camera.updateProjectionMatrix();
  }

  private _updateStatus(): void {
    this._ui.setMapInfo(this._src.name, this._src.tilesX, this._src.tilesZ, this._dirty);
    const parts: string[] = [];
    parts.push(`tool: ${this._tool}`);
    if (this._isTerrainTool()) parts.push(`brush ${this._brushSize}`);
    if (this._placedKind()) {
      parts.push(`scale ${this._placeScale.toFixed(1)}`, `angle ${Math.round((this._placeAngle * 180) / Math.PI) % 360}°`);
    }
    if (this._hover) {
      const { i, j } = this._hoverTile();
      parts.push(`tile ${i},${j}`, `xz ${Math.round(this._hover.wx)},${Math.round(this._hover.wz)}`);
    }
    parts.push(
      `${this._src.doodads.length} doodads, ${this._src.camps.length} camps, ` +
      `${this._src.spawns.length} spawns, ${this._src.runes.length} runes, ` +
      `${this._src.shops.length} shops, ${this._src.fountains.length} fountains`,
    );
    this._ui.setStatus(parts.join('  ·  '));
  }
}
