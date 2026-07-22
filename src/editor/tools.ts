/**
 * Editor tool catalogue: ids, hotkeys, labels, and the option lists the
 * context row cycles through ([ / ]). Pure data — behavior lives in
 * EditorApp.
 */
import type { CreepTypeId } from '../sim/creepRules';
import type { DoodadKind } from '../world/custom/mapSource';

export type ToolId =
  | 'pan'
  | 'raise' | 'lower' | 'ramp' | 'water' | 'paint'
  | 'treeDark' | 'treeGreen' | 'treeTeal' | 'rock' | 'deco'
  | 'camp' | 'spawn' | 'rune' | 'shop' | 'fountain' | 'erase';

export interface ToolInfo {
  id: ToolId;
  key: string;
  label: string;
  hint: string;
}

export const TOOLS: ToolInfo[] = [
  { id: 'pan', key: 'Esc', label: 'Pan / inspect', hint: 'drag pans the camera' },
  { id: 'raise', key: '1', label: 'Raise cliff', hint: 'drag paints tiles one layer up (Alt: sample tile)' },
  { id: 'lower', key: '2', label: 'Lower cliff', hint: 'drag paints tiles one layer down' },
  { id: 'ramp', key: '3', label: 'Ramp flags', hint: 'paint 2 tilepoints across a cliff edge to open a ramp (Alt erases)' },
  { id: 'water', key: '4', label: 'Water', hint: 'drag paints pond tiles (Alt erases)' },
  { id: 'paint', key: '5', label: 'Texture', hint: 'drag paints the selected ground texture' },
  { id: 'treeDark', key: 'Q', label: 'Dark tree', hint: 'click / drag-scatter; blocks pathing + sight' },
  { id: 'treeGreen', key: 'W', label: 'Green tree', hint: 'click / drag-scatter; blocks pathing + sight' },
  { id: 'treeTeal', key: 'E', label: 'Teal tree', hint: 'click / drag-scatter; blocks pathing + sight' },
  { id: 'rock', key: 'R', label: 'Solid rock', hint: 'blocks pathing, sight AND arrows' },
  { id: 'deco', key: 'T', label: 'Decoration', hint: 'cosmetic only ([ ] cycles bush/flower/mushroom)' },
  { id: 'camp', key: 'C', label: 'Creep camp', hint: 'places a jungle camp ([ ] cycles composition)' },
  { id: 'spawn', key: 'P', label: 'Hero spawn', hint: 'numbered spawn points' },
  { id: 'rune', key: 'U', label: 'Rune spot', hint: 'power-up rune spawn location' },
  { id: 'shop', key: 'S', label: 'Shop', hint: 'place a shop building where heroes can buy items' },
  { id: 'fountain', key: 'F', label: 'Healing spring', hint: 'heals nearby heroes' },
  { id: 'erase', key: 'X', label: 'Erase', hint: 'click/drag removes the nearest placed object' },
];

export const TOOL_BY_KEY = new Map<string, ToolId>(
  TOOLS.filter((t) => t.id !== 'pan').map((t) => [t.key.toLowerCase(), t.id]),
);

export const DECO_KINDS: DoodadKind[] = ['bush', 'flower', 'mushroom'];

export const CAMP_PRESETS: CreepTypeId[][] = [
  ['ghoul'],
  ['ghoul', 'ghoul'],
  ['dragon'],
  ['ghoul', 'dragon'],
  ['ghoul', 'ghoul', 'dragon'],
];

export function campPresetLabel(units: readonly CreepTypeId[]): string {
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u, (counts.get(u) ?? 0) + 1);
  return [...counts.entries()].map(([u, n]) => (n > 1 ? `${n}× ${u}` : u)).join(' + ');
}

/** Ashenvale ground palette (w3e texture indices) with swatch colors. */
export const TEXTURES = [
  { index: 0, id: 'Adrt', label: 'Dirt', color: '#8a6a48' },
  { index: 1, id: 'Adrd', label: 'Rough dirt', color: '#7a5c40' },
  { index: 2, id: 'Agrs', label: 'Grass', color: '#4d7a35' },
  { index: 3, id: 'Arck', label: 'Rock', color: '#7d7a72' },
  { index: 4, id: 'Agrd', label: 'Grassy dirt', color: '#6c6f3f' },
  { index: 5, id: 'Avin', label: 'Vines', color: '#3f6b44' },
  { index: 6, id: 'Adrg', label: 'Dark grass', color: '#33552c' },
  { index: 7, id: 'Alvd', label: 'Leaves', color: '#4a5f33' },
] as const;
