# 3D Isometric + Elevation Conversion Plan

## Goal

Turn the current **top-down, flat-plane** game into a **perspective isometric
(WC3 / League) view over a smooth 3D heightfield** the hero can walk up and down.

## Decisions (locked)

- **Terrain model:** smooth continuous heightfield (float heights, bilinear
  sampled). Any grade is walkable; grades steeper than a threshold are blocked
  ("too steep to climb"). No discrete WC3 cliffs/ramps.
- **Camera:** perspective, ~35° pitch, 45° yaw, narrow-ish FOV. Follows the hero
  and rises with terrain height. No free rotation (design-doc constraint).
- **Simulation is 2D (this is the key one).** Like LoL and WC3, gameplay —
  targeting, projectile flight, collision — happens on the flat XZ plane. Height
  is a **rendering** value only. This decides how spells behave (below).

## Guiding principle: 2D gameplay, 3D presentation

Confirmed from how the real games work
([LoL wiki](https://leagueoflegends.fandom.com/wiki/Targeting): *"Gameplay takes
place in two dimensions no matter the visuals… the engine does not take into
account the height of the unit… for skill-shots"*; WC3 missiles use a constant
fly-height above terrain):

- **Units** are 2D circles at an XZ position with a gameplay radius. Their Y is
  only for drawing the model.
- **Skillshots** are aimed at a **2D ground point** and travel a straight XZ line.
  A hit is a **2D** overlap (line/circle vs unit radius) — height is ignored. You
  aren't aiming at feet *or* body; you're aiming a direction across the ground.
- **Projectiles never collide with terrain.** They render at
  `heightAt(x,z) + flyHeight` — a constant height above whatever ground is under
  them — so they visually sail over hills and dip through valleys, but the hit
  math is pure 2D.
- **Elevation gives no mechanical advantage by itself.** High-ground advantage, if
  wanted, is an explicit future rule (vision/fog first — you can't aim at what you
  can't see; optionally a WC3-style uphill miss chance). Not baked into physics.

## Current-state findings (what actually has to change)

| System | Today | Problem for elevation |
|---|---|---|
| `rendering/Camera.ts` | Orthographic, looks **straight down** (`rot.x = -90°`) | Not isometric at all; must become angled perspective |
| `core/Game.ts` ground | Single flat `PlaneGeometry` at `y=0` | Replace with terrain mesh |
| `entities/Hero.ts` | Y hard-pinned to `0.5`; movement zeroes `dir.y` | Must sample ground height each frame |
| `input/InputManager.ts` | Raycasts a **fixed `y=0` plane** | Raycast terrain mesh, then use XZ only |
| `navigation/NavGrid.ts` | Flat boolean walkable grid | Add slope-based blocking |
| `combat/Projectile.ts` | Flat flight, clamps `y≥6`, **Y-window hit test** | Render at fly-height; **2D-only** collision; no terrain hit |
| `world/Obstacles.ts` / `Shop` | Bases at `y=0` | Sit on terrain height |
| Edge-pan + minimap | Assume screen axes == world X/Z | Break under camera yaw; need camera basis |
| CSS `scaleY(-1)` flip | Referenced in Camera comment (verify location) | Remove — only valid for straight-down |

## New module: `src/world/Terrain.ts` (single source of truth)

- Owns a heightfield: a grid of float samples over the arena (e.g. 129×129 across
  4000u ≈ 31u/sample). Generated deterministically (a few Gaussian hills + gentle
  noise; borders kept low/flat).
- `heightAt(wx, wz): number` — bilinear interpolation of the 4 surrounding samples.
  Cheap: called every frame for every hero, projectile, and the camera.
- `slopeAt(wx, wz)` / `normalAt(wx, wz)` — finite differences of `heightAt`, used
  for walkability and (later) tilting props to the ground.
- `mesh`: `PlaneGeometry(size,size, segs,segs)` laid flat, each vertex Y displaced
  by `heightAt`, vertex-colored by height/slope (grass → dirt on steep → light
  peaks), `computeVertexNormals()`. **This mesh is the raycast target** for input.
- `applyToNav(navGrid)` — marks cells unwalkable where `slopeAt` exceeds
  `maxWalkableSlope`.

Entities depend on a plain `heightSampler = (x,z)=>number` (not the class) to stay
decoupled.

## Phases (each independently verifiable via `pnpm shot`)

**Phase 0 — Camera → perspective isometric** *(ships on the current flat map)*
- Rewrite `Camera.ts` as `IsometricCamera`: `PerspectiveCamera`, offset from a
  focus point by (pitch 35°, yaw 45°, distance); `follow()` lerps focus toward
  hero; `lookAt(focus)`.
- Fix edge-pan: rotate the pan vector into the camera's screen-right / screen-up
  world basis (currently hard-coded world X/Z) — in `Game.update` + `InputManager`.
- Minimap view-rect + `viewHalfWidth()` become approximate under perspective.
- Find & remove the `scaleY(-1)` canvas flip.
- Verify: hero + obstacles seen at a clean 3/4 angle; panning/aim still aligned.

**Phase 1 — Terrain module + mesh**
- Add `Terrain.ts`; replace the flat ground plane in `Game.init` with `terrain.mesh`.
- Author a test map: 2–3 hills + a valley so elevation is obvious in screenshots.
- Verify: hills render and shade correctly (still flat gameplay).

**Phase 2 — Entities follow the ground (visual)**
- `Hero`: take a `heightSampler`; set `mesh.position.y = heightAt(x,z)+offset` in
  `update`; keep waypoints XZ-only (Y resampled each frame); fix respawn Y.
- `InputManager`: raycast `terrain.mesh` (fallback to plane) for click **and** aim,
  then **keep XZ only** — the aim/move target is a 2D ground point.
- Camera focus Y lerps to terrain under hero (rises over hills).
- Obstacles / shop bases + `ObstacleRegistry` centers offset by terrain height.
- Verify: click hero up a hill — it climbs; camera and cursor track the surface.

**Phase 3 — Height-aware navigation**
- `Terrain.applyToNav`: block cells steeper than `maxWalkableSlope` (cliffs).
- Optional: slope cost multiplier in `getNeighbors` so paths prefer gentle grades.
- Verify: hero paths *around* a too-steep face instead of straight up it.

**Phase 4 — Projectiles: 2D simulation, fly-height render**
- Gameplay stays 2D: `ArrowAbility.fire` keeps `dir.y = 0`; direction = aim ground
  point − hero, normalized in XZ. Straight XZ line, no arc.
- `Projectile.update`: advance in XZ; set `mesh.y = heightAt(x,z) + flyHeight` each
  step so the arrow rides over terrain. **Remove** the `y≥6` clamp.
- **Remove terrain collision entirely** — arrows never hit the ground/slopes.
- **`_checkHeroCollision` → pure 2D:** delete the `dy > scale*2.0` Y-window; hit =
  `distXZ < bodyRadius + collisionRadius`. Height no longer affects hits.
- Spawn at `heightAt(hero) + flyHeight`. Obstacle collision stays as-is (or also
  2D — obstacles are ground features).
- Verify: shots from a hilltop hit a lower target and vice-versa, identically;
  the arrow visibly arcs over intervening terrain but never buries into it.

**Phase 5 — Polish (optional)**
- Tilt hero to ground normal; project shadow disc onto terrain height.
- Camera wheel-zoom (dolly distance); real shadow maps.
- Minimap height shading; terrain textures; scatter foliage by slope/height.
- **Vision / high-ground rule** (own system): fog so low ground can't target units
  on high ground; optional WC3-style 25% uphill miss chance.

## Key risks / gotchas

- **Camera-basis conversion** for edge-pan and minimap-click is the easiest thing
  to get subtly wrong under a 45° yaw — do it once, centrally.
- Don't reintroduce height into hit detection. Everything gameplay is XZ; Y is
  render-only. The tempting `dy` check is exactly what breaks uphill/downhill.
- Per-`mousemove` raycast against the terrain mesh is fine at this scale; throttle
  only if profiling says so.
- Keep `heightAt` cheap (bilinear, no mesh raycast) — hot path every frame.

## Suggested order to ship

Phase 0 alone already delivers the "3D isometric" look and is low-risk. Phases 1–2
deliver walkable elevation. Phase 3 makes climbing tactical; Phase 4 keeps combat
fair and readable across heights. Phase 5 is shine (and where high-ground *tactics*
live, via vision).

## References

- [LoL Targeting (2D gameplay, selection height)](https://leagueoflegends.fandom.com/wiki/Targeting)
- [LoL Terrain / Map (height is cosmetic)](https://leagueoflegends.fandom.com/wiki/Map_(League_of_Legends))
- [WC3 projectile & missile tutorial (Hive)](https://www.hiveworkshop.com/threads/projectile-missile-tutorial.254856/)
- [WC3 constant fly-height over terrain (The Helper)](https://www.thehelper.net/threads/constant-flyheight-cliff-jumping.147345/)
