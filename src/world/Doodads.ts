import * as THREE from 'three';
import { MapData } from './wc3/MapData';
import { DoodadPlacement } from './wc3/DooParser';
import { isCellWalkable } from './wc3/WpmParser';
import { ObstacleRegistry } from './ObstacleRegistry';

/** Solid doodad footprint, exported for fog sight blockers. */
export interface SolidDoodad {
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  height: number;
}

type Style = 'treeDark' | 'treeGreen' | 'treeTeal' | 'rock' | 'bush' | 'flower' | 'mushroom';

/**
 * Visual style per original doodad type. Solidity does NOT come from this
 * table — it is read from the editor-baked pathing map cell under each
 * placement, which already encodes exactly which doodads block movement.
 */
const STYLE_BY_TYPE: Record<string, Style> = {
  ATtr: 'treeDark',   // Ashenvale tree wall
  LTlt: 'treeGreen',  // Lordaeron summer tree
  YTpb: 'treeTeal',
  YTfc: 'treeGreen',
  ZPfw: 'bush',       // fern/undergrowth
  ZPsh: 'bush',
  ARrk: 'rock',
  LRrk: 'rock',
  APms: 'mushroom',
  AWfl: 'flower',
  ZWsw: 'flower',
  LPcr: 'rock',
};

const TREE_STYLES: Style[] = ['treeDark', 'treeGreen', 'treeTeal'];

/**
 * All ~9.8k doodads of the original map, rendered as instanced low-poly
 * props (self-created geometry — trunk/canopy cones, squashed icosahedron
 * rocks, sphere bushes). Placements, rotations, and scales come from the
 * original placement file; each prop sits on the rebuilt terrain surface.
 *
 * Doodads standing on pathing-blocked cells are treated as solid: they get
 * an AABB in the ObstacleRegistry so arrows collide (movement is already
 * blocked by the pathing-driven nav grid).
 */
export class Doodads {
  readonly group: THREE.Group;
  readonly solids: SolidDoodad[] = [];

  constructor(
    map: MapData,
    heightAt: (x: number, z: number) => number,
    registry: ObstacleRegistry,
  ) {
    this.group = new THREE.Group();
    this.group.name = 'doodads';

    // Bucket placements by resolved style.
    const byStyle = new Map<Style, { d: DoodadPlacement; solid: boolean }[]>();
    const disagreements = new Map<string, { solid: number; open: number }>();

    for (const d of map.doodads) {
      const wx = d.x;
      const wz = -d.y;
      const col = Math.floor((d.x - map.terrain.offsetX) / 32);
      const row = Math.floor((d.y - map.terrain.offsetY) / 32);
      const solid = !isCellWalkable(map.pathing, col, row);

      let style = STYLE_BY_TYPE[d.typeId];
      if (!style) {
        // Unknown types (custom doodads etc.): solid ones read as trees,
        // open ones as bushes.
        style = solid ? TREE_STYLES[hash(d.typeId) % 3] : 'bush';
      }

      const stats = disagreements.get(d.typeId) ?? { solid: 0, open: 0 };
      if (solid) stats.solid++;
      else stats.open++;
      disagreements.set(d.typeId, stats);

      let list = byStyle.get(style);
      if (!list) {
        list = [];
        byStyle.set(style, list);
      }
      list.push({ d, solid });

      if (solid && (style === 'treeDark' || style === 'treeGreen' || style === 'treeTeal' || style === 'rock')) {
        const isTree = style !== 'rock';
        const halfW = (isTree ? 48 : 40) * d.scaleX;
        const halfD = (isTree ? 48 : 40) * d.scaleY;
        const height = (isTree ? 170 : 50) * d.scaleZ;
        const y = heightAt(wx, wz);
        registry.register(new THREE.Vector3(wx, y + height / 2, wz), halfW, height, halfD);
        this.solids.push({ x: wx, z: wz, halfW, halfD, height });
      }
    }

    for (const [style, list] of byStyle) {
      this._buildStyle(style, list, heightAt);
    }

    const summary = [...byStyle.entries()]
      .map(([s, l]) => `${s}:${l.length}`)
      .join(' ');
    console.info(`[doodads] ${map.doodads.length} placed (${summary}), ${this.solids.length} solid`);
    void disagreements;
  }

  /** Build the InstancedMeshes for one visual style. */
  private _buildStyle(
    style: Style,
    list: { d: DoodadPlacement; solid: boolean }[],
    heightAt: (x: number, z: number) => number,
  ): void {
    const parts = buildStyleParts(style);
    const count = list.length;

    const meshes = parts.map((part) => {
      const m = new THREE.InstancedMesh(part.geometry, part.material, count);
      m.name = `doodads-${style}-${part.name}`;
      m.castShadow = false;
      m.receiveShadow = false;
      return m;
    });

    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const { d } = list[i];
      const wx = d.x;
      const wz = -d.y;
      const y = heightAt(wx, wz);

      quat.setFromAxisAngle(up, d.angle);
      // WC3 z-scale is vertical → three.js y.
      scale.set(d.scaleX, d.scaleZ, d.scaleY);
      pos.set(wx, y, wz);
      matrix.compose(pos, quat, scale);

      // Deterministic per-instance tint jitter from the variation index.
      const jitter = 0.85 + ((hash(d.typeId) + d.variation * 37 + i * 13) % 100) / 100 * 0.3;
      color.setScalar(jitter);

      for (const m of meshes) {
        m.setMatrixAt(i, matrix);
        m.setColorAt(i, color);
      }
    }

    for (const m of meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.group.add(m);
    }
  }
}

interface StylePart {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

function mat(color: number, roughness = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, flatShading: true });
}

/** Low-poly component geometry per style (all self-created primitives). */
function buildStyleParts(style: Style): StylePart[] {
  switch (style) {
    case 'treeDark':
      return treeParts(0x4a3826, 0x1e3d30, 0x2a4f3e);
    case 'treeGreen':
      return treeParts(0x54402a, 0x2d5a27, 0x3d6e33);
    case 'treeTeal':
      return treeParts(0x443a30, 0x28494f, 0x34595c);
    case 'rock': {
      const geo = new THREE.IcosahedronGeometry(30, 0);
      geo.scale(1, 0.62, 0.85);
      geo.translate(0, 16, 0);
      return [{ name: 'rock', geometry: geo, material: mat(0x8a867c) }];
    }
    case 'bush': {
      const a = new THREE.IcosahedronGeometry(20, 1);
      a.scale(1, 0.72, 1);
      a.translate(0, 13, 0);
      const b = new THREE.IcosahedronGeometry(13, 1);
      b.scale(1, 0.75, 1);
      b.translate(14, 9, 6);
      return [
        { name: 'main', geometry: a, material: mat(0x2c4c26) },
        { name: 'side', geometry: b, material: mat(0x38622e) },
      ];
    }
    case 'flower': {
      const stem = new THREE.CylinderGeometry(1.2, 1.6, 10, 5);
      stem.translate(0, 5, 0);
      const bloom = new THREE.IcosahedronGeometry(5, 0);
      bloom.translate(0, 12, 0);
      return [
        { name: 'stem', geometry: stem, material: mat(0x3e6a34) },
        { name: 'bloom', geometry: bloom, material: mat(0xc9a9d6) },
      ];
    }
    case 'mushroom': {
      const stem = new THREE.CylinderGeometry(4, 5.5, 14, 6);
      stem.translate(0, 7, 0);
      const cap = new THREE.SphereGeometry(11, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.translate(0, 13, 0);
      return [
        { name: 'stem', geometry: stem, material: mat(0xcfc4a8) },
        { name: 'cap', geometry: cap, material: mat(0x7c4a3a) },
      ];
    }
  }
}

/** Trunk + two stacked canopy cones — reads as a WC3 conifer. */
function treeParts(trunkColor: number, canopyColor: number, topColor: number): StylePart[] {
  const trunk = new THREE.CylinderGeometry(6, 10, 60, 6);
  trunk.translate(0, 30, 0);
  const canopy = new THREE.ConeGeometry(46, 95, 7);
  canopy.translate(0, 100, 0);
  const top = new THREE.ConeGeometry(30, 62, 6);
  top.translate(0, 155, 0);
  return [
    { name: 'trunk', geometry: trunk, material: mat(trunkColor) },
    { name: 'canopy', geometry: canopy, material: mat(canopyColor) },
    { name: 'top', geometry: top, material: mat(topColor) },
  ];
}

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}
