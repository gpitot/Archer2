# AI Opponent for Offline Mode — Implementation Plan

## Goal

When not in a room (`?room=` absent), the enemy hero — today the inert `'dummy'`
on team 1 (`Game.ts` offline init) — plays the game: moves, aims and leads
arrows, dodges, uses R/blink, farms creeps, grabs runes, shops, levels spells,
heals at fountains. The AI has **perfect information** (reads the full
`MatchState`, ignores fog) and should be **as strong as possible** — no
artificial aim jitter or reaction delay by default (keep knobs for later tuning).

## Why this is cheap architecturally

Offline mode already runs the authoritative sim locally: `_updateOffline()`
drains player commands into `HeroInput[]` and calls `stepMatch(state, inputs,
dt, world)`. The dummy hero is a full `HeroState` that already renders,
takes damage, dies and respawns. The AI is therefore **purely a command
producer**: a pure function of `(MatchState, SimWorld)` that returns
`Command`s for its hero id, appended to the same `inputs` array each tick.
No sim changes, no new state fields, no protocol changes.

Placing it under `src/sim/ai/` (pure data + `sim/` imports only, no
three/DOM) keeps it usable by the server `GameRoom` later (bots in rooms —
out of scope but free) and by the headless harness for tests.

## Module layout

```
src/sim/ai/
  AiController.ts   — per-hero orchestrator: think-rate throttle, macro FSM, command emission
  aim.ts            — intercept solver (lead shots), line-of-fire check
  threat.ts         — incoming-arrow intercept detection, blast-zone danger, fight-win estimate
  build.ts          — skill build order + shop build order (data tables)
```

`Game.ts` gets ~10 lines: construct `AiController('dummy', …)` in the offline
branch, and in `_updateOffline` push `this._ai.think(this._state, this._world, dt)`
into `inputs` before `stepMatch`.

## Design

### Think cadence & command discipline

- Run decisions at ~10 Hz (accumulator inside the controller), not every 60 Hz
  frame — pathfinding (`moveTo` triggers `findSmoothedPath`) and LoS sampling
  are the costs. Threat responses (dodge cast) run every tick since timing is
  frame-critical; they're cheap.
- Re-issue `moveTo` only when the destination changed by > ~64u or after a cast
  (casting calls `stopMovement`, so stutter-stepping requires a fresh `moveTo`
  after every shot).
- Multiple commands in one tick are fine (`levelAbility` + `cast` + `moveTo`);
  `stepMatch` applies them in order.

### Macro layer — utility-scored states

Score each mode every think tick, hysteresis (+bias to current mode) to avoid
flapping:

| Mode | Trigger | Behaviour |
|---|---|---|
| **FIGHT** | enemy in ~arrow range and fight is winnable | kite + shoot (micro layer below) |
| **CHASE** | winnable but out of range | path to predicted enemy position; blink to close if kill secured |
| **FLEE/HEAL** | losing fight estimate or hp < ~35% | path to nearest fountain; blink defensively; dodge incoming |
| **RUNE** | active rune (perfect info: `state.runes[].active`) worth the detour | grab DD/haste before fighting |
| **SHOP** | gold ≥ next build item and safe | path into `shop.interactRadius`, emit `buy` |
| **FARM** | nothing better; creeps alive | kill camps: stay at max range vs melee creeps, respect leash; ranged camps burst |

Fight-win estimate (in `threat.ts`): compare hp, arrow charges + cooldowns,
ability ranks, DD/haste buffs, level — perfect info makes this exact. This is
what makes the bot feel smart: it disengages before it loses, and turns on the
player the moment the trade flips.

### Micro layer — combat

**Aiming (`aim.ts`)** — the core of "as strong as possible":
- Lead shots: closed-form intercept of arrow (speed 900, from
  `hero.pos + dir*spawnOffset`) vs target velocity. Target velocity is exact:
  `path[0]` direction × `heroSpeed(target)` when `moving`, zero otherwise.
  Quadratic solve; no solution → don't fire.
- Line-of-fire: sample the segment every ~20u with
  `sphereHitsObstacle(world, p, ARROW.collisionRadius)`; also abort if a
  friendly-blocking situation ever exists (n/a today, 1v1).
- Hold fire while the target's dodge window is active — perfect info includes
  `target.abilities.dodge.active/activeTimer`, so the AI waits out the window
  and fires the instant it closes (also: never shoot invulnerable respawners).
- Fire gate: charge available, `recoil ≤ 0`, intercept distance ≤
  `ARROW.rangeByLevel[rank]` minus a safety margin.
- Kiting: hold the range band (~0.75× max range); alternate
  shoot → `moveTo` (perpendicular-ish jink or range-keeping step) → shoot,
  respecting the 0.2s recoil.

**Dodge (W), every-tick threat scan (`threat.ts`):**
- For each enemy-team projectile (non-scout), project its line vs our hero's
  current/predicted position; if the closest approach < hit radius
  (`HERO.bodyRadius + ARROW.collisionRadius` + margin), compute time-to-impact.
- Cast dodge when time-to-impact < dodge duration at current rank (cast as late
  as safe — one tick of margin — so one dodge eats multiple arrows if possible).
  If dodge is down, emit a perpendicular `moveTo` sidestep instead (works at
  distance; arrows are only speed 900 vs hero 350+).

**Blast (R):** the 1.5s fuse means it only lands on constrained targets. Cast at
the predicted-1.5s position when: target stationary (shopping, at fountain,
attacking creeps), or target's reachable-area-in-1.5s is mostly inside the
250 radius (close range / cornered), or as guaranteed damage on top of our own
position when the player is melee-chasing. Never overlap own team check needed
(sim already skips same team).

**Blast avoidance:** `state.blasts` is global state — if standing inside an
enemy blast radius, immediately `moveTo` the nearest point outside
(radius + margin along the exit vector, snapped walkable).

**Items:** `useItem` by slot — blink dagger offensively (secure kill within
range) and defensively (drop aggro when fleeing, off cooldown check via
`itemCooldowns`).

### Progression (`build.ts`)

- **Skills:** emit `levelAbility` whenever `skillPoints > 0`. Order: R at hero
  levels 6/11/16, else max Q, then W, then E. (E scout and sentry wards grant
  vision the perfect-info AI doesn't need — E is skilled last and never cast;
  wards are not bought. This is a deliberate consequence of the perfect-info
  spec.)
- **Shop:** build order `boots → ice_bow → crit_gem → blink_dagger` (ice bow's
  slow is the strongest duel item; boots first for kiting supremacy). SHOP mode
  activates when gold covers the next item; `buy` only fires inside
  `interactRadius` (sim enforces it anyway).

### Determinism & purity

All decisions are pure functions of `(state, world, internal throttle timers)`.
Any randomness (e.g. jink direction) takes an injected `rng` like `stepMatch`
does. No `Math.random`, no Date, no DOM — so harness runs are reproducible.

## Implementation phases

1. **Wiring + skeleton** — `AiController` with skill-point spending, CHASE +
   naive shoot-at-current-position, FARM fallback. Hook into `_updateOffline`.
   Playable immediately (`pnpm dev`, no `?room=`).
2. **Aim** — intercept solver, LoS sampling, dodge-window hold-fire, range
   gating, kite band + stutter-step. (This alone makes it dangerous.)
3. **Defense** — arrow-intercept dodge timing, sidestep fallback, blast-zone
   evacuation.
4. **Macro** — utility FSM (FIGHT/CHASE/FLEE/RUNE/SHOP/FARM), fight-win
   estimate, fountain healing, item build + blink usage, blast casting policy.
5. **Tuning & hardening** — think-rate/pathfind throttles, hysteresis tuning,
   scenario suite green, difficulty knobs surfaced (reaction delay / aim error /
   think rate, all defaulting to max strength).

## Testing (headless, per repo workflow)

New scenarios under `scenarios/` driven by `SimHarness` (AI attached as a
command producer identically to Game.ts — same code path):

- `ai-kills-static.ts` — AI kills a stationary drone within N seconds.
- `ai-leads-moving-target.ts` — hit rate vs a strafing scripted drone above a
  threshold.
- `ai-dodges.ts` — scripted drone volley; AI survives with dodge/sidestep.
- `ai-blast-avoid.ts` — AI exits an enemy blast circle before detonation.
- `ai-flees-heals.ts` — low-hp AI reaches a fountain instead of fighting.
- `ai-farms-shops-levels.ts` — over 120s sim: gold earned, items bought in
  order, skill points spent, no stuck movement (positions keep changing).
- `ai-vs-ai.ts` — two controllers, full match sanity: no crashes, kills happen
  on both sides, no pathological stalemate.

Debug via `pnpm sim` / `pnpm trace` state traces (not screenshots). Note the
pre-existing combat-rework baseline failures (sim arrow-hit / kill-respawn,
test-damage, terrain arrow check) — don't chase those.

## Out of scope

- Bots in networked rooms (architecture supports it later via `GameRoom`).
- Fog-limited (fair-vision) AI — perfect info is per spec.
- Multiple AI heroes / team fights (controller is per-hero, so this is easy later).
- Difficulty levels UI (knobs exist internally, always max for now).
