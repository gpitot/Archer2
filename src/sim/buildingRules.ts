/**
 * Building constants and Defenders-mode tuning — pure data, mirroring
 * `creepRules.ts`.
 *
 * Buildings are static, attackable structures. In Defenders mode every hero
 * shares one team defending the map's authored castles; creeps march on the
 * nearest castle and swing at anything (heroes included) that crosses their
 * aggro radius along the way.
 */

export type BuildingTypeId = 'castle';

export interface BuildingTypeDef {
  /** Collision radius for projectile hit tests and melee stand-off. */
  bodyRadius: number;
  maxHp: number;
}

export const BUILDING_TYPES: Record<BuildingTypeId, BuildingTypeDef> = {
  // The Defenders objective: a wall of HP that a leaked wave grinds down.
  // ~6 ghoul swings/sec at wave 1 chews through it in ~2 minutes unattended,
  // so a single leak stings but only a wiped team loses the castle outright.
  castle: {
    bodyRadius: 110,
    maxHp: 6000,
  },
};

/** A castle pinned to world coordinates (maps author these directly). */
export interface CastlePlacement {
  x: number;
  z: number;
}

export const DEFENDERS = {
  /**
   * Total waves each camp sends. Waves arrive on a fixed clock (the creep
   * `respawnInterval`) whether or not the previous one was cleared — each
   * tick of the clock climbs the camp a tier and refills its dead slots.
   * Camp tier N means N reinforcement waves sent (tier 0 is the opening
   * spawn), the clock stops at `wavesToWin - 1`, and victory is every camp
   * at that cap with no creep left alive.
   */
  wavesToWin: 100,
} as const;
