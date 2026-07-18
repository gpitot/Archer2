/**
 * Shared movement math for heroes and creeps. Pure geometry — no pathfinding
 * or AI decisions. Callers supply their own speed computation and decide when
 * to move and when to turn.
 */
import { Vec2 } from './math';
import * as V from './math';
import { UnitCore } from './state';
import { SimWorld, findReachableNear } from './world';

/**
 * Move `unit` along the straight line toward `targetPos` at `speed` units/s,
 * up to `dt` seconds. Updates `unit.pos` in place. Returns the unit direction
 * vector so the caller can set facing / targetFacing as appropriate.
 */
export function stepToward(
  unit: { pos: Vec2 },
  targetPos: Vec2,
  speed: number,
  dt: number,
): Vec2 | null {
  const dir = V.sub(targetPos, unit.pos);
  const dist = V.length(dir);
  if (dist < 1e-6) return null;
  const step = Math.min(speed * dt, dist);
  const unitDir = V.scale(dir, 1 / dist);
  unit.pos = V.add(unit.pos, V.scale(unitDir, step));
  return unitDir;
}

/**
 * Smoothly rotate `facing` toward `targetFacing` at `turnSpeed` rad/s for
 * `dt` seconds. Returns the new facing angle in radians.
 */
export function turnToward(
  facing: number,
  targetFacing: number,
  turnSpeed: number,
  dt: number,
): number {
  let diff = targetFacing - facing;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const maxTurn = turnSpeed * dt;
  if (Math.abs(diff) < maxTurn) return targetFacing;
  return facing + Math.sign(diff) * maxTurn;
}

/**
 * Compute a waypoint path from `from` to `goal` using the shared A* pathfinder.
 * If the exact goal is unwalkable (cliff/tree/water), snaps to the nearest
 * reachable ground and paths there instead. Drops the first point (the unit's
 * own position). Returns `[]` when no route exists. Shared by hero
 * `setDestination` and creep `repathCreep`.
 */
export function computePath(world: SimWorld, from: Vec2, goal: Vec2): Vec2[] {
  let path = world.pathfinder.findSmoothedPath(from.x, from.z, goal.x, goal.z);
  if (!path || path.length <= 1) {
    const snapped = findReachableNear(world, goal.x, goal.z, from.x, from.z);
    if (snapped) path = world.pathfinder.findSmoothedPath(from.x, from.z, snapped.x, snapped.z);
  }
  return path && path.length > 1 ? path.slice(1).map((p) => ({ x: p.wx, z: p.wz })) : [];
}

/** How a unit's facing is updated while walking a path. */
export type FacingMode = 'smooth' | 'snap';

/**
 * Walk `unit` one frame along `unit.path`: snap-and-shift the head waypoint when
 * within `arriveEpsilon`, otherwise step toward it at `speed`. Facing follows the
 * step direction — `'snap'` writes `unit.facing` directly (creeps); `'smooth'`
 * writes `unit.targetFacing` for later `turnToward` smoothing (heroes). Does not
 * touch any `moving` flag — the caller manages that. Shared by hero and creep
 * movers.
 */
export function followPath(
  unit: UnitCore & { targetFacing?: number },
  dt: number,
  opts: { speed: number; arriveEpsilon: number; facingMode: FacingMode },
): void {
  const wp = unit.path[0];
  if (!wp) return;
  const dir = V.sub(wp, unit.pos);
  const dist = V.length(dir);
  if (dist < opts.arriveEpsilon) {
    unit.pos = { x: wp.x, z: wp.z };
    unit.path.shift();
    return;
  }
  const unitDir = stepToward(unit, wp, opts.speed, dt);
  if (unitDir) {
    const h = V.heading(unitDir);
    if (opts.facingMode === 'snap') unit.facing = h;
    else unit.targetFacing = h;
  }
}
