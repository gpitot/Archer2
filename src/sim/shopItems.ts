/**
 * The default shop catalogue, shared by client and server. Effects mutate the
 * plain `HeroState` — no Three.js, no view coupling.
 */
import { ShopItemDef } from './world';

/** Blink Dagger cooldown in seconds. */
export const BLINK_COOLDOWN = 10;

/** Crit chance granted by the Gem of Critical Strike (0–1). */
export const CRIT_CHANCE = 0.2;
/** Damage multiplier applied on a critical strike. */
export const CRIT_MULTIPLIER = 2;

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
  },
  {
    id: 'blink_dagger',
    name: 'Blink Dagger',
    cost: 15,
    description: 'Click to instantly teleport to target location (450 range, 10s cooldown)',
    apply: (_hero) => {
      // Effect is handled via the 'blink' command in stepMatch.
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
];
