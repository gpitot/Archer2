/**
 * Building simulation helpers: spawning the map's castles and applying creep
 * damage to them. Buildings never move or act, so there is no per-tick step —
 * `stepCreeps` drives the attacks and `stepMatch` checks the end condition.
 * Pure and deterministic like the rest of the sim.
 */
import { BUILDING_TYPES, CastlePlacement, DEFENDERS } from './buildingRules';
import * as V from './math';
import { ARROW } from './rules';
import { BuildingState, CreepState, MatchState, ProjectileState, SimEvent, createBuildingState } from './state';
import { SimWorld, findWalkableNear } from './world';

/**
 * Populate `state.buildings` from authored castle placements. Centers snap to
 * walkable ground (same helper camps use) so every peer derives identical
 * positions. Ids (`bldg1`, `bldg2`, …) follow placement order.
 */
export function spawnCastles(
  state: MatchState,
  world: SimWorld,
  castles: readonly CastlePlacement[] | null | undefined,
  team = 0,
): void {
  if (!castles || castles.length === 0) return;
  for (let i = 0; i < castles.length; i++) {
    const pos = findWalkableNear(world, castles[i].x, castles[i].z);
    state.buildings.push(createBuildingState(`bldg${i + 1}`, 'castle', team, pos));
  }
}

/**
 * Defenders wave number (1-based, capped at `wavesToWin`). Camps all ride the
 * same fixed wave clock, so the deepest camp tier is the count of
 * reinforcement waves sent; tier 0 (the opening spawn) is wave 1.
 */
export function currentWave(state: MatchState): number {
  let tier = 0;
  for (const c of state.camps) tier = Math.max(tier, c.tier);
  return Math.min(tier + 1, DEFENDERS.wavesToWin);
}

/** Nearest alive building to `pos`, or null — the creeps' marching objective. */
export function nearestAliveBuilding(state: MatchState, pos: V.Vec2): BuildingState | null {
  let best: BuildingState | null = null;
  let bestD2 = Infinity;
  for (const b of state.buildings) {
    if (!b.alive) continue;
    const d2 = V.distanceSq(pos, b.pos);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = b;
    }
  }
  return best;
}

/**
 * Creep → building damage (melee swings and fireball impacts). Shared guard,
 * clamp, hit event, and the `buildingKill` on razing — the pattern of
 * `dealDamageToCreep`, minus rewards (razing a castle pays nobody).
 */
export function dealDamageToBuilding(
  state: MatchState,
  building: BuildingState,
  source: CreepState,
  damage: number,
  events: SimEvent[],
): void {
  if (!building.alive) return;
  building.hp = Math.max(0, building.hp - damage);
  events.push({
    type: 'buildingHit',
    buildingId: building.id,
    sourceId: source.id,
    damage,
    x: building.pos.x,
    z: building.pos.z,
  });
  if (building.hp > 0) return;

  building.alive = false;
  events.push({ type: 'buildingKill', buildingId: building.id, x: building.pos.x, z: building.pos.z });
}

/** First live building the projectile overlaps (2D), or null. */
export function findHitBuilding(state: MatchState, p: ProjectileState): BuildingState | null {
  for (const b of state.buildings) {
    if (!b.alive) continue;
    const r = BUILDING_TYPES[b.type].bodyRadius + ARROW.collisionRadius;
    if (V.distanceSq(p.pos, b.pos) < r * r) return b;
  }
  return null;
}
