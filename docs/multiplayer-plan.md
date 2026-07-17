# Multiplayer Implementation Plan — Cloudflare Durable Objects

## Goal

Turn the current single-player sandbox into an online multiplayer arena using an
authoritative game server running in a **Cloudflare Durable Object** (one DO
instance = one match room), with the browser client connecting over WebSocket.

Guiding constraints (from the multiplayer brainstorm):

- **Simple** — plain Workers + Durable Objects via `wrangler`, no extra framework
  (no PartyKit/Colyseus). JSON messages first; optimize only if measured.
- **Easy to host** — one `wrangler deploy` ships both the static client (Workers
  Assets) and the game server. Free tier covers a hobby game (SQLite-backed DOs
  are available on the free plan).
- **Security is nice-to-have** — server is authoritative for movement, damage,
  gold, and scoring (that comes almost for free). Fog of war stays client-side;
  a hacked client could see through fog. Accepted for now.

## Architecture at a glance

```
┌──────────────┐   inputs (moveTo, fire, ward, buy)   ┌─────────────────────┐
│ Browser      │ ────────────── WebSocket ──────────► │ Worker (router)     │
│  render 60fps│ ◄──────────────────────────────────  │  └► GameRoom DO     │
│  predict own │      snapshots @15Hz + events        │      sim tick @30Hz │
│  interp rest │                                      │      (shared sim)   │
└──────────────┘                                      └─────────────────────┘
```

Both sides run the **same simulation code** (`src/sim/`) — the server as the
source of truth, the client for prediction of its own hero and for cosmetic
effects. This is the core payoff of the whole codebase being TypeScript.

Key netcode decisions, chosen to fit a click-to-move game (WC3/LoL style, not a
WASD shooter):

- **Server tick 30Hz**, snapshot broadcast every 2nd tick (15Hz).
- **Remote entities**: snapshot interpolation with a ~130ms buffer.
- **Own hero**: client runs the same pathfollowing locally the moment you click
  (instant feel), sends the command to the server, and softly reconciles toward
  the server position when they drift (lerp correction, snap if > 2 cells).
  Click-to-move makes this much simpler than input-replay prediction: both
  sides path over the same NavGrid, so drift is small.
- **Projectiles**: server-authoritative for spawn, flight, and hits. The client
  additionally spawns a *cosmetic* local arrow instantly when you fire, then
  adopts the server's projectile when it appears (so your own shots don't feel
  delayed by RTT).
- **Hit feedback** (damage numbers, kill credit, gold) comes only from server
  events — never computed client-side.

## Current state (what we build on)

- `GameLoop` is already a fixed-timestep loop (sim decoupled from render). ✔
- `NavGrid`, `Pathfinder`, and the wc3 parsers (`W3EParser`, `WpmParser`,
  `DooParser`) are already pure TS with no Three.js/DOM imports. ✔ Shareable as-is.
- `Hero` (540 lines), `Projectile`, `ArrowAbility`, `ObstacleRegistry`, `Shop`
  entangle simulation state with Three.js meshes. ✘ Must be split.
- `MapData.loadMapData()` uses Vite `?url` asset imports + `fetch` — unusable in
  a Worker. ✘ Needs a build-time preprocessing step.

---

## Phase 1 — Extract a shared, headless simulation (`src/sim/`)

The largest and most valuable refactor. After this phase the game still runs
single-player exactly as today, but the whole gameplay sim can run without a
browser.

**New directory `src/sim/` — rules: no `three`, no DOM, no Vite asset imports.**

1. **Math**: tiny `Vec3`/`Vec2` (`src/sim/math.ts`) replacing `THREE.Vector3` in
   sim code. Only needs add/sub/scale/length/normalize/distance/lerp.
2. **State types** (`src/sim/state.ts`): plain-data `HeroState` (id, team, pos,
   destination/path, hp, gold, xp, level, skillPoints, cooldowns, wardCharges,
   inventory, kills/deaths, respawnTimer), `ProjectileState`, `WardState`,
   `MatchState` (heroes, projectiles, wards, tick number, scores).
3. **Sim systems**: move the *logic* out of `Hero.update`, `Projectile.update`,
   `ArrowAbility`, `Shop.buy`, respawn/gold-income out of `Game.update`, into
   pure functions: `stepMatch(state, inputs, dt, world)` where `world` bundles
   NavGrid, Pathfinder, heightAt, and collision boxes. Obstacle collision moves
   from `ObstacleRegistry` (keeps meshes) into plain AABB data in `world`.
4. **World data for headless use** (`scripts/build-navdata.ts`, run via `tsx`
   like the existing screenshot script): parse `war3map.w3e/.wpm/.doo` at build
   time and emit `assets/navdata.json` containing pathing grid, a decimated
   height grid, doodad collision AABBs, arena rect, and shop position. Both the
   Worker and (optionally) the client load this instead of re-parsing — the
   client keeps parsing the real files for *rendering* (terrain textures,
   doodad art), but gameplay reads navdata so client and server agree exactly.
5. **Rendering becomes a view layer**: `Hero` slims down to `HeroView`
   (mesh, ArcherMesh, HealthBar) that *reads* a `HeroState` each frame; same
   for `ProjectileView`, `WardView`. `Game.update` becomes: gather local input →
   `stepMatch` → sync views.

**Acceptance:** `pnpm build` passes; single-player plays identically (move,
shoot dummy, shop, wards, fog, respawn); `grep -rl "from 'three'" src/sim/`
returns nothing; a smoke script can run `stepMatch` under `tsx` with no browser.

## Phase 2 — Worker + Durable Object server (`server/`)

1. **Scaffolding**: add `wrangler` dev-dependency and `wrangler.jsonc` at the
   repo root: static assets from `dist/` (Workers Assets), main module
   `server/index.ts`, DO binding `GAME_ROOM` → class `GameRoom` with a
   `new_sqlite_classes` migration (free-tier compatible).
2. **Routing** (`server/index.ts`): `GET /ws/:roomCode` → upgrade → forward to
   `env.GAME_ROOM.idFromName(roomCode)`. Everything else falls through to
   static assets.
3. **`GameRoom` DO** (`server/GameRoom.ts`):
   - Accept WebSockets via the hibernation API (`ctx.acceptWebSocket`) with a
     per-socket attachment holding playerId/name.
   - Load `navdata.json` (imported as a module or bundled asset) and build the
     shared `world` once per DO instantiation.
   - On first join: start a 30Hz `setInterval` tick calling `stepMatch`; stop it
     when the last socket closes (lets the DO evict). A match in progress keeps
     the DO pinned — that's expected and cheap at this scale.
   - Queue client inputs as they arrive; apply them on the next tick.
   - Every 2nd tick, broadcast a snapshot; broadcast discrete **events**
     (hit, kill, respawn, purchase, matchEnd) as they happen.
4. **Protocol** (`src/sim/protocol.ts`, shared): JSON for v1.
   - client→server: `join {name}`, `input {seq, cmd}` where cmd is
     `moveTo {x,z}` | `fire {aimX,aimZ}` | `ward` | `buy {itemId}` |
     `levelAbility`.
   - server→client: `welcome {playerId, tickRate, snapshot}`,
     `snapshot {tick, heroes[], projectiles[], wards[]}` (full state — at ≤10
     players it's a few KB; deltas only if measured to matter), `event {…}`,
     `peerJoined/peerLeft`.
5. **Local dev**: `pnpm dev:server` = `wrangler dev`; Vite dev server proxies
   `/ws` to it (`vite.config.ts` `server.proxy`). Two terminal workflow, or a
   single `pnpm dev:mp` script.

**Acceptance:** `wrangler dev` runs; a `tsx` test script opens two WebSockets to
the same room, sends `moveTo`, and observes both heroes converging in received
snapshots — no browser involved.

## Phase 3 — Client networking (`src/net/`)

1. **`NetworkClient`**: connect/reconnect, seq-numbered input sending, snapshot
   ring buffer, server-clock offset estimate, ping measurement.
2. **`Game` gains a network mode** (offline mode stays for `pnpm dev` testing):
   - Input handlers now *both* apply commands to the local predicted sim *and*
     send them to the server.
   - **Remote heroes/projectiles/wards**: rendered from snapshot interpolation
     at `serverTime − 130ms`. Spawn/despawn views as entities appear/vanish.
   - **Own hero**: local sim runs it; each snapshot, compare with server state —
     small drift lerps away over ~200ms, large drift snaps. HP/gold/cooldowns
     always adopt server values.
   - **Events** drive floating damage text, kill feed, K/D, gold, and shop
     results.
   - Fog of war: unchanged, client-side, driven by the interpolated positions
     of your team's units.
3. **Own-shot cosmetics**: fire → local cosmetic arrow immediately; when the
   server projectile with your ownerId appears, hand the view over to it.

**Acceptance:** two browser windows on one machine, same room: both see each
other move smoothly, arrows hit and deal damage identically in both views,
kills/gold/respawn work, own hero movement feels instant, remote hero motion is
smooth (no teleporting) with simulated latency (Chrome devtools throttling).

## Phase 4 — Rooms, lobby, and match flow

1. **Join flow**: landing overlay — enter name, create room (random 4-letter
   code) or join by code; room code reflected in URL (`?room=XYZQ`) for link
   sharing. Team = unique per player (FFA), distinct hero tint per player.
2. **Match flow in the DO**: lobby state → host clicks start (or auto-start at
   N≥2) → countdown → play → first to `TARGET_SCORE` kills wins → results
   screen → return to lobby for rematch. Reject joins above `MAX_PLAYERS` (8).
3. **Disconnect handling**: hero despawns after a grace period (30s) so a
   refresh can reclaim it by playerId token stored in `sessionStorage`.

**Acceptance:** full match loop with 3 clients: create, share link, join, start,
play to score, results, rematch.

## Phase 5 — Polish and deploy

1. Ping/latency indicator; "connection lost — reconnecting" UI.
2. Interpolation-buffer tuning under real latency; clamp/validate inputs
   server-side (destination walkable, cooldown respected, gold sufficient) —
   cheap authority wins we get for free from sharing the sim.
3. **Deploy**: `pnpm build` then `wrangler deploy` → `archer.<account>.workers.dev`
   serves client + game server. Document in README.
4. Playwright smoke test: launch two headless contexts, join one room, one fires
   at the other, assert HP drop in both — wired into the existing
   `scripts/` + Playwright setup.

---

## Durable Object specifics worth knowing

- **One DO = one room** gives free serialization: all messages for a room hit a
  single-threaded object — no locks, the tick loop and message handlers never
  race.
- **SQLite-backed DOs run on the free tier** (`new_sqlite_classes` migration).
  We barely use storage — match state is ephemeral, in-memory.
- **Hibernation** won't kick in during a match (the tick interval keeps the DO
  active); it only helps idle lobbies. Fine — duration cost at hobby scale is
  pennies. Stop the interval when the room empties.
- **CPU limits**: 30Hz stepping of ≤8 heroes + ~20 projectiles over a static
  navgrid is microseconds per tick — far below Workers CPU limits. Snapshot
  JSON stringify is the biggest cost; still trivial at 15Hz.
- **Placement**: the DO is created near the first joiner; players on other
  continents get their latency to that room. Acceptable for friends-play.

## Suggested order & sizing

| Phase | Scope | Risk |
|-------|-------|------|
| 1. Shared sim extraction | Big refactor, no behavior change | Highest — touches Hero/Projectile/Game |
| 2. DO server skeleton | New, isolated code | Low |
| 3. Client networking | New code + Game wiring | Medium — feel/tuning work |
| 4. Rooms & match flow | Mostly UI + DO state machine | Low |
| 5. Polish & deploy | Small tasks | Low |

Phase 1 is deliberately front-loaded: it's pure refactor with a hard "game still
plays identically" gate, and everything after it is additive.
