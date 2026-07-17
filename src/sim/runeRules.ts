/**
 * Power-up rune constants — pure data, mirroring `rules.ts` / `creepRules.ts`.
 *
 * Runes (DotA-style) spawn at fixed spots, grant a timed buff to the hero
 * who walks over them, and respawn (with a new random type) on a fixed
 * interval. Spot placements come from the map (editor-authored for custom
 * maps) or from `RUNE_SPOT_DEFS` fractions on the built-in maps.
 */

export type RuneTypeId = 'doubleDamage' | 'haste' | 'invisibility';

/** Wire/codec order — never reorder (indices are serialized). */
export const RUNE_TYPE_IDS: readonly RuneTypeId[] = ['doubleDamage', 'haste', 'invisibility'];

export interface RuneTypeDef {
  /** Display name ("DOUBLE DAMAGE!" pickup text, tooltips). */
  name: string;
  /** Buff duration in seconds. */
  duration: number;
  /** Signature color (rune gem, buff indicator, minimap dot). */
  color: number;
}

export const RUNE_TYPES: Record<RuneTypeId, RuneTypeDef> = {
  // Blue: every hero-dealt hit does double damage.
  doubleDamage: { name: 'Double Damage', duration: 30, color: 0x3388ff },
  // Red: big flat move-speed bonus.
  haste: { name: 'Haste', duration: 20, color: 0xff4433 },
  // Purple: unseen by enemies and creeps; breaks on attacking or casting.
  invisibility: { name: 'Invisibility', duration: 30, color: 0xaa55ff },
};

export const RUNE = {
  /** Seconds from pickup until the spot spawns a fresh (random) rune. */
  respawnInterval: 60,
  /** Walking within this distance of an active rune picks it up. */
  pickupRadius: 60,
  /** Double-damage multiplier applied to hero-dealt damage. */
  ddMultiplier: 2,
  /** Haste: flat move-speed bonus (base 350 → 525). */
  hasteSpeedBonus: 175,
} as const;

// ── Spot placement ────────────────────────────────────────────────────

/** A rune spot as fractions of the arena rect (built-in maps). */
export interface RuneSpotDef {
  fx: number;
  fz: number;
}

/** A rune spot pinned to world coordinates (custom maps author these). */
export interface RunePlacement {
  x: number;
  z: number;
}

// Two spots on the mid vertical axis, like DotA's top/bottom river runes.
// Kept off the arena center so they never collide with the shop.
export const RUNE_SPOT_DEFS: RuneSpotDef[] = [
  { fx: 0.5, fz: 0.2 },
  { fx: 0.5, fz: 0.8 },
];

/** Pick a random rune type with the sim's rng (uniform across all types). */
export function randomRuneType(rng: () => number): RuneTypeId {
  return RUNE_TYPE_IDS[Math.min(RUNE_TYPE_IDS.length - 1, Math.floor(rng() * RUNE_TYPE_IDS.length))];
}
