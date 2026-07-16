# Jungle Creeps — Implementation Plan

## Overview

Melee neutral creeps at fixed camps.  Soft-leash, respawn every 60s with
escalating stats and rewards.  They give players behind in gold/XP a way to
catch up without hunting heroes, and create mini-objectives on the map.

---

## 1. Data Model

### 1.1 CreepState (new → `src/sim/state.ts`)

```ts
export interface CreepState {
  id: string;                // "c1", "c2", …
  campId: string;            // which camp it belongs to
  pos: Vec2;
  facing: number;
  spawnPos: Vec2;            // camp center — used for leash & respawn

  hp: number;
  maxHp: number;
  damage: number;            // melee damage per hit
  speed: number;             // world units / sec
  level: number;             // increments on each respawn

  alive: boolean;
  respawnTimer: number;      // counts down from RESPAWN_INTERVAL

  // AI state
  aggroTargetId: string | null;  // heroId being chased, or null
  attackCooldown: number;        // seconds until next attack allowed
}
```

### 1.2 CreepCamp (new → `src/sim/state.ts`)

```ts
export interface CreepCamp {
  id: string;
  pos: Vec2;                 // center — creeps spawn around this
  creeps: CreepState[];      // the live creep instances
  /** Number of creeps per spawn wave (constant). */
  count: number;
}
```

### 1.3 Additions to MatchState

```ts
// in MatchState, add:
creeps: CreepState[];
nextCreepId: number;
```

The creep `id` namespace is separate from projectiles/wards: `"c1"`, `"c2"`, …
We bump `nextCreepId` on each respawn so dead + respawned creeps get new ids
(network clients use ids to track entities).

---

## 2. Stat Curves & Constants

All in a new file `src/sim/creepRules.ts`:

```ts
export const CREEP = {
  respawnInterval: 60,        // seconds
  aggroRange: 350,            // world units — hero must be this close
  leashRange: 600,            // world units from spawnPos — beyond = retreat
  attackRange: 60,            // melee hit distance
  attackCooldown: 1.2,        // seconds between swings
  bodyRadius: 24,             // collision for projectiles (slightly smaller than heroes at 27)
  maxLevel: 10,               // cap

  // Base stats at level 1
  baseHp: 250,
  baseDamage: 30,
  baseSpeed: 250,             // ~half hero speed

  // Per-level scaling
  hpPerLevel: 60,
  damagePerLevel: 10,
  speedPerLevel: 8,           // subtle — mainly more HP/damage

  // Rewards at level 1
  baseGold: 10,
  baseXp: 60,

  // Per-level reward scaling
  goldPerLevel: 4,
  xpPerLevel: 20,
} as const;
```

### Derived helpers

```ts
export function creepMaxHp(level: number): number {
  return CREEP.baseHp + CREEP.hpPerLevel * (level - 1);
}
export function creepDamage(level: number): number {
  return CREEP.baseDamage + CREEP.damagePerLevel * (level - 1);
}
export function creepGold(level: number): number {
  return CREEP.baseGold + CREEP.goldPerLevel * (level - 1);
}
export function creepXp(level: number): number {
  return CREEP.baseXp + CREEP.xpPerLevel * (level - 1);
}
```

### Examples over levels

| Level | HP  | Damage | Gold | XP  |
|-------|-----|--------|------|-----|
| 1     | 250 | 30     | 10   | 60  |
| 2     | 310 | 40     | 14   | 80  |
| 3     | 370 | 50     | 18   | 100 |
| 5     | 490 | 70     | 26   | 140 |
| 10    | 790 | 120    | 46   | 240 |

At level 10, a creep is tankier than a hero (625 HP) but deals less burst than
an arrow (200–400 damage) — its DPS is sustained melee, not burst.

---

## 3. Camp Placement

### 3.1 Map: Arena (the main map)

We'll place 4 camps, each with 2 creeps (8 creeps total). Positions are
hand-picked world coordinates in open forest areas, away from the central
shop and spawn zones.

| Camp ID  | Center (x, z)    | Theme       |
|----------|-------------------|-------------|
| camp_nw  | (-2200, -1800)    | Forest NW   |
| camp_ne  | (2200, -1800)     | Forest NE   |
| camp_sw  | (-2200, 1800)     | Forest SW   |
| camp_se  | (2200, 1800)      | Forest SE   |

Exact positions should be walkable and reachable from the shop (use
`findWalkableNear`). Each camp spawns 2 creeps at nearby offsets (e.g., ±40
units on X from center).

### 3.2 Defining camps

In `src/sim/buildWorld.ts` (or a new `src/sim/creepCamps.ts`), define an array
of camp configs. The world construction finds walkable positions near each
nominal center.

```ts
export const CAMP_DEFS: { id: string; nx: number; nz: number }[] = [
  { id: 'camp_nw', nx: -2200, nz: -1800 },
  { id: 'camp_ne', nx:  2200, nz: -1800 },
  { id: 'camp_sw', nx: -2200, nz:  1800 },
  { id: 'camp_se', nx:  2200, nz:  1800 },
];
```

### 3.3 Test map

2 camps (simpler layout), 2 creeps each.

---

## 4. Simulation Logic

All in `stepMatch` + a new `stepCreeps` function (in `src/sim/stepCreeps.ts`).

### 4.1 Main loop — integrated into `stepMatch()`

```ts
// After stepHeroes, before stepProjectiles:
stepCreeps(state, dt, world, events);
```

### 4.2 `stepCreeps(state, dt, world, events)`

For each creep:

```
if !alive:
    respawnTimer -= dt
    if respawnTimer <= 0 → respawn(creep)
    continue

if attackCooldown > 0:
    attackCooldown -= dt

// ── Aggro ──
if aggroTarget == null:
    // Scan for the closest alive, non-invulnerable enemy hero within aggroRange
    target = closestHeroInRange(creep.pos, CREEP.aggroRange)
    if target: aggroTarget = target.id

if aggroTarget != null:
    target = state.heroes.find(h => h.id == aggroTarget)
    // Lose aggro: target dead, invulnerable, out of leash range from spawn
    if target == null || !target.alive || target.invulnerable
       || distance(creep.pos, creep.spawnPos) > CREEP.leashRange:
        aggroTarget = null
        target = null

// ── Move ──
if aggroTarget != null:
    // Move toward the target
    moveToward(creep, target.pos, dt, world)
else:
    // Return to spawn position
    if distance(creep.pos, creep.spawnPos) > 5:
        moveToward(creep, creep.spawnPos, dt, world)
    else:
        creep.pos = creep.spawnPos  // snap

// ── Attack ──
if aggroTarget != null && distance(creep.pos, target.pos) <= CREEP.attackRange
   && attackCooldown <= 0:
    target.hp -= creep.damage
    attackCooldown = CREEP.attackCooldown
    events.push({ type: 'creepHit', targetId: target.id, creepId: creep.id,
                  damage: creep.damage, ... })
```

### 4.3 `moveToward(creep, targetPos, dt, world)`

- Compute direction from creep to target.
- Advance creep.pos by `creep.speed * dt` toward target, clamped to distance.
- Simple direct movement — *no pathfinding for creeps*. They walk in straight
  lines. If they hit a tree/obstacle, they stop (no sliding). This keeps them
  "dumb" and makes terrain interesting: you can kite them around trees.

Direct movement without pathfinding:

```ts
function moveToward(creep: CreepState, target: Vec2, dt: number): void {
  const dir = V.sub(target, creep.pos);
  const dist = V.length(dir);
  if (dist < 2) return;  // close enough
  const step = Math.min(creep.speed * dt, dist);
  const unit = V.normalize(dir);
  const next = V.add(creep.pos, V.scale(unit, step));
  // Don't walk into obstacles
  if (sphereHitsObstacle(world, next, CREEP.bodyRadius)) return;
  creep.pos = next;
  creep.facing = V.heading(unit);
}
```

### 4.4 Creep death — projectiles hitting creeps

In `stepProjectiles`, after the hero hit check, add a creep hit check:

```ts
const creepTarget = hitCreep(state, p);
if (creepTarget) {
  state.projectiles.splice(i, 1);
  if (source) applyCreepDamage(state, creepTarget, source, p.damage, events);
  continue;
}
```

`hitCreep` works like `hitHero` but checks `state.creeps`:

```ts
function hitCreep(state: MatchState, p: ProjectileState): CreepState | null {
  const hitRadius = CREEP.bodyRadius + ARROW.collisionRadius;
  const r2 = hitRadius * hitRadius;
  for (const creep of state.creeps) {
    if (!creep.alive) continue;
    if (V.distanceSq(p.pos, creep.pos) < r2) return creep;
  }
  return null;
}
```

`applyCreepDamage`:

```ts
function applyCreepDamage(
  state: MatchState,
  creep: CreepState,
  killer: HeroState,
  damage: number,
  events: SimEvent[],
): void {
  creep.hp = Math.max(0, creep.hp - damage);
  events.push({ type: 'creepHit', creepId: creep.id, sourceId: killer.id,
                damage: Math.min(damage, creep.hp + damage), ... });

  if (creep.hp > 0) return;

  // Death
  creep.alive = false;
  creep.respawnTimer = CREEP.respawnInterval;
  creep.aggroTarget = null;
  creep.attackCooldown = 0;

  // Rewards
  killer.gold += creepGold(creep.level);
  addXp(killer, creepXp(creep.level), events);

  events.push({ type: 'creepKill', creepId: creep.id, killerId: killer.id,
                gold: creepGold(creep.level), xp: creepXp(creep.level) });
}
```

### 4.5 Creep respawn

```ts
function respawnCreep(creep: CreepState, nextId: number): void {
  creep.id = `c${nextId}`;
  creep.level = Math.min(creep.level + 1, CREEP.maxLevel);
  creep.maxHp = creepMaxHp(creep.level);
  creep.hp = creep.maxHp;
  creep.damage = creepDamage(creep.level);
  creep.speed = CREEP.baseSpeed + CREEP.speedPerLevel * (creep.level - 1);
  creep.alive = true;
  creep.pos = { x: creep.spawnPos.x, z: creep.spawnPos.z };
  creep.aggroTarget = null;
  creep.attackCooldown = 0;
}
```

### 4.6 DODGE interaction

Creeps don't dodge. Projectiles pass through dodging heroes but will still hit
creeps — this is fine. The dodge check happens before the creep hit check? Let's
review the projectile loop:

```
for each projectile:
  advance position
  if past maxRange → remove
  if hit obstacle → remove
  hitHeroCheck (skips dodging/invuln heroes) → remove & apply damage if hit
  hitCreepCheck → remove & apply damage if hit
```

Both checks run sequentially on the same projectile. If it hits a hero first (who
doesn't dodge), the arrow stops there. If the hero dodges, the arrow continues
and can hit a creep behind them.

### 4.7 FIRST BLOOD

Creep kills do NOT trigger first blood (firstBlood is hero-vs-hero only,
unchanged).

---

## 5. Network Protocol

### 5.1 Snapshot extension

Add `creeps: SnapshotCreep[]` to `Snapshot` and `SnapshotMessage`:

```ts
export interface SnapshotCreep {
  id: string;
  campId: string;
  pos: Vec2;
  facing: number;
  hp: number;
  maxHp: number;
  level: number;
  alive: boolean;
}
```

Creeps are "hot" entities — their position and HP change every tick when they're
in combat, so they belong in the per-tick snapshot (like projectiles). The
quantized snapshot adds:

```ts
// in GameRoom._currentSnapshot():
creeps: this._state.creeps.map((c) => ({
  id: c.id,
  campId: c.campId,
  pos: { x: q(c.pos.x), z: q(c.pos.z) },
  facing: q(c.facing),
  hp: q(c.hp),
  maxHp: q(c.maxHp),
  level: c.level,
  alive: c.alive,
})),
```

### 5.2 SimEvent extension

New event types:

```ts
| { type: 'creepHit'; creepId: string; sourceId: string; damage: number; ... }
| { type: 'creepKill'; creepId: string; killerId: string; gold: number; xp: number }
| { type: 'creepRespawn'; creepId: string; level: number }
```

### 5.3 Server authority

Creeps are fully server-authoritative — the server simulates them and
broadcasts the results. No client prediction needed for creeps (they don't
respond to player input). The client renders them from the interpolation
timeline like remote heroes.

---

## 6. Client Rendering

### 6.1 CreepView (new → `src/entities/CreepView.ts`)

A simplified version of HeroView:
- Mesh: a new low-poly model (or reused archer mesh with a neutral grey/brown
  team color — or better, a custom simple mesh).
- Health bar (reuse `HealthBar`).
- No dodge, no invulnerability flash, no fire flash — just walk and die.
- Color: neutral brown/dark green to distinguish from players.

```ts
export class CreepView {
  readonly mesh: THREE.Group;
  readonly creepId: string;
  private _healthBar: HealthBar;
  // …

  sync(state: CreepState, dt: number): void {
    if (!state.alive) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    this._healthBar.setHP(state.hp, state.maxHp);
    const y = this._heightAt(state.pos.x, state.pos.z) + HERO.groundOffset;
    this.mesh.position.set(state.pos.x, y, state.pos.z);
    this.mesh.rotation.y = state.facing;
  }
}
```

For the initial version, we'll reuse the existing `HeroView` with a neutral team
color (0x888888) and a smaller scale (0.8×), or create a simple geometric
creature (sphere body + cylinder limbs — ~200 tris, easy to distinguish from
the detailed archer mesh).

### 6.2 Integration into Game.ts

Follow the same pattern as `_syncHeroViews` / `_syncWardViews`:

- `_syncCreepViews()` — create/destroy `CreepView` instances as creeps come
  and go.
- Creeps get fog-of-war vision sources (small sight radius, e.g. 200, so you
  can see them when close, but they don't reveal much of the map).
- Creep markers on the minimap: small grey dots at each camp (updated per
  frame for alive creeps).

### 6.3 Fog of war

Creeps do NOT provide team vision (they're neutral). They get a small sight
radius so you can see the creeps themselves when your hero is nearby, but
they don't reveal enemy heroes. Implementation:

- In `_syncCreepViews`, add a `VisionSource` per live creep with `team = -1`
  (neutral) and `sightRadius = 200`. Treat `team = -1` as visible to everyone
  in fog calculations.

Actually, simpler: creeps should be visible to players whose own vision
overlaps the creep's position (via their hero/ward sight radius). We can just
check `this._fog.isVisible(playerTeam, creep.pos.x, creep.pos.z)` in `_render`
when deciding whether to show creep meshes. No need for creep vision sources.

---

## 7. Server-Side Integration

### 7.1 Camp construction (in `GameRoom._buildWorld` or a new helper)

```ts
function _createCreepCamps(world: SimWorld): CreepCamp[] {
  const camps: CreepCamp[] = [];
  for (const def of CAMP_DEFS) {
    const center = findWalkableNear(world, def.nx, def.nz);
    const camp: CreepCamp = { id: def.id, pos: center, creeps: [], count: 2 };
    for (let i = 0; i < camp.count; i++) {
      const offset = (i - (camp.count - 1) / 2) * 50;  // spread creeps
      camp.creeps.push(createCreep(`c${nextId++}`, camp.id, {
        x: center.x + offset,
        z: center.z + (i % 2 === 0 ? -40 : 40),
      }, 1));
    }
    camps.push(camp);
  }
  return camps;
}
```

### 7.2 MatchState initialization

`createMatchState()` adds `creeps: []` and `nextCreepId: 1`. The creeps are
populated when `_buildWorld` runs (like heroes are populated on join, creeps
are populated on world construction).

---

## 8. Client-Side Integration (Offline Mode)

In offline mode (`Game._init` without network), build the same camps from
`CAMP_DEFS` + `buildSimWorld` results and add them to `_state.creeps`. They'll
be simulated by `stepMatch` in the offline tick like everything else.

---

## 9. Minimap

Each camp gets a static marker (small grey square). Alive creeps don't
need individual minimap icons (too small/cluttered). When a camp has been
cleared (all creeps dead), the marker dims. When it respawns, it brightens.

---

## 10. Floating Text

On creep kill: "10g" / "60XP" floating text above the creep corpse (using the
existing `FloatingTextManager`). Can be simpler than hero hit text — just a
yellow gold number and a green XP number.

---

## 11. Implementation Order

**Phase 1 — Sim core** (pure headless, testable with unit tests)
1. Add `CreepState`, `CreepCamp` to `state.ts`, update `MatchState`.
2. Create `src/sim/creepRules.ts` with stat curves.
3. Create `src/sim/stepCreeps.ts` with aggro, movement, attack, respawn logic.
4. Wire `stepCreeps` into `stepMatch`.
5. Add projectile-vs-creep collision in `stepProjectiles`.
6. Add creep death rewards.

**Phase 2 — Server**
7. Add `SnapshotCreep` to protocol, serialize creeps in `GameRoom._currentSnapshot`.
8. Build camps in `GameRoom._buildWorld`.
9. Add creep events to the event stream.

**Phase 3 — Client rendering**
10. Create `CreepView` (or adapt `HeroView`).
11. Add `_syncCreepViews` to `Game.ts`.
12. Handle creeps in the snapshot/interpolation pipeline (creeps are strictly
    server-authoritative, no prediction — use the same interp-delayed render
    as remote heroes).
13. Minimap camp markers.
14. Floating text for creep kills.

**Phase 4 — Polish**
15. Adjust stats based on playtesting.
16. Add distinct creep mesh/model.
17. Creep aggro visual feedback (red flash when hit, "!" indicator on aggro).
18. Sound effects (future).

---

## 12. Open Questions / Future

- **Should creeps attack wards?** No — wards are invisible to creeps for the
  initial version.
- **Should creeps block projectile LOS?** Interesting idea, but for simplicity
  creeps don't block arrows (only doodads/trees do). The `sphereHitsObstacle`
  check for projectiles only checks `world.obstacles`, not creeps.
- **Creep kill assists?** Only the last-hitter gets the reward. Simple for now.
- **Creep count scaling with players?** 4 camps × 2 creeps = 8 creeps total.
  Enough for 2–8 players to farm without overloading the map. Can tune later.
- **Creep levels persisting across matches?** No — each match starts fresh with
  level 1 creeps.
