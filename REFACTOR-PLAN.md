# Refactor plan: registry-driven sim, generic ability state, decomposed client

Goal: behavior-preserving refactors that make new spells, active items, and unit
types cheap to add. Six phases, each independently landable and verified against
golden traces.

## Progress

| Phase | Status | Commit |
|---|---|---|
| 0 — Baseline capture | ✅ done | (baseline traces in session scratchpad; 16/16 sim pass, build clean, drive OK) |
| 1 — Sim-internal dedup | ✅ done | `0640dd5` |
| 2 — Ability registry | ✅ done | `fdb833d` |
| 3 — Generic ability/item runtime records + wire bump | ✅ done | `9014e2e` |
| 4 — Item registry with behavior hooks | ✅ done | uncommitted (working tree) |
| 5 — Unit substrate | ⬜ not started | — |
| 6 — Game.ts decomposition | ⬜ not started | — |

**Phase 3 verification so far:** ✅ tsc clean · `pnpm sim` 17/17 (item-actives added)
with traces byte-identical to the pre-refactor baseline for all 16 original
scenarios · `smoke-sim` passes · `pnpm build` clean · `pnpm drive` 3 arrows
end-to-end.

## Context (from the audit)

- **Spells were the #1 friction.** No registry — each of the 4 abilities was
  hardcoded across ~7 files (Command union, dedicated HeroState fields, cast
  fns + 7 manual cooldown blocks in stepMatch, protocol.ts wire fields,
  hand-mirrored in `GameRoom._heroMetas` and `Game._applyMetaFields`). Any new
  cold hero field had to be added in 4 unenforced places.
- **Items half data-driven**: ice_bow/blink/wards bypass `apply()` with
  `inventory.includes()` checks and command cases hardcoded in stepMatch.
- **Heroes and creeps share zero code**: parallel state interfaces, damage
  skeleton triplicated, crit+rune prelude copy-pasted 4×, movement fully split.
- **Game.ts is a 2278-line god class**: bootstrap, inline keybindings, netcode,
  a cosmetic-projectile mini-sim, per-type view-sync diff loops, all HUD.
- **Vision is the one well-factored area** (`VisionSource` → `FogOfWar._sweep`)
  — left alone.

## Guiding decisions

- **D1**: Ability level/cooldown/charges live in `Record<AbilityId,
  AbilityRuntime>` on state and wire (atomic protocol bump in Phase 3). Both
  sides build the record from shared `ABILITY_ORDER` for determinism.
- **D2**: Unify hero/creep via a `UnitCore` base interface + shared helpers,
  NOT merged arrays (iteration-order determinism; different wire treatment).
  Hero pathfinding vs creep straight-line stays intentionally different.
- **D3**: Game.ts gets 4 extractions (ViewSync, NetSync, InputBindings, Hud);
  camera/fog/targeting/cosmetics stay.
- **D4**: Verification backbone = golden traces. Behavior-preserving phases
  must produce byte-identical `pnpm sim` traces (16 scenarios) and the same
  known-failure signatures; client phases add `pnpm build` + `pnpm drive`.

## Phase 1 — Sim-internal dedup ✅ (`0640dd5`)

- `src/sim/projectiles.ts`: `spawnProjectile` (id + `fire` event),
  `advanceProjectile` (shared with Game's cosmetic arrows), `findHitHero`
  (merged `hitHero` / `hitHeroByCreepProjectile`).
- `src/sim/damage.ts`: `rollAbilityDamage` replaces 4 copies of the
  crit + rune-multiplier prelude.
- `beginCast`/`aimDir` cast preamble (scout's no-invis-break quirk preserved
  and flagged as a possible bug).
- One `spiralSearch` core in `sim/world.ts` behind `findReachableNear` /
  `findWalkableNear` / `findWalkableNearOnGrid` / `findWalkableCellNear`;
  Game.ts spawn helpers + `buildDefaultFountains` now share it.
- `ICE_BOW_*` constants moved to `shopItems.ts`.
- `HeroView` animation cadence uses the sim's `heroSpeed()` (was a hand-copied
  formula — silent desync landmine).

## Phase 2 — Ability registry ✅ (`fdb833d`)

- `src/sim/abilities.ts`: `AbilityDef` registry (slot, kind, rank caps,
  cooldown table, targeting kind, `canCast`, `cast`, per-tick `tick`).
- Command union: 4 cast variants → `{ type: 'cast'; ability; x?; z? }`;
  `levelAbility` takes `AbilityId`. (Client→server command wire changed
  atomically; scenarios/scripts updated.)
- `applyCommand`/`spendSkillPoint` dispatch through the registry; `stepHero`'s
  7 cooldown blocks → one `ABILITY_ORDER` loop; Game's idle prediction runs
  the identical loop.
- Game keybindings: one registry loop (aim/point/self) replaces bespoke QWER
  handlers; shared `canCast()`; `_activateAbilityTargeting(def)`.
- SpellBar: `update(SpellSlotInfo[])`, slots built from the registry.

## Phase 3 — Generic runtime records + HeroMeta wire bump ✅ (uncommitted)

- `state.ts`: 13 flat ability fields → `abilities: Record<AbilityId,
  AbilityRuntime>` (`{ level, cooldown, charges?, recoil?, active?,
  activeTimer? }`), `blinkCooldown` → `itemCooldowns: Record<string, number>`;
  `createAbilityRuntimes()` (in abilities.ts) seeds keys in `ABILITY_ORDER`,
  arrow at rank 1 / full charges.
- `abilities.ts`: defs operate directly on `hero.abilities[id]`; the Phase-2
  accessor bridge deleted.
- `protocol.ts` HeroMeta: flat fields → `abilities` + `itemCooldowns` records.
  Buff timers (dd/haste/invis/slow) stay named.
- `GameRoom`: `_wireAbilities`/`_wireItemCooldowns` generic quantized encode —
  the "add a cold field in 4 places" checklist is dead.
- `Game._applyMetaFields`: generic record copy; the local-player carve-out
  (don't overwrite own predicted cooldown/charges/recoil) kept arrow-only,
  exactly as before.
- `stepHero`: item cooldowns tick via one insertion-ordered loop.
- SimHarness trace lines keep the old JSON keys (read from the record) so
  golden traces stay byte-comparable across the migration.

**Next step: commit Phase 3.**

## Phase 4 — Item registry with behavior hooks ⬜

Extend `ItemDef` in `src/sim/shopItems.ts` (move the type from `world.ts`,
re-export for compat):

- `apply?(hero)` — passive stats (boots, crit gem), unchanged.
- `use?: { targeting: 'point' | 'self'; range?; cooldown?; execute(ctx) }` —
  active items; cooldown goes through `hero.itemCooldowns[id]`.
- `onProjectileHitHero?(source, target)` — on-hit effects.

Steps:
1. ice_bow → `onProjectileHitHero` hook; `stepProjectiles` loops the source's
   inventory defs in slot order (deterministic). Slow factor stays a named
   export consumed by `heroSpeed`.
2. blink_dagger → `use.execute` = current `blink()`; delete `Command 'blink'`
   → generic `{ type: 'useItem'; slot; x?; z? }` (atomic command change).
3. sentry_wards → `use.execute` = `placeWard`; `useItem` switch → registry
   dispatch.
4. Game.ts Digit1–6 handler → generic targeting/enqueue off `def.use`;
   ItemBar cooldowns read `itemCooldowns` generically.

Do NOT build stacking/recipes/stat-aggregation or hooks with no consumer.
Verify: sim traces byte-identical; drive spot checks (buy ice bow → slow,
blink teleports with cooldown, wards place/expire).

## Phase 5 — Unit substrate ⬜

1. `state.ts`: `interface UnitCore { id; pos; facing; hp; alive; respawnTimer;
   level }`; `HeroState`/`CreepState` extend it. Per-type arrays stay (D2).
2. `damage.ts` grows: `dealDamageToHero(state, target, source:
   {kind:'hero'|'creep'}, …)` unifying `applyDamage` + `applyCreepDamageToHero`
   (shared guard/clamp/hit-event/killHero; kill credit gated on
   `source.kind === 'hero'`; event order preserved; thin wrappers kept). Same
   for `dealDamageToCreep`.
3. `src/sim/movement.ts`: `turnToward` (from `updateFacing`),
   `stepStraightLine` (from `moveCreep`), `stepPath` (from `moveAlongPath`).
   Heroes/creeps keep distinct AI, share the math.
4. Header comment in stepMatch documenting the "add a unit type" recipe.

Do NOT merge heroes/creeps arrays, give creeps buffs/crit, unify facing
behavior, or introduce an ECS. Verify: byte-identical traces, especially the
creep scenarios; `scripts/test-creeps.ts`.

## Phase 6 — Game.ts decomposition ⬜ (client-only, land each separately)

1. `src/core/ViewSync.ts`: generic `syncKeyedViews(views, states, create,
   sync, dispose?)` replacing the duplicated diff loops (blast/projectile/
   ward/hero); scout vision-adapter bookkeeping moves into create/dispose
   callbacks.
2. `src/core/NetSync.ts`: snapshot buffer, interp clock, remote projectiles;
   merge the duplicated hero/creep interpolation loops into one generic
   `{id,pos,facing}` lerp. Prediction stays in Game.ts.
3. `src/core/InputBindings.ts`: `bindGameInput(...)` — registry loop +
   shop/item/camera keys.
4. `src/core/Hud.ts`: minimap markers + spell bar + portrait/gold/itembar/KD/
   shop overlay updates out of `_render`.
5. Merge `_updateOffline`/`_updateNetwork` copy-pasted tails into
   `_updateCommon`.

Do NOT move fog application, camera, targeting activation, or cosmetic
projectiles; no event bus/DI; preserve network update ordering
(reconcile → interpolate → predict) and its comments.
Verify: `pnpm build`, `pnpm drive`, `pnpm shot` screenshot compare, offline
smoke (`pnpm dev`, `?map=test`).

## Verification recipe (every phase)

```sh
pnpm sim          # 16/16, byte-diff traces vs baseline (re-baseline after 3/4)
npx tsc --noEmit  # clean
pnpm drive        # client-touching phases: arrows fire/reconcile end-to-end
```

Baseline traces live in the session scratchpad `baseline/` dir. Drive traces
(`client-*.jsonl`) are NOT byte-comparable across runs (real-time sampling) —
compare the summary lines instead. Leave `server/navdata.ts` / `buildWorld.ts`
byte-match path untouched.
