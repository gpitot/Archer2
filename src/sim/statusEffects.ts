/**
 * Cross-unit status effects — the shared vocabulary spells speak when they
 * need to do something to a unit other than damage it.
 *
 * Everything here is written against `UnitCore`, so a stun or a displacement
 * applies to a hero and a creep with the same call. Adding a new stunning
 * spell means calling `applyStun` — no per-ability bookkeeping.
 *
 * Two effects live here today:
 *   • **Stun** — the unit can't act: no movement, no casts, no attacks. Its
 *     cooldowns keep ticking (standard MOBA behaviour: a stun costs you
 *     tempo, not your rotation).
 *   • **Pull** — a scripted displacement (the Grappling Arrow yank). The
 *     unit's position is a straight lerp for the duration and its own
 *     movement is suspended.
 *
 * The two compose: the hook pulls *and* stuns, and because the stun outlasts
 * the pull the victim is left standing still where they landed.
 */
import * as V from './math';
import { HeroState, UnitCore } from './state';
import { cancelArrowWindup } from './abilities';
import { findReachableNear, SimWorld } from './world';

/** Narrow a unit to a hero — heroes are the only units with abilities. */
function asHero(unit: UnitCore): HeroState | null {
  return 'abilities' in unit ? (unit as HeroState) : null;
}

/**
 * Cancel whatever the unit was doing. Shared by every hard interrupt (a stun
 * landing, a hook yanking someone off their feet): movement stops, a pending
 * arrow draw is aborted, and a Blink Dagger mid-cast is cancelled outright —
 * being stunned during the cast delay eats the blink, as it should.
 */
function interruptActions(unit: UnitCore): void {
  unit.path = [];
  const hero = asHero(unit);
  if (!hero) return;
  hero.moving = false;
  cancelArrowWindup(hero);
  hero.blinkCastTimer = 0;
  hero.blinkTarget = undefined;
}

// ── Stun ──────────────────────────────────────────────────────────────

/**
 * Stun `unit` for `seconds`. Stuns don't stack — a fresh stun extends the
 * existing one rather than queueing behind it, so two hooks landing together
 * can't chain a unit down for the sum of both durations.
 *
 * Dead units are ignored, and the stun is cleared on respawn.
 */
export function applyStun(unit: UnitCore, seconds: number): void {
  if (!unit.alive || seconds <= 0) return;
  unit.stunTimer = Math.max(unit.stunTimer, seconds);
  interruptActions(unit);
}

/** True while the unit is stunned and may not move, cast, or attack. */
export function isStunned(unit: UnitCore): boolean {
  return unit.stunTimer > 0;
}

/** Tick the stun timer down. Call once per unit per step. */
export function stepStun(unit: UnitCore, dt: number): void {
  if (unit.stunTimer > 0) unit.stunTimer = Math.max(0, unit.stunTimer - dt);
}

// ── Displacement (pull) ───────────────────────────────────────────────

/** True while a scripted displacement owns the unit's position. */
export function isBeingPulled(unit: UnitCore): boolean {
  return unit.pullTimer > 0;
}

/**
 * Begin a displacement toward `to` over `duration` seconds, snapped to ground
 * the unit could have walked to — a hook fired across a chasm lands its target
 * on the near side rather than inside it. Interrupts whatever the unit was
 * doing: a yank beats a blink.
 */
export function startPull(
  unit: UnitCore,
  to: V.Vec2,
  duration: number,
  world: SimWorld,
): void {
  const dest = findReachableNear(world, to.x, to.z, unit.pos.x, unit.pos.z);
  if (!dest) return;
  interruptActions(unit);
  unit.pullFrom = { x: unit.pos.x, z: unit.pos.z };
  unit.pullTo = { x: dest.x, z: dest.z };
  unit.pullDuration = duration;
  unit.pullTimer = duration;
}

/** Advance an active pull, lerping the unit from `pullFrom` to `pullTo`. */
export function stepPull(unit: UnitCore, dt: number): void {
  if (unit.pullTimer <= 0) return;
  unit.pullTimer = Math.max(0, unit.pullTimer - dt);
  const from = unit.pullFrom;
  const to = unit.pullTo;
  if (!from || !to) {
    unit.pullTimer = 0;
    return;
  }
  const t = unit.pullDuration > 0 ? 1 - unit.pullTimer / unit.pullDuration : 1;
  unit.pos = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
  if (unit.pullTimer <= 0) endPull(unit);
}

/** Clear pull state (arrival, death, or a cancelled grapple). */
export function endPull(unit: UnitCore): void {
  unit.pullTimer = 0;
  unit.pullDuration = 0;
  unit.pullFrom = undefined;
  unit.pullTo = undefined;
}

/** Clear every status effect — used by hero respawn and creep respawn. */
export function clearStatusEffects(unit: UnitCore): void {
  unit.stunTimer = 0;
  endPull(unit);
}
