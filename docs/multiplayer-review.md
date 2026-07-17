# Multiplayer implementation review

Review of the last two commits:

- `7caabc5` — multiplayer implementation (shared sim, DO server, client net)
- `850e765` — client optimistic updates (prediction, reconciliation, interpolation, cosmetic arrows)

Ordered by severity.

---

## 1. 🔴 Remote entities never move — interpolation is dead

`src/core/Game.ts:634` `_interpolateEntities()`

This is the headline bug. Remote heroes/projectiles are frozen at their spawn
position on every other client.

- The server broadcasts a snapshot every 2nd tick → **66.7 ms** apart (15 Hz).
- `INTERP_DELAY` is **130 ms** and the function only ever reads the **last two**
  snapshots:
  ```
  prevTime   = latest.tick/30 - 0.067
  renderTime = latest.tick/30 - 0.130
  if (renderTime <= prevTime) return;   // 0.130 > 0.067 → ALWAYS returns
  ```
  `renderTime` always lands *before* `prevTime`, so the guard trips every frame
  and no interpolation is written.
- Remote hero `pos` is written **nowhere else**: `_applyServerState` copies state
  via `_copyHeroState`, which intentionally omits `pos`/`facing`/`path`. So with
  interpolation short-circuited, remote heroes sit at spawn forever (and remote
  projectiles never advance).

**Fix:** search the snapshot ring buffer for the two snapshots that *straddle*
`renderTime` (typically `[len-3]`/`[len-2]` at this delay), not the last two. Or
reduce `INTERP_DELAY` below the snapshot interval (not recommended — 1 snapshot
of buffer is too little). The buffer is already kept at 5, so the data is there;
only the selection is wrong.

## 2. 🔴 State/snapshot aliasing corrupts the interpolation source

`src/core/Game.ts:509` and `:498`

Once bug #1 is fixed this bites immediately:

- `_applyServerState` does `this._state.projectiles = snap.projectiles` — a
  reference to the *same* object array held in `this._snapshots`.
- Remote heroes are created with `local = { ...sh }`, a shallow copy, so
  `local.pos === sh.pos` — aliasing a snapshot's hero-pos object.
- `_interpolateEntities` then writes `hero.pos.x = prevH.pos.x + …` and
  `proj.pos.x = …`, mutating objects that are still referenced inside the
  snapshot buffer. The next frame reads back corrupted `prev`/`latest` values →
  compounding drift / jitter.

**Fix:** deep-copy `pos` (and the projectile list) when adopting snapshot data
into `_state`, or interpolate into the *view* rather than back into `_state`.

## 3. 🟠 Team numbers collide after players leave and rejoin

`server/GameRoom.ts:101`

```ts
const hero = createHeroState(playerId, this._players.size - 1, spawn);
```

Team is derived from the current player count, not a stable slot. Sequence
A(0) B(1) C(2) → B leaves (size 2) → D joins → `size-1 = 2` → D gets team **2**,
colliding with C. Team drives friend/foe and fog, so two players end up on the
same side. Allocate teams from a free-slot pool (track used team ids, reuse the
lowest free one) instead of `size - 1`.

## 4. 🟠 Cosmetic arrow fires even when the shot is invalid

`src/core/Game.ts:829` → `_spawnCosmeticProjectile` (`:673`)

The client spawns the local arrow for **every** `fire` command, but the server
(`fireArrow`, `stepMatch.ts:117`) rejects the shot when `abilityCooldown > 0` or
`abilityLevel < 1`. Pressing Q on cooldown, or before learning the ability,
shows a ghost arrow that flies and vanishes with no hit and no matching server
projectile (it will never be adopted). Mirror the server's guard in
`_spawnCosmeticProjectile` before spending a pool slot. (With `abilityLevel === 0`,
`rangeByLevel[0] === 0` so it also self-retires at range 0 — harmless but sloppy.)

## 5. 🟠 Debug `console.log` in hot paths (server + client)

- Server logs **every** input (`GameRoom.ts:124`) and every tick that has inputs
  (`:177`) — inside a Durable Object, per player, at 30 Hz.
- Client logs every frame that a snapshot arrives: `[apply]` (`Game.ts:467`),
  `[pred]` (`:581`, `:595`, `:608`), `[net]` (`:828`, `:837`).

This is per-frame / per-tick spam — noise and measurable overhead. Strip or gate
behind a debug flag before this is anything but local dev.

## 6. 🟡 Reconciliation lerp is dead code; only hard-snap exists

`src/core/Game.ts:529` `_reconcileFromSnapshot`, `:614` `_applyReconciliation`

The design (and the `multiplayer-plan.md` Phase 3) calls for *soft* lerp
correction on small drift and a snap on large drift. In practice
`_reconcileTarget` / `_reconcileTimer` are **only ever cleared, never assigned**,
so `_applyReconciliation` is a no-op and the only correction is the
`> SNAP_THRESHOLD` (64) hard snap. Below 64 units the client and server positions
silently diverge with no correction. Either wire up the lerp
(`RECONCILE_DURATION` is defined and unused) or delete the machinery and document
that only snapping is used.

## 7. 🟡 No reconnect / disconnect grace; Phase 4 flow absent

- `NetworkClient.connect` never reconnects on `onclose`; a dropped socket ends the
  match for that client with no retry (Phase 5 item, but worth flagging).
- `webSocketClose` (`GameRoom.ts:136`) removes the hero immediately — no 30 s
  grace / `sessionStorage` reclaim from the plan, so a refresh loses your hero,
  gold, and score.
- Lobby / match-flow / win-condition (Phase 4) and input validation clamping
  (Phase 5) are not implemented. `moveTo` passes raw client `x,z` (possibly NaN)
  straight into the pathfinder with no bounds check.

## 8. 🟡 Duplicated snapshot-apply logic

`_applySnapshot` (`:415`) and `_applyServerState` (`:464`) are ~90% identical
view-management code that has already drifted (one copies pos, the other doesn't;
one logs, the other doesn't). Consolidate to one code path to avoid the two
falling further out of sync.

---

## Smaller notes

- `hitHero` (`stepMatch.ts:283`) comments "first live **enemy** hero" but never
  checks team — fine for pure FFA (teams are unique per player) but the
  `team`/`p.team` fields are dead weight and will allow friendly fire the moment
  teams are shared.
- Snapshots serialize the full `HeroState` including the entire `path[]` waypoint
  array for every hero at 15 Hz. Harmless at this scale but the plan's "deltas
  only if measured" note applies; `path` in particular is never read by remote
  view code.
- `_predictMovement` runs the *full* `stepMatch` (projectiles, income, wards,
  tick++) on a temp state each frame just to move one hero. Works because temp is
  discarded, but it also applies `fire`/`buy`/`ward`/`levelAbility` to the real
  player object as a side effect (they get reconciled away by the next snapshot).
  Intentional-ish, but fragile — a dedicated `stepHeroMovement` would be clearer.
</content>
</invoke>
