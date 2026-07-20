/**
 * Gameplay constants and per-level tables shared by the server sim and the
 * client. Everything here is pure data — no `three`, no DOM. These values were
 * lifted verbatim from the original `Hero` and `ArrowAbility` classes so the
 * headless sim reproduces single-player behaviour exactly.
 */

// ── Hero ──────────────────────────────────────────────────────────────
export const HERO = {
  maxHp: 625,
  /** Max HP gained per hero level (after level 1). */
  hpPerLevel: 30,
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

/** Max HP for a hero at a given level (1..maxLevel). */
export function maxHpForLevel(level: number): number {
  return HERO.maxHp + HERO.hpPerLevel * (level - 1);
}

/** Max HP including permanent bonuses from tomes. */
export function heroMaxHp(level: number, bonusHp: number): number {
  return maxHpForLevel(level) + bonusHp;
}

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

/** Kill-spree bonus gold, indexed by kill streak. (Disabled — all zero.) */
export const SPREE_BONUS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/** Bounty gold for ending a victim's streak, indexed by that streak length. */
export const BOUNTY_TABLE = [0, 0, 100, 150, 200, 350, 500, 650, 800, 900, 1000];

export const KILL_GOLD = { base: 200, firstBlood: 150, doubleKill: 200, tripleKill: 400 } as const;
/** Seconds within which consecutive kills chain into a multi-kill. */
export const MULTI_KILL_WINDOW = 7;

// ── Shoot Arrow ability (Q) ───────────────────────────────────────────
export const ARROW = {
  /** Damage per ability level (index 0 = unlearned). */
  damageByLevel: [0, 200, 300, 400, 500, 600],
  /**
   * Per-charge recharge time per ability level (seconds). Halved from the
   * original per-shot cooldown [2.25, 2.0, 1.75, 1.5, 1.25]: the original
   * bound *two* identical "Shoot Arrow" copies to the attack key, each with
   * its own cooldown ticking in parallel, so the sustained rate was two
   * arrows per per-shot-cooldown. Our single Q holds two charges, so halving
   * the recharge reproduces that parallel-cooldown sustained fire rate.
   */
  cooldownByLevel: [0, 1.125, 1.0, 0.875, 0.75, 0.625],
  /** Max flight range per ability level (fixed at 800 for all ranks). */
  rangeByLevel: [0, 800, 800, 800, 800, 800],
  maxLevel: 5,
  /** Maximum number of charges the ability holds. */
  maxCharges: 2,
  /**
   * Cast point (seconds): the archer must stand still for this long after the
   * order before the arrow looses. Issuing any fresh order during it cancels
   * the shot with no charge spent — the original hero unit's 0.3s cast point.
   */
  windup: 0.3,
  /** Minimum delay between consecutive shots when a charge is available (seconds). */
  recoilTime: 0.2,
  speed: 900,
  /**
   * Projectile collision radius (world units). Widened from 8 toward the
   * original arrow's thicker hitbox: the WC3 arrow's ≈60u enum radius scales
   * to ≈48u hit radius at our 0.8× distance scale, so bodyRadius 27 + 16 ≈ 43
   * lands close to it while keeping arrows dodgeable (this is the enemy's
   * hitbox against arrows and the arrow's own clearance past obstacles).
   */
  collisionRadius: 16,
  /** Distance in front of the hero the arrow spawns (0.8 × mesh scale of 60). */
  spawnOffset: 48,
  /** Height above terrain the arrow rides (presentation only). */
  flyHeight: 22,
} as const;

// ── Dodge ability (W) ────────────────────────────────────────────────
export const DODGE = {
  /** Dodge window duration (fixed at 0.8s for all ranks). */
  durationByLevel: [0, 0.8, 0.8, 0.8, 0.8, 0.8],
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
  /** Fog reveal radius around the projectile per rank (index 0 = unlearned). */
  sightRadiusByLevel: [0, 800, 1000, 1200, 1400, 1600],
  /**
   * The revealed bubble lingers behind the projectile: a breadcrumb vision
   * source (same radius) is dropped every `trailSpacing` units of flight and
   * stays lit for `trailDuration` seconds — the scout paints a fat, slowly
   * fading corridor across the map instead of a fleeting dot.
   */
  trailDuration: 4,
  trailSpacing: 400,
  /** Flight range (fixed at 5000 for all ranks; index 0 = unlearned). */
  rangeByLevel: [0, 5000, 5000, 5000, 5000, 5000],
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
  cooldownByLevel: [0, 8, 6, 4],
  maxLevel: 3,
} as const;

// ── Fountains ──────────────────────────────────────────────────────────
/** Healing fountain: WC3 fountain-of-health behaviour. */
export const FOUNTAIN = {
  /** How close a hero must stand to receive healing (world units). */
  healRadius: 200,
  /** HP restored per second while standing in the aura. */
  healPerSecond: 15,
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
