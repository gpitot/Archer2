# Testing & Iteration Plan

> **Status (2026-07-15): Phases 1 and 2 are implemented.**
> - `pnpm sim [name]` / `pnpm test:sim` — headless scenarios in `scenarios/`
>   (harness: `scripts/harness/SimHarness.ts`), traces in `traces/*.jsonl`.
> - `pnpm trace <file> [--events|--entity id|--motion id|--diff|--range a:b]`
>   — inspector; ids can be prefixed `hero:`/`proj:`/`cosmetic:` (projectile
>   ids collide with hero ids — both use `p<N>`).
> - `?debug=1` — client records per-frame sim+view positions
>   (`src/testing/ClientTrace.ts`); `window.__game.debugIssue/debugState/
>   debugDumpTrace` drive it.
> - `pnpm drive` — Playwright: joins a room against wrangler dev, levels the
>   ability, fires arrows, writes `traces/client-arrow.jsonl`.
> First catch: the arrow-stutter bug (see `arrow-stutter-findings.md`).

Goal: let the agent debug gameplay by reading per-tick state logs instead of
screenshots. Screenshots stay as a last resort for purely visual issues.

The foundation already exists: `src/sim/` is pure/headless (`stepMatch` +
plain-data `MatchState`), and `scripts/smoke-sim.ts` proves it runs under
`tsx` with no browser. What's missing is reusable tooling around it.

## Phase 1 — Headless sim harness + tick traces (core, do first)

New `src/testing/SimHarness.ts` (importable from scripts and future tests):

- Wraps the boilerplate from `smoke-sim.ts`: load `assets/navdata.json`,
  `buildSimWorldFromNavdata`, `createMatchState`, seeded RNG.
- API: `spawnHero(id, team, pos)`, `issue(heroId, command)`, `tick(n)`,
  `runUntil(predicate, maxTicks)`, `state` accessor.
- **Trace recording**: every tick, append one JSON line to a `.jsonl` file in
  `traces/` (gitignored): tick number, per-hero `pos/hp/gold/level/state`,
  projectiles, and the `SimEvent[]` returned by `stepMatch`. Optional field
  filter to keep traces small.
- Tiny assertion helpers (`expectNear`, `expectEvent`) that print the failing
  tick range so the trace can be inspected around it.

Scenario runner:

- `scenarios/*.ts` files, each exporting an async `run(harness)` — e.g.
  `arrow-hit.ts`, `move-pathing.ts`, `shop-buy.ts`, `kill-respawn.ts`.
- `pnpm sim <scenario>` runs one and writes its trace;
  `pnpm test:sim` runs all and reports pass/fail.
- Port `smoke-sim.ts` to be the first scenarios.

Trace inspection CLI — `pnpm trace <file>`:

- `--events`: just the event timeline (tick + event).
- `--hero p1 --fields pos,hp`: per-tick values for one entity.
- `--diff`: only print ticks where selected fields changed.

This alone covers most gameplay debugging (movement, combat, gold/XP,
respawn, shop) with zero browser involvement, in <1s per run.

## Phase 2 — Live client debug hook + Playwright driver

For bugs that only show up in the real client (rendering, input, prediction,
net):

- In `main.ts`, when `?debug=1` is in the URL, expose `window.__game`:
  - `getState()` — JSON snapshot of the current client `MatchState`.
  - `issue(command)` — inject a hero command directly (no synthetic clicks).
  - Ring buffer of the last ~300 ticks (10s at 30Hz) of
    `{tick, stateSnapshot, events, netMessagesInOut}`; `dumpTrace()` returns
    it as JSONL.
- `scripts/drive.ts` (replaces the ad-hoc `test-*.ts` scripts over time):
  starts Vite (and optionally `wrangler dev`), opens headless Chromium with
  `?debug=1`, runs a scripted command sequence via `window.__game.issue`,
  then writes the dumped trace + console log to `traces/`, plus an optional
  screenshot. Same JSONL format as Phase 1 so the `pnpm trace` CLI works on
  both.

## Phase 3 — Later / nice-to-have

- **Prediction divergence check**: feed the same recorded inputs through a
  fresh headless sim and diff against the client trace to catch
  client/server desync.
- **Replay**: `pnpm sim --replay <trace>` re-runs recorded inputs for
  regression bisecting.
- **Headless server room test**: drive `server/GameRoom.ts` with two fake
  WebSocket clients under `wrangler dev`, tracing both clients' views.

## Non-goals

- No test framework dependency (vitest etc.) for now — plain `tsx` scripts
  with exit codes keep iteration instant. Easy to migrate later if wanted.
- No screenshot-based visual regression; screenshots remain manual-only.
