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
  maxLevel: 10,
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
export const XP_TABLE = [0, 0, 200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400];

/** XP a killer earns for slaying a hero of the given level (index = victim level). */
export const KILL_XP_TABLE = [0, 100, 120, 160, 220, 300, 300, 300, 300, 300, 300];

/** Passive gold/second floor & ceiling. */
export const PASSIVE_INCOME = { base: 5, min: 1, max: 30 } as const;

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
  damageByLevel: [0, 200, 266, 333, 400],
  /** Max flight range per ability level. */
  rangeByLevel: [0, 800, 1333, 1866, 2400],
  /** Cooldown per ability level (seconds). */
  cooldownByLevel: [0, 2.25, 2.0, 1.75, 1.5],
  maxLevel: 4,
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
  durationByLevel: [0, 0.8, 1.0, 1.25, 1.5],
  /** Cooldown per level (seconds). */
  cooldownByLevel: [0, 8, 7, 6, 5],
  maxLevel: 4,
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
