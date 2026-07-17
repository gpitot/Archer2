/**
 * Lead-shot aiming — the core of "as strong as possible".
 *
 * `solveIntercept` is a closed-form solution for where to aim a constant-speed
 * arrow so it meets a target moving at a constant velocity. `hasLineOfFire`
 * samples the shot segment against solid obstacles the same way the sim's
 * projectile collision does. Pure `sim/` code — no `three`/DOM.
 */
import * as V from '../math';
import { ARROW } from '../rules';
import type { HeroState } from '../state';
import { type SimWorld, sphereHitsObstacle } from '../world';
import { heroSpeed } from '../stepMatch';

/**
 * A unit's exact instantaneous velocity: heading toward its next path
 * waypoint × current move speed when moving, zero otherwise. Perfect info
 * makes this exact for the target too (we read its real path + speed).
 */
export function heroVelocity(hero: HeroState): V.Vec2 {
  if (!hero.moving || hero.path.length === 0) return { x: 0, z: 0 };
  const dir = V.normalize(V.sub(hero.path[0], hero.pos));
  return V.scale(dir, heroSpeed(hero));
}

export interface Intercept {
  /** World point to aim the shot at (the target's position at impact). */
  point: V.Vec2;
  /** Seconds from launch to impact. */
  time: number;
}

/**
 * Solve for the interception of an arrow launched from `shooterPos` at
 * `arrowSpeed` against a target at `targetPos` moving at `targetVel`.
 *
 * Let P = targetPos - shooterPos and s = arrowSpeed. We need a flight time t
 * with |P + targetVel·t| = s·t, which expands to the quadratic
 *   (|v|² - s²)·t² + 2(P·v)·t + |P|² = 0.
 * We take the smallest positive root; no positive root → the target outruns
 * the arrow on this bearing → null (don't fire). The small-`a` branch handles
 * a target moving at ~arrow speed (linear equation).
 *
 * The arrow actually spawns `spawnOffset` in front of the hero, which only
 * shortens the flight, so aiming from `shooterPos` is conservative and always
 * lands (the extra offset is absorbed by the fire-range margin at the call
 * site).
 */
export function solveIntercept(
  shooterPos: V.Vec2,
  targetPos: V.Vec2,
  targetVel: V.Vec2,
  arrowSpeed: number,
): Intercept | null {
  const px = targetPos.x - shooterPos.x;
  const pz = targetPos.z - shooterPos.z;
  const vx = targetVel.x;
  const vz = targetVel.z;

  const a = vx * vx + vz * vz - arrowSpeed * arrowSpeed;
  const b = 2 * (px * vx + pz * vz);
  const c = px * px + pz * pz;

  let t: number;
  if (Math.abs(a) < 1e-6) {
    // |v| ≈ s: linear. b < 0 for any target not fleeing faster than the arrow.
    if (Math.abs(b) < 1e-9) return null;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    t = Math.min(t1 > 1e-4 ? t1 : Infinity, t2 > 1e-4 ? t2 : Infinity);
    if (!Number.isFinite(t)) return null;
  }
  if (t <= 0) return null;

  return { point: { x: targetPos.x + vx * t, z: targetPos.z + vz * t }, time: t };
}

/**
 * True if an arrow can fly from `from` to `to` without clipping a solid
 * obstacle — sampled every ~20u with the arrow's collision radius, mirroring
 * the sim's per-step `sphereHitsObstacle` check.
 */
export function hasLineOfFire(world: SimWorld, from: V.Vec2, to: V.Vec2): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / 20));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = { x: from.x + dx * t, z: from.z + dz * t };
    if (sphereHitsObstacle(world, p, ARROW.collisionRadius)) return false;
  }
  return true;
}
