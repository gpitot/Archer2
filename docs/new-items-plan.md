# New Items — Brainstorm & Implementation Plan

A catalogue of items to add to the JS game, organised by role. Each entry
includes cost, effect, and rough notes on what needs to change in the code.

---

## 1. Consumables — easy (reuse `consumable: true` + existing stat fields)

### 🧪 Healing Potion — 120g
> Restores 150 HP over 8 seconds. Interrupted by taking hero-sourced damage.

Needs a small `regenTimer` / `regenRemaining` field on `HeroState` and a tick
in `stepMatch` (similar pattern to the burn tick in `damage.ts`).
High impact because there's currently zero sustain outside fountains.

### ⚡ Elixir of Haste — 150g
> +40% move speed for 15 seconds.

Same pattern as rune buffs (`hasteTimer`) — already handled in
`stepRuneBuffs`. Trivial to add.

### 📕 Tome of Swiftness — 300g
> Permanently increases movespeed by +25.

Exact same skeleton as the existing Strength/Power tomes.
One-liner.

---

## 2. Passive / on-hit items — low effort (hook into `onProjectileHitHero`)

### 🩸 Vampiric Arrow — 1000g
> Heal for 20% of the damage your arrows deal to enemy heroes.

Needs a check inside the `onProjectileHitHero` hook — or better,
a new `onProjectileHit` hook that also fires for creeps.
Adds sustain for aggressive jungling and duelling.

### ☠️ Poison Bow — 900g
> Arrows poison enemies for 3s, dealing 5 + (2% of target max HP) per
> second. Does not stack; refreshes duration.

Uses the same `burnRemaining` / `burnDps` fields but with a fixed flat +
percentage formula. Complements Fire Bow (burst ignite) with a longer,
weaker, HP-scaling tick.

### ⚡ Lightning Bow — 1100g
> On arrow hit, lightning chains to 1 nearby enemy (prioritising heroes)
> within 250 range, dealing 50% of the hit's damage.

Would require a post-hit search in `stepMatch` after each projectile
resolves — a one-shot `sphereHitsObstacle`-free search for a nearby foe.
Adds AoE teamfight pressure.

---

## 3. Active items — medium effort (reuse `use` + `itemCooldowns`)

### 🌫️ Smoke Bomb — 250g (stackable, max 3 charges)
> Drop a cloud at your feet (300 radius, 6s). Enemy heroes inside lose all
> vision outside the cloud; heroes outside cannot see inside.
> Does not affect wards.

Requires a `smokeZones[]` array on `MatchState` + a step function similar to
`stepCreeps` to tick down timers and adjust fog for heroes inside.
Huge outplay potential at low cost.

### 🎯 Grappling Arrow — 800g
> Fire a hook in target direction (600 range). If it hits a tree/wall,
> pull yourself to that point over 0.4s. If it hits an enemy hero,
> pull them 200 units toward you.

Needs a fast invisible projectile + collision check (builds on the existing
projectile engine). Only hits one target — first obstacle or first hero.
Cooldown 12s.

### ✨ Mirror Image — 900g
> Create an illusion of yourself that runs in a straight line for 2s
> (no damage, no collision). Enemies see it as a real hero on the minimap
> and in fog.

Adds an `illusions[]` array — they're just projectiles with a hero model
and no hit logic. Breaks target lock and creates confusion.

---

## 4. Recipe / upgrade items — medium effort

The original WC3 map had an elaborate recipe tree where combining basic
items (gems, boots, bows) produced stronger versions. A simpler version
for the JS port:

### 👢 Boots of the Wind — 500g recipe (requires Boots of Speed)
> +120 move speed (replaces Boots' +60). Your Q arrows fly 15% faster.

Already have Boots (`speedBonus += 60`). The upgrade just doubles it and
adds a small arrow-speed multiplier to `HeroState`. The shop could show it
only when Boots is owned.

### 💎 Crown of Power — 800g recipe (requires Gem of Crit + Tome of Power)
> 25% crit chance (up from 20%), +20 ability damage (up from 10).
> Consumed — permanently replaces the two components.

Combines two existing items into one stronger, slot-efficient permanent
buff. The consumable nature frees two inventory slots.

---

## 5. Defensive items — new stat fields, medium effort

### 🛡️ Warden's Cloak — 700g
> Reduces all hero-sourced damage by 15%.

Needs a `damageReduction` field on `HeroState` applied inside
`rollAbilityDamage` and `dealDamageToHero`. Simple scalar.

### 💠 Null Barrier — 800g
> Gain a 120 HP shield that regenerates after 10s of taking no damage
> from heroes.

Needs `shieldHp: number; shieldMax: number; shieldRechargeTimer: number`
on `HeroState`. Shield absorbs damage before HP; recharge timer resets to
10s on every hero hit received.

---

## Quick summary table

| Item | Cost | Type | New state needed? |
|---|---|---|---|
| Healing Potion | 120g | Consumable | `regenTimer` (tiny) |
| Elixir of Haste | 150g | Consumable | None (reuse `hasteTimer`) |
| Tome of Swiftness | 300g | Consumable | None (reuse `speedBonus`) |
| Vampiric Arrow | 1000g | Passive | None (on-hit hook) |
| Poison Bow | 900g | Passive | None (reuse burn fields) |
| Lightning Bow | 1100g | Passive | `chainTarget` search |
| Smoke Bomb | 250g | Active | `smokeZones[]` array |
| Grappling Arrow | 800g | Active | Hook projectile logic |
| Mirror Image | 900g | Active | `illusions[]` array |
| Boots of the Wind | 500g | Recipe | `arrowSpeedBonus` on hero |
| Crown of Power | 800g | Recipe | None (composition) |
| Warden's Cloak | 700g | Passive | `damageReduction` field |
| Null Barrier | 800g | Passive | `shieldHp` + `shieldMax` |

---

## Recommended first batch (low-effort, high-impact)

1. **Healing Potion** — sustain doesn't exist yet
2. **Elixir of Haste** — reuses existing rune-buff code
3. **Vampiric Arrow** — on-hit hook, no new fields
4. **Poison Bow** — reuses burn fields, contrasts Fire Bow
