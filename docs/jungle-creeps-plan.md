# Jungle Creeps — Implementation Plan (v2)

## Overview

Neutral monster camps at fixed map positions. Each camp is themed around a
unit archetype — **melee ghouls** that chase and claw, **ranged dragons**
that stand off and spit fireballs — and camps can mix both. Creeps soft-leash
to their camp, respawn 60 s after dying with escalating level/stats/rewards,
and give players who are behind a way to farm gold/XP without hunting heroes.

This revises the v1 draft, which was melee-only and had several problems:

| v1 issue | v2 fix |
|---|---|
| Melee-only | Data-driven `CREEP_TYPES` (melee + ranged), per-camp unit lists |
| No ranged path; reusing `ProjectileState` naively corrupts hero kill-credit (`kills++`, first blood, bounty) | `ownerKind: 'creep'` discriminator + a separate creep-damage path; hero-vs-hero code untouched |
| Hardcoded camp coords (e.g. `(-2200, -1800)`) fall **outside** the arena rect (x ∈ [-2784, 4416], z ∈ [-512, 6720]) | Camps placed as **fractions of `world.arena`** — works on both `arena` and `test` maps |
| New creep id per respawn defeats client entity tracking | **Stable ids** for the whole match; respawn is an event |
| Camp init misses GameRoom's map-switch reset path | `_resetMatch()` helper called from **both** reset sites |
| Creep movement only checks obstacles (doodads), not the navgrid (cliffs/water) | Movement rejects steps into unwalkable cells too |
| No performance/bandwidth design; no authority statement | §5 Performance and §6 Server authority below |

Architecture this builds on: a deterministic headless sim (`src/sim/`) shared
verbatim by the Cloudflare Durable Object server (`server/GameRoom.ts`, 60 Hz
tick, quantized JSON snapshots with piggybacked events, cold "meta" fields at
4 Hz) and the three.js client (`src/core/Game.ts` — offline mode runs
`stepMatch` locally, online mode interpolates snapshots).

---

## 1. Data Model

### 1.1 New file `src/sim/creepRules.ts` (pure data, mirrors `rules.ts`)

```ts
export type CreepTypeId = 'ghoul' | 'dragon';

export interface CreepTypeDef {
  kind: 'melee' | 'ranged';
  bodyRadius: number;            // projectile hit tests
  baseHp: number;  hpPerLevel: number;
  baseDamage: number;  damagePerLevel: number;
  speed: number;                 // world units / s
  aggroRange: number;
  attackRange: number;           // melee reach / ranged stand-off distance
  attackCooldown: number;        // seconds
  // ranged only
  projectileSpeed?: number;
  projectileRangeSlack?: number; // maxRange = attackRange * slack
  // rewards
  baseGold: number;  goldPerLevel: number;
  baseXp: number;    xpPerLevel: number;
}

export const CREEP_TYPES: Record<CreepTypeId, CreepTypeDef> = {
  ghoul: {
    kind: 'melee', bodyRadius: 24,
    baseHp: 250, hpPerLevel: 60,          // lvl 1 dies to 2× lvl-1 arrows
    baseDamage: 30, damagePerLevel: 10,   // 25 dps at lvl 1 vs 625 hero hp
    speed: 250,                            // kiteable (hero 350)
    aggroRange: 350, attackRange: 60, attackCooldown: 1.2,
    baseGold: 10, goldPerLevel: 4, baseXp: 60, xpPerLevel: 20,
  },
  dragon: {
    kind: 'ranged', bodyRadius: 30,
    baseHp: 350, hpPerLevel: 80,          // tankier — you close in under fire
    baseDamage: 40, damagePerLevel: 12,   // 20 dps, but at range
    speed: 220,
    aggroRange: 550, attackRange: 500, attackCooldown: 2.0,
    projectileSpeed: 600,                  // slower than ARROW.speed 900 → dodgeable
    projectileRangeSlack: 1.4,             // fireball dies at 700 units
    baseGold: 18, goldPerLevel: 6, baseXp: 90, xpPerLevel: 25,
  },
};

export const CREEP = {
  respawnInterval: 60,          // seconds
  leashRange: 600,              // from spawnPos — beyond = drop aggro, walk home
  maxLevel: 10,
  aggroScanEvery: 6,            // idle aggro scan every 6th tick, staggered
  arriveEpsilon: 5,             // snap-to-spawn distance
  activeLingerTicks: 30,        // stay in snapshots N ticks after going idle
  spawnSpread: 50,              // per-unit offset inside a camp
} as const;

// Derived helpers — used by sim, server, client, and tests; NEVER on the wire.
export function creepMaxHp(type: CreepTypeId, level: number): number;
export function creepDamage(type: CreepTypeId, level: number): number;
export function creepGold(type: CreepTypeId, level: number): number;
export function creepXp(type: CreepTypeId, level: number): number;
// each = base + perLevel * (level - 1)

// Camp placement: fractions of the arena rect — valid on 'arena' AND 'test'.
export interface CampDef { id: string; fx: number; fz: number; units: CreepTypeId[]; }
export const CAMP_DEFS: CampDef[] = [
  { id: 'camp_nw', fx: 0.15, fz: 0.15, units: ['ghoul', 'ghoul'] },
  { id: 'camp_ne', fx: 0.85, fz: 0.15, units: ['dragon'] },
  { id: 'camp_sw', fx: 0.15, fz: 0.85, units: ['dragon'] },
  { id: 'camp_se', fx: 0.85, fz: 0.85, units: ['ghoul', 'dragon'] }, // mixed
];
```

Nominal camp position = `arena.minX + fx * arena.width` (same for z), resolved
with `findReachableNear(world, x, z, shop.pos.x, shop.pos.z)` (`src/sim/world.ts:96`)
— anchoring to the shop guarantees camps land in the main walkable component,
not an unreachable islet (`findWalkableNear` alone doesn't guarantee that).

**Balance** vs HERO (625 hp, speed 350) and ARROW (200–400 dmg, speed 900,
range 800+): a lvl-1 ghoul dies to two arrows and is outrun by any hero; a
ghoul pair face-tanked kills a hero in ~12 s, kited it deals ~0. The dragon is
tankier but its 600-speed fireball can be sidestepped mid-flight or dodged
(dodge ability), and arrows outrange its 500 attack range — the counterplay is
skill, not stats. Respawn escalation to lvl 10 (ghoul: 790 hp / 120 dmg;
gold 10→46, XP 60→240 per the linear curves) preserves the catch-up mechanic.

### 1.2 `src/sim/state.ts` edits

After `WardState` (line 76):

```ts
export interface CreepState {
  id: string;                 // "c1"… — STABLE across respawns
  campId: string;
  type: CreepTypeId;
  pos: Vec2;
  facing: number;
  spawnPos: Vec2;
  hp: number;                 // maxHp is derived: creepMaxHp(type, level)
  level: number;
  alive: boolean;
  respawnTimer: number;
  aggroTargetId: string | null;
  attackCooldown: number;
  /** Last tick this creep moved/fought/changed — drives snapshot idle-omission. */
  lastActiveTick: number;
}
```

- `MatchState` (78-89): add `creeps: CreepState[]`. **No `nextCreepId`** — ids
  are assigned once at camp spawn (`c1, c2, …` in `CAMP_DEFS` order, so both
  sides derive identical ids) and never recycled. Stable ids are what let the
  client keep a static registry and let snapshots omit idle/dead creeps.
- `ProjectileState` (59-69): add `ownerKind?: 'creep'` — absent means hero, so
  every existing code path is untouched.
- `SimEvent` union (109-115): add

  ```ts
  | { type: 'creepHit'; creepId: string; sourceId: string; damage: number; x: number; z: number }
  | { type: 'creepKill'; creepId: string; campId: string; killerId: string;
      gold: number; xp: number; x: number; z: number }
  | { type: 'creepRespawn'; creepId: string; level: number }
  ```

  Creep→hero damage reuses the existing `'hit'` event with `sourceId = creepId`
  (targetId is a hero, so the client's floating-text/flash path at
  `Game.ts:1341-1349` works unchanged). A hero dying to a creep emits the
  existing `'kill'` with `sourceId = creepId`.
- `createMatchState()` (156): add `creeps: []`.

---

## 2. Simulation — new file `src/sim/stepCreeps.ts`

Pure functions over plain state, imported by `stepMatch.ts`, `GameRoom.ts`,
`Game.ts`, and the sim harness.

### 2.1 `spawnCamps(state: MatchState, world: SimWorld): void`

For each `CAMP_DEFS` entry: resolve the arena-fraction center via
`findReachableNear` (shop-anchored, above); spread units by
`CREEP.spawnSpread` offsets, each re-snapped with `findWalkableNear`
(`world.ts:123`). All creeps start level 1, `lastActiveTick: 0`.

### 2.2 `stepCreeps(state, dt, world, events)`

Called from `stepMatch` (`stepMatch.ts:40-68`) **after** the hero loop
(line 60) and **before** `stepProjectiles` (line 62), so a fireball spawned
this tick advances this tick — exactly like a hero arrow fired via command.

Per creep:

1. **Dead**: `respawnTimer -= dt`; at ≤ 0 respawn in place:
   `level = min(level + 1, CREEP.maxLevel)`, `hp = creepMaxHp(type, level)`,
   `pos = clone(spawnPos)`, clear aggro/cooldown, push `creepRespawn`.
2. `attackCooldown = max(0, attackCooldown - dt)`.
3. **Aggro acquire** — only if `aggroTargetId === null`, and only on this
   creep's stagger slot (`state.tick % CREEP.aggroScanEvery === idx %
   CREEP.aggroScanEvery`, so idle scans never bunch on one tick): nearest
   alive, non-invulnerable hero by `V.distanceSq` within `aggroRange`.
   Deterministic (array order breaks ties). Dodging heroes ARE aggro-able —
   dodge is a projectile-dodge (`hitHero`, `stepMatch.ts:421`), not stealth.
4. **Aggro validate** — every tick, cheap: drop the target if it's missing,
   dead, invulnerable, or `distance(pos, spawnPos) > CREEP.leashRange`.
5. **Behavior** (`def = CREEP_TYPES[type]`):
   - Target beyond `def.attackRange` → `moveCreep` toward it.
   - Target in range and cooldown ready — face it, set
     `attackCooldown = def.attackCooldown`, then:
     - **melee**: `applyCreepDamageToHero(state, target,
       creepDamage(type, level), creep, events)` — instant hit; respects
       `invulnerable`, ignores `dodgeActive`.
     - **ranged**: push a projectile

       ```ts
       {
         id: 'p' + state.nextProjectileId++,
         ownerId: creep.id, ownerKind: 'creep', team: -1,
         pos: <spawn offset toward target>,
         dir: V.normalize(V.sub(target.pos, creep.pos)), // aim at fire time
         speed: def.projectileSpeed!,
         maxRange: def.attackRange * def.projectileRangeSlack!,
         traveled: 0,
         damage: creepDamage(type, level),
       }
       ```

       Straight-line flight at 600 u/s means a moving hero sidesteps it — the
       dragon punishes standing still, not existing. No new event needed;
       remote projectiles already render purely from snapshots.
   - No target and not home → walk toward `spawnPos`; within
     `CREEP.arriveEpsilon`, snap to it **and heal to full**. The full-heal
     prevents camp whittling (poke, run, repeat) and makes the idle-omission
     predicate in §5 well-defined ("at rest" always means "at spawn, full hp").
6. Any movement / aggro change / damage / respawn sets
   `lastActiveTick = state.tick`.

### 2.3 `moveCreep(creep, targetPos, def, dt, world)`

Straight-line movement, **no pathfinding** — creeps stay dumb and cheap, and
terrain becomes kiting geometry (you can juke them around trees):

```ts
const dir = V.sub(targetPos, creep.pos);
const dist = V.length(dir);
if (dist < 2) return;
const unit = V.scale(dir, 1 / dist);
const next = V.add(creep.pos, V.scale(unit, Math.min(def.speed * dt, dist)));
if (sphereHitsObstacle(world, next, def.bodyRadius)) return;   // doodads
const cell = world.navGrid.worldToGrid(next.x, next.z);        // cliffs/water
if (!world.navGrid.isWalkable(cell.gx, cell.gz)) return;
creep.pos = next;
creep.facing = V.heading(unit);   // snap turn; client interpolates facing
```

### 2.4 Damage paths

**`applyCreepDamageToHero(state, target, amount, creep, events)`** — creep
melee hits and creep projectiles landing on heroes. Early-out
`!target.alive || target.invulnerable`; subtract hp; push the standard `'hit'`
event (`sourceId: creep.id`). On death, run only the **victim half** of
`applyDamage` (`stepMatch.ts:453-458`: `alive = false`, `respawnTimer`,
clear path, `deaths++`, `killStreak = 0`) and push `'kill'` with
`sourceId = creep.id` — **no** `kills++`, no `awardKillGold`, no `addXp`, no
multi-kill window, and `state.firstBlood` untouched (first blood stays
hero-vs-hero). Factor stepMatch's victim-death block into a shared
`killHero(target)` helper used by both paths rather than duplicating it.

**`applyCreepDamage(state, creep, source: HeroState, damage, events)`** — hero
arrows hitting creeps. Subtract hp; push `creepHit`. On death:
`alive = false`, `respawnTimer = CREEP.respawnInterval`, clear aggro; the
**last-hitter** gets `source.gold += creepGold(type, level)` and
`addXp(source, creepXp(type, level), events)` (export `addXp` from
`stepMatch.ts:495`); push `creepKill` with gold/xp/x/z. No assists — simple,
same as v1.

### 2.5 Projectile integration (`stepProjectiles`, `stepMatch.ts:383-412`)

Restructure the hit section of the loop:

```ts
if (p.ownerKind === 'creep') {
  // Creep fireball: hits ANY hero (no owner-skip needed — owner isn't a hero),
  // skips dead/invulnerable/dodging exactly like hitHero. Never hits creeps.
  const target = hitHeroByCreepProjectile(state, p);
  if (target) {
    state.projectiles.splice(i, 1);
    const creep = state.creeps.find((c) => c.id === p.ownerId);
    applyCreepDamageToHero(state, target, p.damage, creep, events);
  }
  continue;
}

// Hero-owned — existing hero-vs-hero path byte-for-byte unchanged (405-410).
const target = hitHero(state, p);
if (target) { /* …unchanged applyDamage path… */ continue; }

// NEW: creep check AFTER the hero check, so an arrow that passes through a
// dodging hero flies on and can hit the creep behind them.
const creepTarget = hitCreep(state, p);
if (creepTarget) {
  const source = state.heroes.find((h) => h.id === p.ownerId);
  state.projectiles.splice(i, 1);
  if (source) applyCreepDamage(state, creepTarget, source, p.damage, events);
}
```

`hitCreep` mirrors `hitHero` (415-425): radius
`CREEP_TYPES[c.type].bodyRadius + ARROW.collisionRadius`, `V.distanceSq`,
skip `!alive`. Creep projectiles get the same obstacle/dodge/invuln rules as
arrows for free (range + `sphereHitsObstacle` checks run before the hit
checks, lines 393-403).

---

## 3. Network Protocol & Server

### 3.1 `src/sim/protocol.ts`

```ts
/** Hot per-tick creep fields — only ACTIVE creeps are included (§5). */
export interface SnapshotCreep { id: string; pos: Vec2; facing: number; hp: number }

/** Cold registry entry, sent once in the welcome. */
export interface CreepMeta {
  id: string; campId: string; type: CreepTypeId;
  level: number; alive: boolean; hp: number;
  pos: Vec2; spawnPos: Vec2;
}
```

- `Snapshot` (136-141) and `SnapshotMessage` (101-109): add
  `creeps: SnapshotCreep[]`.
- `WelcomeMessage` (89-99): add `creepMeta: CreepMeta[]`.
- Level/alive changes after the welcome are **event-carried**: `creepRespawn`
  updates level + alive, `creepKill` marks dead. Events piggyback on snapshots
  over a reliable WebSocket, so nothing is lost; late joiners get a fresh
  registry in their welcome.

### 3.2 `server/GameRoom.ts`

- Add `_resetMatch()` = `this._state = createMatchState();
  spawnCamps(this._state, this._world);` — call from the **constructor**
  (line 74) and the **map-switch join branch** (lines 113-116). Both reset
  paths must build camps.
- `META_EVENTS` (line 48): add `'creepKill'` — a last-hit changes the killer's
  gold/xp (cold fields), so meta flushes the same tick. (`levelUp` from creep
  XP was already in the set.)
- `_currentSnapshot()` (231-247): serialize only **active** creeps:

  ```ts
  creeps: this._state.creeps
    .filter((c) => c.alive && this._state.tick - c.lastActiveTick < CREEP.activeLingerTicks)
    .map((c) => ({
      id: c.id,
      pos: { x: q(c.pos.x), z: q(c.pos.z) },
      facing: q(c.facing),
      hp: q(c.hp),
    })),
  ```

- Welcome (140-148): add quantized `creepMeta` from `this._state.creeps`.
- **No input-path changes whatsoever** — see §6.

---

## 4. Client

### 4.1 New `src/entities/CreepMeshes.ts` — shared assets

Module-level cache `getCreepAssets(type: CreepTypeId)` builds **once per
type** the geometries and shared static materials, returning them for every
view instance:

- **ghoul**: hunched capsule body + head sphere + two arm boxes, ~300 tris,
  sickly green 0x7a8a5a.
- **dragon**: body + two wing planes + head cone, dull red 0xa03a2a.

This is deliberately NOT the `ArcherMesh.ts` pattern (which allocates ~15-20
unique geometries + materials per hero — fine for ≤ 8 heroes, wasteful for
always-present creeps).

### 4.2 New `src/entities/CreepView.ts`

Modeled on `HeroView` minus the expensive parts:

- Meshes reference the shared geometries; **only the body material is cloned**
  per instance (needed for the `flashHit` emissive pulse, cf.
  `HeroView.ts:74-78`); limbs/wings share materials.
- **No `PointLight`** (`HeroView.ts:68`) — 6-8 extra dynamic lights would be
  the single worst render cost of this feature.
- Reuse `HealthBar`; `setHP(hp, creepMaxHp(type, level))`.
- `sync(creep, dt)`: hide when `!alive`; position via
  `heightAt(x, z) + HERO.groundOffset`; `rotation.y = facing`; sin-based walk
  swing (ghoul) / wing flap (dragon) in the `_updateWalk` style
  (`HeroView.ts:183-205`), driven by whether pos changed since last frame.

### 4.3 `src/core/Game.ts` wiring

- Fields: `_creepViews = new Map<string, CreepView>()`; network mode also
  keeps `_creepRegistry: Map<string, CreepMeta>`.
- **Offline** (else-branch ~298-327): call
  `spawnCamps(this._state, this._world)` after `createMatchState()`;
  `_updateOffline`'s `stepMatch` (1056) then simulates creeps for free.
- **Network**: hydrate persistent `CreepState`s from `welcome.creepMeta`
  (`_initNetwork`/`_applySnapshot`, 586-597) and fill `_creepRegistry`. In
  `_applyServerState` (606-633): for each `SnapshotCreep` update the
  persistent creep's `hp`; presence ⇒ `alive = true`; absence ⇒ **hold last
  state** (death arrives via `creepKill`). Never delete creeps — ids are
  stable all match. The prediction temp state (753-759) gets `creeps: []` so
  local prediction never double-steps creeps.
- **Interpolation**: `_interpolateCreeps(renderTime)` mirroring
  `_interpolateHeroes` (778-815) over `snapshot.creeps` — no local-player
  skip; a creep missing from a straddling snapshot simply holds (the idle
  case). Call it beside line 1147.
- **View sync**: `_syncCreepViews()` on the `_syncWardViews` template
  (1403-1435) but with no vision sources; call from `_syncAllViews`
  (1325-1335).
- **Fog** (`_applyFogVisibility`, 1515-1543): creeps are neutral and reveal
  nothing (no `VisionSource`); gate every creep:
  `view.mesh.visible = c.alive && this._fog.isVisible(team, c.pos.x, c.pos.z)`.
  Creep projectiles (team −1) are already gated by the existing
  `p.team !== team` branch (1528-1533).
- **Minimap** (`_render`, 1446-1466): one static grey marker per camp
  (position = camp spawn center; dimmed when all its creeps are dead);
  individual creep dots only when alive + visible (`#c8b830`).
- **Events** (`_handleEvent`, 1339-1366):
  - `creepHit` → floating damage at (x, z) + `_creepViews.get(creepId)?.flashHit()`.
  - `creepKill` → if `killerId === this._playerId`, spawn gold (`#ffcc44`)
    and XP (`#88ff88`) floating text via `FloatingTextManager.spawn`
    (`src/ui/FloatingText.ts:63`).
  - `creepRespawn` → update registry/state level (drives HealthBar max via
    `creepMaxHp`).
- **Fireball visuals**: `ProjectileView.sync` (`src/combat/ProjectileView.ts:27`)
  tints the per-instance trail/head materials orange-red when
  `state.ownerKind === 'creep'` (materials are already unique per pooled
  instance, so tinting is safe); the existing pool of 20 (Game.ts:336-341)
  absorbs fireballs.

---

## 5. Performance

**Server tick (Durable Object CPU).** Creeps add zero pathfinding and zero
allocation-heavy paths. Idle steady state: 6 creeps × (one `distanceSq` leash
check + timer decrements), plus an aggro scan of ≤ 8 heroes for at most 1-2
creeps per tick (throttled to every 6th tick, staggered per creep index).
Worst case — all 6 aggroed and moving — is 6 straight-line steps with one
`sphereHitsObstacle` sweep each: the same cost class as 6 extra walking
heroes, well under 1 ms against the 16.7 ms tick budget. The projectile loop
gains a ≤ 6-element creep scan per hero arrow, and only after the hero scan
misses.

**Snapshot bandwidth** — the dominant concern, because creeps exist every
tick (unlike projectiles). In order of impact:

1. **Idle omission**: a creep enters `snapshot.creeps` only while
   `alive && tick − lastActiveTick < activeLingerTicks`. At-rest creeps (at
   spawn, full hp — guaranteed by the leash full-heal) cost **zero bytes** at
   steady state. The 30-tick linger flushes the final resting pos/hp so the
   client's held state is exact before the creep goes silent.
2. **Hot/cold split**: per-tick entries carry only `{id, pos, facing, hp}`
   (~65 quantized JSON bytes); `campId/type/level/spawnPos` live in the
   welcome registry and never repeat; `maxHp` is derived from `(type, level)`
   on both sides and never sent; death/respawn/level are event-carried.
3. Worst case (all 6 creeps fighting): ~390 B/tick × 60 Hz ≈ 23 KB/s per
   client — comparable to 4-5 extra heroes, and transient.

**Client draw calls / GC.** Geometries and static materials are built once
per creep type; ~4 meshes + 1 health-bar sprite per creep ⇒ ≤ 30 extra draw
calls for 6 creeps (negligible next to the instanced ~9.8k doodads). **No
per-creep PointLights.** `sync` paths allocate nothing per frame; views are
created once (stable ids) and only disposed on map swap. `InstancedMesh`
(the `Doodads.ts` pattern) is deliberately skipped: at ≤ 8 animated creeps it
saves ~25 draw calls but forfeits simple per-node procedural animation and
per-unit visibility toggling — revisit only if creep counts grow 10×. Fog
checks ride the existing 0.15 s-throttled visibility grid; minimap markers
reuse the existing per-frame marker array.

---

## 6. Server Authority & Validation

- **Zero new attack surface.** The `Command` union and the server's `input`
  handler (`GameRoom.ts:158-163`) are untouched. No client message references
  a creep — creeps take no input, so nothing creep-related is ever parsed
  from the network.
- **Rewards are computed only inside the sim, on the server.** Gold/XP from a
  creep kill are applied in `applyCreepDamage`, which runs only inside
  `stepMatch → stepProjectiles`, driven by server-simulated projectile
  collisions. The killer's identity comes from `projectile.ownerId`, which
  the server set at fire time from **socket identity** (heroId is forced from
  `_players.get(ws)` at `GameRoom.ts:161`, never from message content). A
  client cannot claim a last-hit, inflate damage, or spoof a `creepKill`.
- **Snapshots and events are display-only downstream.** In network mode the
  client never runs `stepCreeps` against authoritative state (its prediction
  temp state has no creeps), so client-side creep state cannot diverge into
  anything gameplay-relevant. Hero gold/xp/level continue to reconcile
  exclusively through server `heroMeta` (`_applyMetaFields`,
  `Game.ts:691-721`); `'creepKill'` in `META_EVENTS` flushes meta the same
  tick the reward lands.
- **Offline mode** simulates creeps locally via the same `stepMatch` —
  acceptable by design: it's single-player with no shared economy, and it
  doubles as a deterministic test bed for the exact code the server runs.

---

## 7. Tests (`pnpm sim`)

Harness additions (`scripts/harness/SimHarness.ts`):
`spawnCamp(id: string, pos: Vec2, units: CreepTypeId[])`, a `creep(id)`
accessor, and creeps in trace lines (`_snapshotLine`, lines 192-218: id, x,
z, hp, level, alive, aggro). The default harness state stays creep-free, so
the 7 existing scenarios are untouched.

New scenarios:

- **`creep-melee.ts`** — hero enters ghoul aggro range → `hit` events with
  `sourceId: 'c1'` and damage `creepDamage('ghoul', 1)`; hero kills it →
  `creepKill` with exact `creepGold`/`creepXp` credited; advance
  `CREEP.respawnInterval` → `creepRespawn` at level 2 with
  `creepMaxHp('ghoul', 2)`.
- **`creep-ranged.ts`** — dragon fires an `ownerKind: 'creep'` projectile
  advancing `projectileSpeed * DT` per tick and hitting for dragon damage;
  a dodging hero → projectile passes through (no `hit`); hero behind the
  test-map rock → projectile removed by obstacle (`map: 'test'`).
- **`creep-leash.ts`** — kite a ghoul past `CREEP.leashRange` → aggro drops,
  it walks home, snaps to `spawnPos`, heals to full.
- **`creep-arrow-passthrough.ts`** — dodging hero on the line between shooter
  and creep → arrow ignores the dodger and hits the creep behind
  (verifies the hero-then-creep check order).
- **`creep-mixed-camp.ts`** — a `['ghoul','dragon']` camp aggroes together:
  ghoul closes to melee, dragon stops at `attackRange` and shoots. Also runs
  a hero-vs-hero duel inside the camp and asserts kill credit/first blood
  still go to the hero (regression guard on the projectile restructure).

---

## 8. Implementation Order & Verification

**Phase 1 — Sim core** (pure, headless):
`creepRules.ts` → `state.ts` (CreepState, events, `ownerKind`, `creeps: []`)
→ `stepCreeps.ts` → `stepMatch.ts` (insert `stepCreeps` between the hero loop
and `stepProjectiles`; restructure `stepProjectiles`; factor `killHero`;
export `addXp`) → harness `spawnCamp` + creep traces → the 5 scenarios.
*Verify*: `pnpm sim` — all 12 scenarios green; inspect `traces/creep-*.jsonl`
with `pnpm trace`.

**Phase 2 — Offline client**:
`CreepMeshes.ts`, `CreepView.ts` → Game.ts offline `spawnCamps` +
`_syncCreepViews` + fog gating + minimap + `_handleEvent` creep cases →
fireball tint.
*Verify*: `pnpm dev`, `?map=test` — get chased and shot, kite past the leash,
kill for gold/XP floating text, watch the level-2 respawn 60 s later; confirm
fog hides creeps; compare `renderer.info` draw calls before/after.

**Phase 3 — Protocol + server + network client**:
`protocol.ts` (SnapshotCreep, CreepMeta) → `GameRoom.ts` (`_resetMatch`,
snapshot idle-omission, welcome registry, META_EVENTS) → Game.ts network path
(registry hydration, `_applyServerState`, `_interpolateCreeps`, event-driven
alive/level).
*Verify*: two browser tabs in one room — identical creep behavior; kill a
creep in tab A → tab B sees the death and A's gold updates the same tick; a
third tab joining mid-match sees correct creep levels/alive from its welcome;
devtools WS frames confirm idle camps add ~0 bytes.

**Phase 4 — Balance & polish** (post-merge): tune `CREEP_TYPES` from
playtests; aggro "!" indicator, hit sounds, distinct death animations.

**Critical files**: `src/sim/stepMatch.ts`, `src/sim/state.ts`,
`src/sim/protocol.ts`, `server/GameRoom.ts`, `src/core/Game.ts`, plus new
`src/sim/creepRules.ts`, `src/sim/stepCreeps.ts`,
`src/entities/CreepMeshes.ts`, `src/entities/CreepView.ts`.

---

## 9. Open Questions / Future

- **Creeps vs wards**: creeps ignore wards (wards aren't targets).
- **Creeps blocking arrows for other creeps/heroes**: creep bodies are hit
  targets but not obstacles — arrows stop on the first creep they overlap,
  which is the natural reading; they never grant LOS cover.
- **Assists**: last-hit only, same as v1. Revisit if farming feels stolen.
- **More archetypes**: the `CREEP_TYPES` table makes a third type (e.g. a
  slow tanky golem boss camp) a data + mesh addition, no sim changes.
- **Creep counts**: 4 camps / 6 creeps for 2-8 players; tune via `CAMP_DEFS`.
