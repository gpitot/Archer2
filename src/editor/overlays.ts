/**
 * Editor-only 3D overlays: the derived-pathing view (the editor's most
 * important feedback — pathing is never hand-authored), camp/spawn markers
 * with aggro radii, the hovered-tile highlight, and the placement ghost.
 */
import * as THREE from 'three';
import type { NavGrid } from '../navigation/NavGrid';
import type { CustomMap } from '../world/custom/buildCustomMap';
import type { MapSource } from '../world/custom/mapSource';
import { CREEP_TYPES } from '../sim/creepRules';
import { RUNE } from '../sim/runeRules';
import { TILE_SIZE } from '../world/wc3/W3EParser';

type HeightAt = (x: number, z: number) => number;

export class Overlays {
  readonly group = new THREE.Group();

  private _pathing: THREE.InstancedMesh | null = null;
  private _markers = new THREE.Group();
  private _highlight: THREE.LineLoop;
  private _ghost = new THREE.Group();
  private _pathingVisible = true;

  constructor() {
    this.group.name = 'editor-overlays';
    this.group.add(this._markers);

    const highlightGeo = new THREE.BufferGeometry();
    highlightGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
    this._highlight = new THREE.LineLoop(
      highlightGeo,
      new THREE.LineBasicMaterial({ color: 0xffee66, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this._highlight.renderOrder = 30;
    this._highlight.visible = false;
    this.group.add(this._highlight);

    this._ghost.visible = false;
    this.group.add(this._ghost);
  }

  get pathingVisible(): boolean {
    return this._pathingVisible;
  }

  togglePathing(): boolean {
    this._pathingVisible = !this._pathingVisible;
    if (this._pathing) this._pathing.visible = this._pathingVisible;
    return this._pathingVisible;
  }

  /** Rebuild the blocked-cell quads and camp/spawn markers. */
  refresh(src: MapSource, custom: CustomMap, navGrid: NavGrid, heightAt: HeightAt): void {
    this._rebuildPathing(navGrid, heightAt);
    this._rebuildMarkers(src, heightAt);
  }

  private _rebuildPathing(navGrid: NavGrid, heightAt: HeightAt): void {
    if (this._pathing) {
      this.group.remove(this._pathing);
      this._pathing.geometry.dispose();
      (this._pathing.material as THREE.Material).dispose();
      this._pathing = null;
    }

    const blocked: { wx: number; wz: number }[] = [];
    for (let gz = 0; gz < navGrid.height; gz++) {
      for (let gx = 0; gx < navGrid.width; gx++) {
        if (!navGrid.isWalkable(gx, gz)) blocked.push(navGrid.gridToWorld(gx, gz));
      }
    }

    const cell = navGrid.cellSize;
    const geo = new THREE.PlaneGeometry(cell * 0.92, cell * 0.92);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xdd3333,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, blocked.length);
    mesh.name = 'pathing-overlay';
    const m = new THREE.Matrix4();
    for (let i = 0; i < blocked.length; i++) {
      const b = blocked[i];
      m.makeTranslation(b.wx, heightAt(b.wx, b.wz) + 1.5, b.wz);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 10;
    mesh.visible = this._pathingVisible;
    this._pathing = mesh;
    this.group.add(mesh);
  }

  private _rebuildMarkers(src: MapSource, heightAt: HeightAt): void {
    disposeChildren(this._markers);

    for (const camp of src.camps) {
      const y = heightAt(camp.x, camp.z);
      const marker = new THREE.Group();
      marker.position.set(camp.x, y, camp.z);

      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(40, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xcc4444, transparent: true, opacity: 0.75, depthWrite: false }),
      );
      disc.position.y = 2;
      disc.renderOrder = 20;
      marker.add(disc);

      // Aggro reach: the widest unit's radius, flat on the ground.
      const aggro = Math.max(...camp.units.map((u) => CREEP_TYPES[u].aggroRange));
      const ring = new THREE.LineLoop(
        circleGeometry(aggro, 48),
        new THREE.LineBasicMaterial({ color: 0xcc6666, transparent: true, opacity: 0.5 }),
      );
      ring.position.y = 2;
      marker.add(ring);

      this._markers.add(marker);
    }

    src.spawns.forEach((s, idx) => {
      const y = heightAt(s.x, s.z);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(22, 60, 8),
        new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x4488cc : 0x66aadd }),
      );
      cone.position.set(s.x, y + 30, s.z);
      this._markers.add(cone);

      const ring = new THREE.LineLoop(
        circleGeometry(35, 24),
        new THREE.LineBasicMaterial({ color: 0x4488cc }),
      );
      ring.position.set(s.x, y + 2, s.z);
      this._markers.add(ring);
    });

    // Rune spots: floating gem stand-in + pickup-radius ring.
    for (const r of src.runes) {
      const y = heightAt(r.x, r.z);
      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(14, 0),
        new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.9 }),
      );
      gem.scale.y = 1.5;
      gem.position.set(r.x, y + 26, r.z);
      this._markers.add(gem);

      const ring = new THREE.LineLoop(
        circleGeometry(RUNE.pickupRadius, 32),
        new THREE.LineBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.6 }),
      );
      ring.position.set(r.x, y + 2, r.z);
      this._markers.add(ring);
    }

    // Shop placements: gold pillar stand-in + interact-radius ring.
    for (const s of src.shops) {
      const y = heightAt(s.x, s.z);
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(5, 6, 30, 8),
        new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.8 }),
      );
      pillar.position.set(s.x, y + 15, s.z);
      this._markers.add(pillar);

      const ring = new THREE.LineLoop(
        circleGeometry(120, 40),
        new THREE.LineBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.5 }),
      );
      ring.position.set(s.x, y + 2, s.z);
      this._markers.add(ring);
    }
  }

  // ── Hover highlight ───────────────────────────────────────────

  /** Outline the tile span [i0..i1]×[j0..j1] at terrain height. */
  showTileHighlight(
    offsetX: number, offsetY: number,
    i0: number, j0: number, i1: number, j1: number,
    heightAt: HeightAt,
  ): void {
    const x0 = offsetX + i0 * TILE_SIZE;
    const x1 = offsetX + (i1 + 1) * TILE_SIZE;
    const zS = -(offsetY + j0 * TILE_SIZE);
    const zN = -(offsetY + (j1 + 1) * TILE_SIZE);
    const pos = this._highlight.geometry.getAttribute('position') as THREE.BufferAttribute;
    const corners: [number, number][] = [[x0, zS], [x1, zS], [x1, zN], [x0, zN]];
    corners.forEach(([x, z], i) => pos.setXYZ(i, x, heightAt(x, z) + 2, z));
    pos.needsUpdate = true;
    this._highlight.visible = true;
  }

  hideTileHighlight(): void {
    this._highlight.visible = false;
  }

  // ── Placement ghost ───────────────────────────────────────────

  /** Simple stand-in shown under the cursor for placement tools. */
  setGhost(kind: 'tree' | 'rock' | 'deco' | 'camp' | 'spawn' | 'rune' | 'shop' | null, radius: number): void {
    disposeChildren(this._ghost);
    if (!kind) {
      this._ghost.visible = false;
      return;
    }

    const mat = new THREE.MeshBasicMaterial({
      color: kind === 'camp' ? 0xcc4444 : kind === 'spawn' ? 0x4488cc : kind === 'rune' ? 0xffcc33 : kind === 'shop' ? 0xffcc44 : 0x66cc66,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    let mesh: THREE.Mesh;
    switch (kind) {
      case 'tree':
        mesh = new THREE.Mesh(new THREE.ConeGeometry(46, 150, 7), mat);
        mesh.position.y = 75;
        break;
      case 'rock':
        mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(30, 0), mat);
        mesh.position.y = 16;
        break;
      case 'rune':
        mesh = new THREE.Mesh(new THREE.OctahedronGeometry(14, 0), mat);
        mesh.scale.y = 1.5;
        mesh.position.y = 26;
        break;
      case 'shop':
        mesh = new THREE.Mesh(new THREE.ConeGeometry(14, 30, 8), mat);
        mesh.position.y = 15;
        break;
      default:
        mesh = new THREE.Mesh(new THREE.SphereGeometry(20, 12, 8), mat);
        mesh.position.y = 20;
    }
    this._ghost.add(mesh);

    const ring = new THREE.LineLoop(
      circleGeometry(radius, 32),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 }),
    );
    ring.position.y = 2;
    this._ghost.add(ring);
  }

  moveGhost(x: number, y: number, z: number, visible: boolean): void {
    this._ghost.visible = visible && this._ghost.children.length > 0;
    this._ghost.position.set(x, y, z);
  }
}

function circleGeometry(radius: number, segments: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

export function disposeChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) m.dispose();
  });
}
