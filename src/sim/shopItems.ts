/**
 * The item registry — the single place every item is defined.
 *
 * A `ShopItemDef` can carry passive stats (`apply`), an active on-use effect
 * (`use`), or an on-hit hook (`onProjectileHitHero`). The sim and the client
 * both look items up by id; cooldowns live in `hero.itemCooldowns`.
 *
 * Inventory helpers (`addItem`, `removeItem`) live here alongside the defs
 * so the `execute` callbacks can use them without a circular import.
 */
import type { HeroState, CreepState, MatchState, SimEvent } from './state';
import type { SimWorld } from './world';
import type { StatLine, TooltipContent } from '../ui/Tooltip';
import { findReachableNear, sphereHitsObstacle } from './world';
import { Vec2 } from './math';
import * as V from './math';
import { stopMovement } from './abilities';
import { breakInvisibility } from './stepRunes';
import { WARD } from './rules';

// ── Shared constants (still named exports — consumed by stepMatch.ts) ─

/** Blink Dagger cooldown in seconds. */
export const BLINK_COOLDOWN = 10;
/** Blink Dagger cast delay (seconds) before teleport. */
export const BLINK_CAST_DELAY = 0.2;
/** Blink Dagger maximum teleport range. */
export const BLINK_RANGE = 450;

/** Crit chance granted by the Gem of Critical Strike (0–1). */
export const CRIT_CHANCE = 0.2;
/** Damage multiplier applied on a critical strike. */
export const CRIT_MULTIPLIER = 2;

/** Slow duration (seconds) applied by Ice Bow on arrow hit. */
export const ICE_BOW_SLOW_DURATION = 2;
/** Speed multiplier while slowed. */
export const ICE_BOW_SLOW_FACTOR = 0.8;

/** Fraction of the triggering hit's damage dealt again as a burn (10%). */
export const FIRE_BOW_BURN_FRACTION = 0.1;
/** Burn duration (seconds) applied by Fire Bow on arrow hit. */
export const FIRE_BOW_BURN_DURATION = 3;

// ── Contexts ──────────────────────────────────────────────────────────

/**
 * The unit an owner's projectile struck — hero or creep. Exposes the debuff
 * fields an on-hit hook may write (Ice Bow slow, Fire Bow burn). Both
 * `HeroState` and `CreepState` structurally satisfy this shape.
 */
export interface ProjectileHitTarget {
  slowTimer: number;
  burnRemaining: number;
  burnDps: number;
  burnSourceId: string | null;
  burnTickAccum: number;
}

/** Context passed to an item's `use.execute` callback. */
export interface ItemUseContext {
  state: MatchState;
  hero: HeroState;
  world: SimWorld;
  events: SimEvent[];
  /** Ground/aim point for point-targeted items (absent for self-cast or hotkey press). */
  x?: number;
  z?: number;
}

// ── Item definition ───────────────────────────────────────────────────

export interface ShopItemDef {
  id: string;
  name: string;
  cost: number;
  /** Emoji icon shown in the inventory bar and shop. */
  icon: string;
  /** Hex colour (e.g. '#8B6914') used for item swatches (scoreboard, shop). */
  color: string;
  /** One-sentence summary of what the item does. */
  description: string;
  /** Stat rows (bonuses, cooldowns, …) shown in the tooltip and shop cards. */
  stats?: readonly StatLine[];
  /** Stackable items (e.g. ward charges) can be re-bought while owned. */
  stackable?: boolean;
  /** Consumed on purchase — never occupies an inventory slot. Stats are applied permanently. */
  consumable?: boolean;
  /** Passive stat application on purchase. */
  apply: (hero: HeroState) => void;
  /** Active-use behaviour (blink, wards, …). Cooldown goes through hero.itemCooldowns[id]. */
  use?: {
    /** 'point' = ground-targeted (click to place/teleport); 'self' = instant. */
    targeting: 'point' | 'self';
    /** Maximum cast range (point-targeted items only). */
    range?: number;
    /** Cooldown the execute callback should apply to hero.itemCooldowns[id]. */
    cooldown?: number;
    /** Extra readiness gate beyond the cooldown (e.g. ward charges left). */
    canUse?: (hero: HeroState) => boolean;
    /** The item effect itself — mirrored identically in sim and prediction. */
    execute(ctx: ItemUseContext): void;
  };
  /**
   * Called when the owner's arrow/projectile hits a hero or creep, with the
   * final (post-crit) `damage` of that hit — Fire Bow scales its burn off it.
   */
  onProjectileHitHero?: (source: HeroState, target: ProjectileHitTarget, damage: number) => void;
}

// ── Inventory helpers ─────────────────────────────────────────────────

/** Add an item to the first free inventory slot; returns the slot index or -1. */
export function addItem(hero: HeroState, itemId: string): number {
  for (let i = 0; i < hero.inventory.length; i++) {
    if (hero.inventory[i] === null) {
      hero.inventory[i] = itemId;
      return i;
    }
  }
  return -1;
}

/** Remove the first occurrence of an item from inventory. */
export function removeItem(hero: HeroState, itemId: string): void {
  const i = hero.inventory.indexOf(itemId);
  if (i !== -1) hero.inventory[i] = null;
}

// ── Registry ──────────────────────────────────────────────────────────

export const SHOP_ITEMS: ShopItemDef[] = [
  {
    id: 'sentry_wards',
    name: 'Sentry Wards',
    icon: '👁️',
    color: '#C8A050',
    cost: 200,
    description: 'Deployable wards that grant vision of an area. Maximum 2 wards active per hero.',
    stats: [
      { label: 'Charges', values: ['2'] },
      { label: 'Max Active', values: ['2'] },
      { label: 'Sight Radius', values: [String(WARD.sightRadius)] },
      { label: 'Duration', values: [`${WARD.duration}s`] },
    ],
    stackable: true,
    apply: (hero) => {
      hero.wardCharges += 2;
    },
    use: {
      targeting: 'point',
      range: WARD.placeRange,
      canUse: (hero) => hero.wardCharges > 0,
      execute(ctx) {
        const { state, hero, world, events } = ctx;
        if (!hero.alive) return;
        if (hero.wardCharges <= 0) return;

        // Interrupt movement.
        stopMovement(hero);

        let pos: Vec2;
        if (ctx.x !== undefined && ctx.z !== undefined) {
          // Validate range.
          if (V.distance(hero.pos, { x: ctx.x, z: ctx.z }) > WARD.placeRange + 1) return;
          // Reject placement inside solid obstacles.
          if (sphereHitsObstacle(world, { x: ctx.x, z: ctx.z }, WARD.placementRadius)) return;
          pos = { x: ctx.x, z: ctx.z };
        } else {
          pos = { x: hero.pos.x, z: hero.pos.z };
        }

        hero.wardCharges--;
        if (hero.wardCharges === 0) removeItem(hero, 'sentry_wards');

        // Enforce max 2 wards per hero — remove the oldest (lowest life) if at cap.
        const myWards = state.wards.filter((w) => w.ownerId === hero.id);
        if (myWards.length >= 2) {
          // Oldest = smallest remaining life (placed earliest).
          let oldestIdx = -1;
          let lowestLife = Infinity;
          for (let i = state.wards.length - 1; i >= 0; i--) {
            const w = state.wards[i];
            if (w.ownerId === hero.id && w.life < lowestLife) {
              lowestLife = w.life;
              oldestIdx = i;
            }
          }
          if (oldestIdx !== -1) state.wards.splice(oldestIdx, 1);
        }

        // Placing a ward breaks invisibility.
        breakInvisibility(hero);
        state.wards.push({
          id: `w${state.nextWardId++}`,
          ownerId: hero.id,
          team: hero.team,
          pos,
          life: WARD.duration,
        });
      },
    },
  },
  {
    id: 'strength_tome',
    name: 'Tome of Strength',
    icon: '💪',
    color: '#44CC44',
    cost: 200,
    description: "A mystical tome that permanently increases your body's fortitude.",
    stats: [{ label: 'Permanent Bonus', values: ['+50 Max HP'] }],
    consumable: true,
    apply: (hero) => {
      hero.bonusHp += 50;
      hero.hp += 50;
    },
  },
  {
    id: 'attack_tome',
    name: 'Tome of Power',
    icon: '📕',
    color: '#FF6633',
    cost: 200,
    description: 'A mystical tome that permanently sharpens your offensive prowess.',
    stats: [{ label: 'Permanent Bonus', values: ['+50 Ability Damage'] }],
    consumable: true,
    apply: (hero) => {
      hero.bonusDamage += 50;
    },
  },
  {
    id: 'boots',
    name: 'Boots of Speed',
    icon: '🥾',
    color: '#8B6914',
    cost: 500,
    description: 'Sturdy boots that quicken your stride across the battlefield.',
    stats: [{ label: 'Movement Speed', values: ['+60'] }],
    apply: (hero) => {
      hero.speedBonus += 60;
    },
  },
  {
    id: 'crit_gem',
    name: 'Gem of Critical Strike',
    icon: '💎',
    color: '#FF4444',
    cost: 900,
    description: 'A gleaming gem that empowers your abilities to occasionally strike for double damage.',
    stats: [
      { label: 'Crit Chance', values: [`${Math.round(CRIT_CHANCE * 100)}%`] },
      { label: 'Crit Damage', values: [`${CRIT_MULTIPLIER}x`] },
    ],
    apply: (hero) => {
      hero.critChance = Math.min(1, hero.critChance + CRIT_CHANCE);
    },
  },
  {
    id: 'ice_bow',
    name: 'Ice Bow',
    icon: '❄️',
    color: '#66CCFF',
    cost: 900,
    description: 'Frost-enchanted arrows that chill enemies on hit, slowing their movement.',
    stats: [
      { label: 'Slow', values: [`${Math.round((1 - ICE_BOW_SLOW_FACTOR) * 100)}%`] },
      { label: 'Duration', values: [`${ICE_BOW_SLOW_DURATION}s`] },
    ],
    apply: (_hero) => {
      // Slow is applied via the onProjectileHitHero hook.
    },
    onProjectileHitHero: (_source, target) => {
      target.slowTimer = ICE_BOW_SLOW_DURATION;
    },
  },
  {
    id: 'fire_bow',
    name: 'Fire Bow',
    icon: '🔥',
    color: '#FF6633',
    cost: 900,
    description: 'Flame-enchanted arrows that set enemies ablaze. Burns stack, each adding damage over time.',
    stats: [
      { label: 'Burn Damage', values: [`${Math.round(FIRE_BOW_BURN_FRACTION * 100)}% of hit`] },
      { label: 'Duration', values: [`${FIRE_BOW_BURN_DURATION}s`] },
      { label: 'Stacks', values: ['Yes'] },
    ],
    apply: (_hero) => {
      // Burn is applied via the onProjectileHitHero hook.
    },
    onProjectileHitHero: (source, target, damage) => {
      // Stack: add this hit's contribution (`damage * fraction`) to the burn
      // pool and re-time the drain to the full duration. Total burn always
      // sums every hit's 10% — nothing is lost or double-counted.
      target.burnRemaining += damage * FIRE_BOW_BURN_FRACTION;
      target.burnDps = target.burnRemaining / FIRE_BOW_BURN_DURATION;
      target.burnSourceId = source.id;
    },
  },
  {
    id: 'blink_dagger',
    name: 'Blink Dagger',
    icon: '🗡️',
    color: '#9370DB',
    cost: 1200,
    description: 'Channel briefly then teleport a short distance to a targeted location.',
    stats: [
      { label: 'Cast Range', values: [String(BLINK_RANGE)] },
      { label: 'Cast Delay', values: [`${BLINK_CAST_DELAY}s`] },
      { label: 'Cooldown', values: [`${BLINK_COOLDOWN}s`] },
    ],
    apply: (_hero) => {
      // Effect is handled via the use.execute callback.
    },
    use: {
      targeting: 'point',
      range: BLINK_RANGE,
      cooldown: BLINK_COOLDOWN,
      execute(ctx) {
        const { hero, world } = ctx;
        if (!hero.alive) return;
        if (ctx.x === undefined || ctx.z === undefined) return;
        // Snap to nearest walkable, reachable cell.
        const snapped = findReachableNear(world, ctx.x, ctx.z, hero.pos.x, hero.pos.z);
        if (!snapped) return;

        // Begin cast delay — hero is immobilised, teleports when the timer expires.
        stopMovement(hero);
        hero.blinkCastTimer = BLINK_CAST_DELAY;
        hero.blinkTarget = { x: snapped.x, z: snapped.z };
        hero.itemCooldowns['blink_dagger'] = BLINK_COOLDOWN;
      },
    },
  },
];

/** Lookup by item id, built from the SHOP_ITEMS array. */
export const SHOP_ITEMS_BY_ID: Record<string, ShopItemDef> = {};
for (const item of SHOP_ITEMS) {
  SHOP_ITEMS_BY_ID[item.id] = item;
}

/**
 * Build the hover-tooltip content for an owned item. `includeCost` adds a
 * cost footer (used by the shop, omitted for inventory).
 */
export function itemTooltip(def: ShopItemDef, includeCost = false): TooltipContent {
  return {
    name: def.name,
    description: def.description,
    stats: def.stats,
    footer: includeCost ? `Cost: ${def.cost}g${def.consumable ? ' · consumed on use' : ''}` : undefined,
  };
}
