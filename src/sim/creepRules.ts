/**
 * Jungle creep constants and stat curves — pure data, mirroring `rules.ts`.
 *
 * Creeps come in a roster of archetypes (`CREEP_TYPES`): melee monsters that
 * chase and claw, and ranged monsters that stand off and spit fireballs. Each
 * archetype sits on an upgrade ladder (`MELEE_LADDER` / `RANGED_LADDER`).
 *
 * Camps (`CAMP_DEFS`) author a *base* composition (tier 0). As a camp is
 * cleared and respawns it climbs tiers: `campComposition(base, tier)` upgrades
 * every unit one rung up its ladder and, every second tier, adds one more unit
 * — so a respawned camp is both a stronger monster type AND more monsters,
 * with higher level (→ more hp/dmg and more gold/xp per `creep*` curves).
 */

export type CreepTypeId =
  // Melee ladder (weak → strong)
  | 'ghoul'
  | 'cactoro'
  | 'orc'
  | 'dino'
  | 'yeti'
  // Ranged ladder (weak → strong)
  | 'ghost'
  | 'dragon';

export interface CreepTypeDef {
  kind: 'melee' | 'ranged';
  /** Collision radius for projectile hit tests. */
  bodyRadius: number;
  baseHp: number;
  hpPerLevel: number;
  baseDamage: number;
  damagePerLevel: number;
  /** World units / second. */
  speed: number;
  /** A hero closer than this gets aggro. */
  aggroRange: number;
  /** Melee reach, or the ranged stand-off distance. */
  attackRange: number;
  /** Seconds between attacks. */
  attackCooldown: number;
  /** Ranged only: fireball flight speed. */
  projectileSpeed?: number;
  /** Ranged only: projectile maxRange = attackRange * slack. */
  projectileRangeSlack?: number;
  baseGold: number;
  goldPerLevel: number;
  baseXp: number;
  xpPerLevel: number;
}

export const CREEP_TYPES: Record<CreepTypeId, CreepTypeDef> = {
  // ── Melee ladder ──────────────────────────────────────────────────
  // Kiteable chaser: dies to two lvl-1 arrows, outrun by every hero (250 vs
  // 350), but a pair face-tanked kills a hero in ~12s.
  ghoul: {
    kind: 'melee',
    bodyRadius: 24,
    baseHp: 250,
    hpPerLevel: 60,
    baseDamage: 30,
    damagePerLevel: 10,
    speed: 250,
    aggroRange: 350,
    attackRange: 60,
    attackCooldown: 1.2,
    baseGold: 10,
    goldPerLevel: 4,
    baseXp: 60,
    xpPerLevel: 20,
  },
  // Prickly bruiser — a step up from the ghoul: tankier, hits a little harder.
  cactoro: {
    kind: 'melee',
    bodyRadius: 26,
    baseHp: 380,
    hpPerLevel: 80,
    baseDamage: 38,
    damagePerLevel: 12,
    speed: 240,
    aggroRange: 360,
    attackRange: 64,
    attackCooldown: 1.2,
    baseGold: 15,
    goldPerLevel: 5,
    baseXp: 80,
    xpPerLevel: 24,
  },
  // Mid-ladder warrior: real threat if not kited, good farm.
  orc: {
    kind: 'melee',
    bodyRadius: 28,
    baseHp: 520,
    hpPerLevel: 100,
    baseDamage: 46,
    damagePerLevel: 14,
    speed: 250,
    aggroRange: 380,
    attackRange: 70,
    attackCooldown: 1.15,
    baseGold: 22,
    goldPerLevel: 7,
    baseXp: 110,
    xpPerLevel: 30,
  },
  // Heavy bruiser: big body, big hits, still kiteable but punishing.
  dino: {
    kind: 'melee',
    bodyRadius: 34,
    baseHp: 720,
    hpPerLevel: 130,
    baseDamage: 60,
    damagePerLevel: 18,
    speed: 255,
    aggroRange: 400,
    attackRange: 80,
    attackCooldown: 1.3,
    baseGold: 30,
    goldPerLevel: 9,
    baseXp: 150,
    xpPerLevel: 40,
  },
  // Camp boss: slow but a wall of hp and damage — a genuine team objective.
  yeti: {
    kind: 'melee',
    bodyRadius: 40,
    baseHp: 1050,
    hpPerLevel: 180,
    baseDamage: 74,
    damagePerLevel: 22,
    speed: 205,
    aggroRange: 420,
    attackRange: 90,
    attackCooldown: 1.5,
    baseGold: 42,
    goldPerLevel: 12,
    baseXp: 210,
    xpPerLevel: 55,
  },
  // ── Ranged ladder ─────────────────────────────────────────────────
  // Spectral poker: fragile, opens from range with a slow bolt that's easy
  // to sidestep. The entry-level ranged threat.
  ghost: {
    kind: 'ranged',
    bodyRadius: 26,
    baseHp: 300,
    hpPerLevel: 70,
    baseDamage: 30,
    damagePerLevel: 10,
    speed: 240,
    aggroRange: 500,
    attackRange: 440,
    attackCooldown: 1.8,
    projectileSpeed: 560,
    projectileRangeSlack: 1.4,
    baseGold: 16,
    goldPerLevel: 6,
    baseXp: 90,
    xpPerLevel: 26,
  },
  // Tanky turret: fireballs fly slower than arrows (600 vs 900) so they can
  // be sidestepped or dodged, and arrows outrange its 500 stand-off.
  dragon: {
    kind: 'ranged',
    bodyRadius: 30,
    baseHp: 350,
    hpPerLevel: 80,
    baseDamage: 40,
    damagePerLevel: 12,
    speed: 220,
    aggroRange: 550,
    attackRange: 500,
    attackCooldown: 2.0,
    projectileSpeed: 600,
    projectileRangeSlack: 1.4,
    baseGold: 18,
    goldPerLevel: 6,
    baseXp: 90,
    xpPerLevel: 25,
  },
};

export const CREEP = {
  /** Seconds from a camp being fully cleared to it respawning (one tier up). */
  respawnInterval: 15,
  /** Distance from spawnPos beyond which aggro drops and the creep leashes. */
  leashRange: 1200,
  /** Cap on the per-unit level a camp tier reaches (rewards/stats plateau). */
  maxLevel: 10,
  /** Idle creeps scan for aggro every Nth tick, staggered by creep index. */
  aggroScanEvery: 6,
  /** Within this distance of spawnPos a leashing creep snaps home. */
  arriveEpsilon: 5,
  /** Creeps stay in snapshots this many ticks after going idle. */
  activeLingerTicks: 30,
  /** Per-unit spawn offset inside a camp. */
  spawnSpread: 50,
  /** An aggroed creep recomputes its path at most every Nth tick (staggered
   *  by creep index) as the target drifts — bounds A* cost across the camp. */
  repathEvery: 8,
  /** Re-path once the goal has drifted this many world units from the path end. */
  repathThreshold: 60,
  /** Extra unit slots a camp can grow by across its tier ladder (see
   *  `campComposition`). Bounds the pre-allocated creep pool per camp. */
  maxExtraUnits: 3,
} as const;

// ── Derived stat curves (never sent on the wire) ──────────────────────

export function creepMaxHp(type: CreepTypeId, level: number): number {
  const def = CREEP_TYPES[type];
  return def.baseHp + def.hpPerLevel * (level - 1);
}

export function creepDamage(type: CreepTypeId, level: number): number {
  const def = CREEP_TYPES[type];
  return def.baseDamage + def.damagePerLevel * (level - 1);
}

export function creepGold(type: CreepTypeId, level: number): number {
  const def = CREEP_TYPES[type];
  return def.baseGold + def.goldPerLevel * (level - 1);
}

export function creepXp(type: CreepTypeId, level: number): number {
  const def = CREEP_TYPES[type];
  return def.baseXp + def.xpPerLevel * (level - 1);
}

// ── Camp tier progression ─────────────────────────────────────────────

/**
 * Upgrade ladders. A camp's base units are climbed one rung per tier; a type
 * already at the top of its ladder simply stays there. `campComposition`
 * routes every `CreepTypeId` through whichever ladder contains it.
 */
export const MELEE_LADDER: readonly CreepTypeId[] = ['ghoul', 'cactoro', 'orc', 'dino', 'yeti'];
export const RANGED_LADDER: readonly CreepTypeId[] = ['ghost', 'dragon'];

function upgradeType(type: CreepTypeId, steps: number): CreepTypeId {
  const ladder = RANGED_LADDER.includes(type) ? RANGED_LADDER : MELEE_LADDER;
  const idx = ladder.indexOf(type);
  if (idx < 0) return type;
  return ladder[Math.min(idx + steps, ladder.length - 1)];
}

/**
 * The unit composition of a camp at a given tier (tier 0 = the authored base).
 * Each tier upgrades every base unit one rung up its ladder and, every second
 * tier, appends one more unit (a copy of the last base unit, upgraded) up to
 * `CREEP.maxExtraUnits`. Deterministic and pure — the server, offline sim, and
 * clients all derive the same composition.
 */
export function campComposition(base: readonly CreepTypeId[], tier: number): CreepTypeId[] {
  const units = base.map((u) => upgradeType(u, tier));
  const extra = Math.min(Math.floor(tier / 2), CREEP.maxExtraUnits);
  const template = base.length > 0 ? base[base.length - 1] : 'ghoul';
  for (let i = 0; i < extra; i++) units.push(upgradeType(template, tier));
  return units;
}

/** Every unit in a tier shares this level; climbs with the tier, capped. */
export function campTierLevel(tier: number): number {
  return Math.min(tier + 1, CREEP.maxLevel);
}

/**
 * Pre-allocated creep-pool size for a camp with the given base composition —
 * the largest a camp ever gets (base + `maxExtraUnits`). Slots beyond the
 * current tier's composition are held dead until a higher tier activates them,
 * which keeps creep ids stable for the whole match.
 */
export function campPoolSize(base: readonly CreepTypeId[]): number {
  return base.length + CREEP.maxExtraUnits;
}

// ── Camp placement ────────────────────────────────────────────────────

/** A camp's nominal center as fractions of the arena rect, plus its base units. */
export interface CampDef {
  id: string;
  fx: number;
  fz: number;
  units: CreepTypeId[];
}

/** A camp pinned to world coordinates (custom maps place these directly). */
export interface CampPlacement {
  id: string;
  x: number;
  z: number;
  units: readonly CreepTypeId[];
}

// Note: fractions are chosen so no camp's aggro radius reaches a spawn point
// on the small test map (spawns sit at ~fz 0.73) — ranged camps (550 aggro)
// stay in the far north corners, the mid-height flank camps are melee-only.
export const CAMP_DEFS: CampDef[] = [
  { id: 'camp_w', fx: 0.15, fz: 0.5, units: ['ghoul', 'ghoul'] },
  { id: 'camp_e', fx: 0.85, fz: 0.5, units: ['ghoul'] },
  { id: 'camp_nw', fx: 0.15, fz: 0.15, units: ['ghost'] },
  { id: 'camp_ne', fx: 0.85, fz: 0.15, units: ['ghoul', 'ghost'] },
];
