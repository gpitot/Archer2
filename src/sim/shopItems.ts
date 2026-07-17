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
import { findReachableNear, sphereHitsObstacle } from './world';
import { Vec2 } from './math';
import * as V from './math';
import { stopMovement } from './abilities';
import { breakInvisibility } from './stepRunes';
import { WARD } from './rules';

// ── Shared constants (still named exports — consumed by stepMatch.ts) ─

/** Blink Dagger cooldown in seconds. */
export const BLINK_COOLDOWN = 10;
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

// ── Contexts ──────────────────────────────────────────────────────────

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
  description: string;
  /** Stackable items (e.g. ward charges) can be re-bought while owned. */
  stackable?: boolean;
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
  /** Called when the owner's arrow/projectile hits a hero or creep. */
  onProjectileHitHero?: (source: HeroState, target: { slowTimer: number }) => void;
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
    id: 'boots',
    name: 'Boots of Speed',
    cost: 5,
    description: '+60 movement speed',
    apply: (hero) => {
      hero.speedBonus += 60;
    },
  },
  {
    id: 'sentry_wards',
    name: 'Sentry Wards',
    cost: 10,
    description: '5 charges — press W to place a ward granting vision for 300s',
    stackable: true,
    apply: (hero) => {
      hero.wardCharges += 5;
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
        // Placing a ward breaks invisibility.
        breakInvisibility(hero);
        state.wards.push({
          id: `w${state.nextWardId++}`,
          team: hero.team,
          pos,
          life: WARD.duration,
        });
      },
    },
  },
  {
    id: 'blink_dagger',
    name: 'Blink Dagger',
    cost: 15,
    description: 'Click to instantly teleport to target location (450 range, 10s cooldown)',
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

        // Teleport instantly — clear movement state.
        stopMovement(hero);
        hero.pos = { x: snapped.x, z: snapped.z };
        hero.itemCooldowns['blink_dagger'] = BLINK_COOLDOWN;
      },
    },
  },
  {
    id: 'crit_gem',
    name: 'Gem of Critical Strike',
    cost: 20,
    description: '20% chance to deal double damage with any ability',
    apply: (hero) => {
      hero.critChance = Math.min(1, hero.critChance + CRIT_CHANCE);
    },
  },
  {
    id: 'ice_bow',
    name: 'Ice Bow',
    cost: 12,
    description: 'Arrows that hit enemies slow them by 20% for 2s',
    apply: (_hero) => {
      // Slow is applied via the onProjectileHitHero hook.
    },
    onProjectileHitHero: (_source, target) => {
      target.slowTimer = ICE_BOW_SLOW_DURATION;
    },
  },
];

/** Lookup by item id, built from the SHOP_ITEMS array. */
export const SHOP_ITEMS_BY_ID: Record<string, ShopItemDef> = {};
for (const item of SHOP_ITEMS) {
  SHOP_ITEMS_BY_ID[item.id] = item;
}
