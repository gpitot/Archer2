/**
 * Base colors for the Ashenvale ground tile types, used by the minimap
 * bake and as the base coats of the procedurally generated ground
 * textures. Original-style hand-picked greens/browns — all art here is
 * self-created.
 */
export const TILE_BASE_COLORS: Record<string, [number, number, number]> = {
  Adrt: [122, 90, 58],   // dirt
  Adrd: [100, 72, 46],   // rough dirt
  Agrs: [74, 122, 48],   // grass
  Arck: [128, 124, 116], // rock
  Agrd: [96, 106, 50],   // grassy dirt
  Avin: [52, 84, 44],    // vines
  Adrg: [42, 74, 52],    // dark grass (dominant Ashenvale ground)
  Alvd: [86, 76, 40],    // leaves
};

export const WATER_SHALLOW: [number, number, number] = [40, 90, 120];
export const WATER_DEEP: [number, number, number] = [25, 60, 100];
