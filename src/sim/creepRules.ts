/**
 * Jungle creep constants and stat curves — pure data, mirroring `rules.ts`.
 *
 * Creeps come in archetypes (`CREEP_TYPES`): melee ghouls that chase and
 * claw, ranged dragons that stand off and spit fireballs. Camps (`CAMP_DEFS`)
 * compose units per camp and are placed as fractions of the arena rect so
 * the same definitions work on every map.
 */

export type CreepTypeId = 'ghoul' | 'dragon';

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
  /** Seconds from death to respawn (at +1 level). */
  respawnInterval: 60,
  /** Distance from spawnPos beyond which aggro drops and the creep leashes. */
  leashRange: 600,
  maxLevel: 10,
  /** Idle creeps scan for aggro every Nth tick, staggered by creep index. */
  aggroScanEvery: 6,
  /** Within this distance of spawnPos a leashing creep snaps home. */
  arriveEpsilon: 5,
  /** Creeps stay in snapshots this many ticks after going idle. */
  activeLingerTicks: 30,
  /** Per-unit spawn offset inside a camp. */
  spawnSpread: 50,
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

// ── Camp placement ────────────────────────────────────────────────────

/** A camp's nominal center as fractions of the arena rect, plus its units. */
export interface CampDef {
  id: string;
  fx: number;
  fz: number;
  units: CreepTypeId[];
}

// Note: fractions are chosen so no camp's aggro radius reaches a spawn point
// on the small test map (spawns sit at ~fz 0.73) — ranged camps (550 aggro)
// stay in the far north corners, the mid-height flank camps are melee-only.
export const CAMP_DEFS: CampDef[] = [
  { id: 'camp_w', fx: 0.15, fz: 0.5, units: ['ghoul', 'ghoul'] },
  { id: 'camp_e', fx: 0.85, fz: 0.5, units: ['ghoul'] },
  { id: 'camp_nw', fx: 0.15, fz: 0.15, units: ['dragon'] },
  { id: 'camp_ne', fx: 0.85, fz: 0.15, units: ['ghoul', 'dragon'] },
];
