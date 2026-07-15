# Arrow stutter — confirmed findings (2026-07-15)

> **FIXED (same day).** Measured with the two-client `pnpm drive`
> (shooter trace = own-arrow path, observer trace = interpolation path):
> before, 44 of 47 rendered steps were frozen with 180–240-unit teleports;
> after, both paths move at a constant 15 units/update with no real freezes.
> The fix, all in `Game.ts`:
> 1. Render clock (`_localTime` + EMA `_serverTimeOffset`) advances every
>    frame instead of being derived from the newest snapshot's tick.
> 2. `_renderProjectiles` rebuilds rendered projectiles each frame from the
>    snapshot straddling render time, back-extrapolating along `dir` by
>    `min(speed·behind, traveled)` — exact for straight-line arrows, renders
>    projectiles that appear in *any* snapshot for their full lifetime.
> 3. Own arrows fly fully locally (cosmetic keeps flying; obstacle collision
>    mirrors `stepProjectiles`; the server's `hit` event retires it). The
>    server's duplicate is hidden via `_ownArrowIds`, released only when the
>    *render* timeline passes its last-seen tick. If the cosmetic guard
>    suppressed the spawn, the server projectile renders as fallback.
> 4. Bonus fix: `_predictMovement` now ticks `abilityCooldown` while
>    standing still (it previously froze, blocking follow-up shots' cosmetics).
> Snapshot buffer pruning is now time-based (drop entries behind the
> straddling pair) instead of "keep last 5".

Reproduced with `pnpm drive` (network mode vs wrangler dev, `?debug=1` trace),
analyzed with `pnpm trace traces/client-arrow.jsonl --motion proj:p2`.

## Evidence

Per-frame view position of a server projectile (`traces/client-arrow.jsonl`):

- The arrow's rendered position changed **only** on frames where a snapshot
  arrived, and was frozen on **every** frame in between — 6 moving frames vs
  88 frozen frames, a 100% correlation.
- Motion pattern: `FREEZE ×10 → JUMP 180 units → FREEZE ×11 → JUMP 240 …`
  (headless RAF batching exaggerates the gap; at a healthy 60 fps the same
  mechanism yields ~3–4 frozen frames then a ~60-unit teleport, repeating —
  the visible stutter).
- Bonus find: the **first** arrow's server projectile (`p1`) was never
  rendered at all, and its cosmetic stand-in flew to max range unadopted.

## Root causes (in Game.ts, in order of impact)

1. **The interpolation clock only advances when a snapshot arrives.**
   `_interpolateEntities` computes
   `renderTime = latest.tick / 30 - INTERP_DELAY` — derived from the newest
   *buffered snapshot*, not from local wall clock. Between snapshot arrivals
   (66 ms at 15 Hz) `renderTime` is constant, so interpolated positions
   (projectiles *and* remote heroes) are frozen, then jump when the next
   snapshot lands. Fix direction: advance render time with the local clock
   (offset-synced to server ticks), so interpolation progresses every frame.

2. **Only the newest snapshot is applied.**
   `_updateNetwork` does `_applyServerState(snaps[snaps.length - 1])` — when
   several snapshots arrive in one frame, entities that lived only inside the
   skipped ones never reach `_state.projectiles` (that's how `p1` vanished).
   Projectiles also don't interpolate until they exist in ≥2 buffered
   snapshots (`_interpolateEntities` skips otherwise), so a new arrow's first
   ~2 snapshots render at raw latest-snapshot positions.

3. **Cosmetic → server handoff is discontinuous.**
   The cosmetic arrow flies in local real time; on adoption the view switches
   to the server projectile's interp-delayed position — ~130 ms + ½RTT behind,
   i.e. a 150–250 unit backward teleport. Adoption also pairs "oldest
   cosmetic" with "newest unadopted server projectile" (no id/direction
   matching), and if the server projectile's snapshots are missed entirely
   (cause 2), the cosmetic is never adopted and silently flies to max range.

## Also noticed while building the harness

- Projectile ids collide with player ids: `stepMatch` names projectiles
  `p${nextProjectileId}` and `GameRoom` names players `p${nextPlayerId}` —
  both produce `p1`, `p2`, … Harmless today (separate maps) but a landmine
  for any id-keyed lookup; trace tooling needs `proj:`/`hero:` prefixes to
  disambiguate.
- The interp-delay comment says the snapshot buffer keeps ~330 ms, but a
  burst of arrivals still evicts down to 5 entries in one frame
  (`while (length > 5) shift()`), which can throw away the pair that
  straddles the render time.
