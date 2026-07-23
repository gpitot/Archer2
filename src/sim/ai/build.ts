/**
 * AI progression tables — pure data + tiny selectors, no `three`/DOM.
 *
 * Two decisions live here: which skill point to spend next, and which shop
 * item to buy next. Both are deliberately simple ordered policies so they read
 * as data and are trivial to retune. See `docs/ai-opponent-plan.md`.
 */
import type { HeroState } from '../state';
import type { AbilityId } from '../abilities';
import { basicRankCap, ultimateRankCap } from '../rules';
import { SHOP_ITEMS } from '../shopItems';

/**
 * The ability to spend the next banked skill point on, or null if nothing is
 * spendable (no point, or every gated ability is at its rank cap for now).
 *
 * Order: R whenever a new rank is unlocked (hero levels 6/11/16), else max Q,
 * then W, then E. E is skilled last — the perfect-info AI never needs its
 * vision, so it only receives points once Q/W are maxed (a deliberate spec
 * consequence, not an oversight).
 */
export function nextAbilityToLevel(hero: HeroState): AbilityId | null {
  if (hero.skillPoints <= 0) return null;
  const a = hero.abilities;

  // Ultimate first: prioritising it means R is taken the instant its cap
  // rises, i.e. at levels 6/11/16.
  if (a.blast.level < ultimateRankCap(hero.level) && a.blast.level < 3) return 'blast';

  const cap = Math.min(basicRankCap(hero.level), 5);
  if (a.arrow.level < cap) return 'arrow';
  if (a.split.level < cap) return 'split';
  if (a.reveal.level < cap) return 'reveal';
  return null;
}

/** Duel build order — strongest 1v1 items first (see plan). */
export const SHOP_BUILD_ORDER: readonly string[] = [
  'boots', // kiting supremacy
  'ice_bow', // the slow is the strongest duel item
  'crit_gem',
  'blink_dagger',
];

export interface ShopPick {
  id: string;
  /** Index into shop's items array for the `buy` command. */
  index: number;
  cost: number;
}

/**
 * The next unowned item in the build order, with the shop index the `buy`
 * command needs, or null when the build is complete. Gold is not checked here
 * — the caller decides whether it can afford `cost`.
 */
export function nextShopItem(hero: HeroState): ShopPick | null {
  for (const id of SHOP_BUILD_ORDER) {
    if (hero.inventory.includes(id)) continue;
    const index = SHOP_ITEMS.findIndex((it) => it.id === id);
    if (index < 0) continue;
    return { id, index, cost: SHOP_ITEMS[index].cost };
  }
  return null;
}
