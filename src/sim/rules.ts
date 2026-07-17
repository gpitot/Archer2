/**
 * Gameplay constants and per-level tables shared by the server sim and the
 * client. Everything here is pure data — no `three`, no DOM. These values were
 * lifted verbatim from the original `Hero` and `ArrowAbility` classes so the
 * headless sim reproduces single-player behaviour exactly.
 */

// ── Hero ──────────────────────────────────────────────────────────────
export const HERO = {
  maxHp: 625,
  baseSpeed: 350,
  /** Fog-of-war sight radius (world units) — WC3 hero daytime sight. */
  sightRadius: 900,
  /** Collision radius used for projectile hit tests (0.45 × mesh scale of 60). */
  bodyRadius: 27,
  maxLevel: 18,
  respawnDelay: 3,
  /** Invulnerability granted on respawn (seconds). */
  respawnInvuln: 1.5,
  /** Facing turn rate (radians/second). */
  turnSpeed: 12,
  /** Distance at which a waypoint counts as reached (world units). */
  arriveEpsilon: 0.1,
  /** Height offset the render layer lifts the hero above the terrain. */
  groundOffset: 0.5,
} as const;

/** Total XP required to have reached each level (index = level, 1-based). */
export const XP_TABLE = [
  0, 0, 200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400,
  6500, 7700, 9000, 10400, 11900, 13500, 15200, 17000,
];

/** XP a killer earns for slaying a hero of the given level (index = victim level). */
export const KILL_XP_TABLE = [
  0, 100, 120, 160, 220, 300, 300, 300, 300, 300, 300,
  300, 300, 300, 300, 300, 300, 300, 300,
];

// ── Skill-point gates (LoL model) ───────────────────────────────

/** Max rank a basic ability (Q/W/E) may reach at the given hero level. */
export function basicRankCap(level: number): number {
  return Math.min(5, Math.ceil(level / 2));
}

/** Max rank the ultimate (R) may reach: 1 at level 6, 2 at 11, 3 at 16. */
export function ultimateRankCap(level: number): number {
  if (level >= 16) return 3;
  if (level >= 11) return 2;
  if (level >= 6) return 1;
  return 0;
}

/** Passive gold/second: ~1/s baseline, small catch-up ceiling when far behind. */
export const PASSIVE_INCOME = { min: 1, max: 5 } as const;

/** Kill-spree bonus gold, indexed by kill streak. */
export const SPREE_BONUS = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 7];
/** Bounty gold for ending a victim's streak, indexed by that streak length. */
export const BOUNTY_TABLE = [0, 0, 0, 0, 1, 3, 6, 10, 15, 21, 28];

export const KILL_GOLD = { base: 5, firstBlood: 5, doubleKill: 15, tripleKill: 30 } as const;
/** Seconds within which consecutive kills chain into a multi-kill. */
export const MULTI_KILL_WINDOW = 0.5;

// ── Shoot Arrow ability (Q) ───────────────────────────────────────────
export const ARROW = {
  /** Damage per ability level (index 0 = unlearned). */
  damageByLevel: [0, 200, 266, 333, 400, 466],
  /** Max flight range per ability level. */
  rangeByLevel: [0, 800, 1333, 1866, 2400, 2933],
  /** Cooldown per ability level (seconds) — also the recharge time per charge. */
  cooldownByLevel: [0, 2.25, 2.0, 1.75, 1.5, 1.25],
  maxLevel: 5,
  /** Maximum number of charges the ability holds. */
  maxCharges: 2,
  /** Minimum delay between consecutive shots when a charge is available (seconds). */
  recoilTime: 0.2,
  speed: 900,
  /** Projectile collision radius (world units). */
  collisionRadius: 8,
  /** Distance in front of the hero the arrow spawns (0.8 × mesh scale of 60). */
  spawnOffset: 48,
  /** Height above terrain the arrow rides (presentation only). */
  flyHeight: 22,
} as const;

// ── Dodge ability (W) ────────────────────────────────────────────────
export const DODGE = {
  /** Dodge window duration per level. */
  durationByLevel: [0, 0.8, 1.0, 1.25, 1.5, 1.75],
  /** Cooldown per level (seconds). */
  cooldownByLevel: [0, 8, 7, 6, 5, 4],
  maxLevel: 5,
} as const;

// ── Scout ability (E) ────────────────────────────────────────────────
// A vision-granting projectile: flies in a straight line, deals no damage,
// ignores collision (soars over trees and units), and reveals fog around
// itself for the caster's team while in flight. The projectile itself is
// never fog-hidden, so enemy heroes always see it coming.
export const SCOUT = {
  /** Flight speed (world units / s). */
  speed: 1000,
  /** Fog reveal radius around the projectile while in flight. */
  sightRadius: 800,
  /**
   * The revealed bubble lingers behind the projectile: a breadcrumb vision
   * source (same radius) is dropped every `trailSpacing` units of flight and
   * stays lit for `trailDuration` seconds — the scout paints a fat, slowly
   * fading corridor across the map instead of a fleeting dot.
   */
  trailDuration: 4,
  trailSpacing: 400,
  /** Flight range per rank (index 0 = unlearned) — long, grows per rank. */
  rangeByLevel: [0, 1600, 2000, 2400, 2800, 3200],
  /** Cooldown per rank (seconds) — shrinks per rank. */
  cooldownByLevel: [0, 22, 19, 16, 13, 10],
  maxLevel: 5,
} as const;

// ── Blast ability (R) ────────────────────────────────────────────────
export const BLAST = {
  /** Max distance from the hero the blast can be targeted. */
  castRange: 900,
  /** Damage radius around the target point. */
  radius: 250,
  /** Seconds between the cast (circle appears) and the explosion. */
  delay: 1.5,
  /** Damage per rank (index 0 = unlearned). */
  damageByLevel: [0, 300, 425, 550],
  /** Cooldown per rank (seconds). */
  cooldownByLevel: [0, 20, 17, 14],
  maxLevel: 3,
} as const;

// ── Wards ─────────────────────────────────────────────────────────────
export const WARD = {
  /** WC3 Observer Ward sight range. */
  sightRadius: 1600,
  duration: 300,
  /** Max distance the hero can place a ward from their position. */
  placeRange: 100,
  /** Collision radius for obstacle check when placing (prevents inside trees). */
  placementRadius: 10,
} as const;
