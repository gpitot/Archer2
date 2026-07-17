/**
 * Threat assessment — every-tick danger scans and the fight-win estimate that
 * drives the macro FSM. Perfect info makes all of these exact. Pure `sim/`.
 */
import * as V from '../math';
import { ARROW, BLAST, HERO } from '../rules';
import type { BlastState, HeroState, MatchState, ProjectileState } from '../state';
import { CRIT_MULTIPLIER } from '../shopItems';

/** Radius at which a projectile connects with a hero body. */
const HIT_RADIUS = HERO.bodyRadius + ARROW.collisionRadius;

export interface ArrowThreat {
  projectile: ProjectileState;
  /** Seconds until the projectile enters our hit radius. */
  timeToImpact: number;
}

/**
 * The soonest-arriving projectile on course to hit `hero`, or null. Considers
 * enemy-team arrows and neutral creep fireballs (dodge evades both); our own
 * arrows are skipped. A projectile is a threat only if its straight-line path
 * passes within the hit radius *and* it has the range left to get there.
 *
 * `extraMargin` widens the corridor (used for the sidestep pre-warning so the
 * hero starts moving before the arrow is a guaranteed hit).
 */
export function incomingArrowThreat(
  state: MatchState,
  hero: HeroState,
  extraMargin = 0,
): ArrowThreat | null {
  const hitR = HIT_RADIUS + extraMargin;
  const hitR2 = hitR * hitR;
  let best: ArrowThreat | null = null;

  for (const p of state.projectiles) {
    if (p.kind === 'scout') continue; // vision-only, no damage
    if (p.ownerId === hero.id) continue; // our own arrow
    // Hero arrows only threaten the enemy team; creep fireballs hit anyone.
    if (p.ownerKind !== 'creep' && p.team === hero.team) continue;

    const rel = V.sub(hero.pos, p.pos);
    const along = rel.x * p.dir.x + rel.z * p.dir.z;
    if (along < 0) continue; // travelling away from us
    if (along > p.maxRange - p.traveled) continue; // expires before reaching us

    const closestSq = V.length(rel) ** 2 - along * along;
    if (closestSq > hitR2) continue; // path misses our body

    // Distance along the path to where the corridor is first entered.
    const entry = along - Math.sqrt(Math.max(0, hitR2 - closestSq));
    const t = Math.max(0, entry) / p.speed;
    if (!best || t < best.timeToImpact) best = { projectile: p, timeToImpact: t };
  }
  return best;
}

/**
 * The enemy blast zone `hero` is currently standing inside (soonest to
 * detonate if several overlap), or null. `state.blasts` is global, so a
 * perfect-info AI always sees these and can walk out of the radius.
 */
export function blastDangerFor(state: MatchState, hero: HeroState): BlastState | null {
  const r = BLAST.radius + HERO.bodyRadius;
  const r2 = r * r;
  let best: BlastState | null = null;
  for (const b of state.blasts) {
    if (b.team === hero.team) continue;
    if (V.distanceSq(hero.pos, b.pos) > r2) continue;
    if (!best || b.timer < best.timer) best = b;
  }
  return best;
}

/** Expected arrow damage per shot, folding in crit chance and the DD rune. */
function offensePerShot(h: HeroState): number {
  const rank = Math.max(1, h.abilities.arrow.level);
  let dmg = ARROW.damageByLevel[rank];
  dmg *= 1 + h.critChance * (CRIT_MULTIPLIER - 1); // expected value of crits
  if (h.ddTimer > 0) dmg *= 2; // double-damage rune
  return dmg;
}

/**
 * Fight outcome estimate for `me` vs `enemy`, in "shots of margin". It compares
 * how many arrows each side must land to kill the other: positive means the
 * enemy dies first (favourable), negative means we do. Perfect info makes hp,
 * ranks, crit and rune buffs all exact, so this is what lets the bot commit to
 * winnable trades and bail out of losing ones.
 */
export function fightWinMargin(me: HeroState, enemy: HeroState): number {
  const shotsToKillEnemy = enemy.hp / offensePerShot(me);
  const shotsToKillMe = me.hp / offensePerShot(enemy);
  return shotsToKillMe - shotsToKillEnemy;
}
