/**
 * Shared movement math for heroes and creeps. Pure geometry — no pathfinding
 * or AI decisions. Callers supply their own speed computation and decide when
 * to move and when to turn.
 */
import { Vec2 } from './math';
import * as V from './math';

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
