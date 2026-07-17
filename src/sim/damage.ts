/**
 * Shared damage math for hero-sourced ability hits (arrows and blasts):
 * one crit roll + rune double-damage multiplier, applied identically at
 * every damage site.
 */
import { CRIT_MULTIPLIER } from './shopItems';
import { HeroState } from './state';
import { runeDamageMultiplier } from './stepRunes';

/**
 * Roll the final damage of a hero-sourced hit: crit chance (doubling on
 * success) and the source's rune damage multiplier. Consumes at most one
 * `rng()` call, and only when the source has any crit chance.
 */
export function rollAbilityDamage(
  source: HeroState,
  base: number,
  rng: () => number,
): { damage: number; crit: boolean } {
  const crit = source.critChance > 0 && rng() < source.critChance;
  const damage = (crit ? base * CRIT_MULTIPLIER : base) * runeDamageMultiplier(source);
  return { damage, crit };
}
