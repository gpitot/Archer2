---
name: archer-map-design
description: Design, generate, and balance-verify Archer custom maps (.map.json / .amap). Use when asked to create a new map, lay out spawns/camps/shops/runes/fountains, make a map for N players, balance an existing map, or check that starting positions are fair. Covers the symmetry-by-generation method, the engine's terrain constraints, and the verification harness.
---

# Archer map design

Custom-map *mechanics* (format, codecs, editor, navdata bake) are documented in
`docs/map-editor-plan.md` and the source headers of `src/world/custom/`. **Read
those for how the format works.** This skill covers what those files do not: how
to lay a map out so it is actually balanced, and how to prove that it is.

## The core method: symmetry by generation, not by hand

For any player count that isn't 2 or 4, a hand-drawn rectangular layout cannot be
fair — someone gets a corner, someone gets a middle. Don't try. Instead **write a
generator script** and get symmetry as a structural property:

1. Author every feature once as `(angleOffset, radius)` inside a single
   `360/N`-degree sector, then emit it at all N rotations.
2. Classify every terrain tilepoint by a **function of `(radius, angle folded
   into one sector)`** — never by hand-painted rows.
3. Let the square map's corners fall outside the playable disc and become
   impassable rim. That waste is what buys the symmetry.

The result is invariant under a `360/N` rotation, so all starts are the *same
position up to rotation*, not merely similar ones.

`scripts/gen-pentad-map.ts` is the worked example (5 players). Copy its shape:
polar helpers, a `ring()` that emits all rotations, `layerAt`/`isRamp`/`isWater`/
`textureAt` as pure functions of position, then assemble a `MapSource` and
`serializeMapJson` it.

Reserve angular lanes so features don't collide: `0°` = the player's own
corridor (spawn, shop, own camp), `±180/N°` = the boundary axis shared with a
neighbour — put contested things (fountains, tough camps) there, since a point on
the boundary axis is provably equidistant from two spawns.

## Sizing

Budget by playable area per player. `1v1` runs ~98 tiles²/player; ~135 is a good
target for a free-for-all where players need room to disengage. For a disc of
radius R on a `T×T` tile map: playable ≈ `πR²/128²` tiles², and R must leave the
1-tile blocked boundary ring clear (`R < T·64 − 128`).

Sanity-check the result in seconds, not units — `HERO.baseSpeed` is 350 u/s.
Nearest-neighbour spawn ~5s and cross-map ~9s felt right for 5 players.

## Engine constraints that bite

- **Camps climb their ladders forever** (`campComposition`). The authored units
  are tier 0 only. Check spawn clearance against the **max aggro on the camp's
  ladder** (melee tops out at yeti 420, ranged at dragon 550), not the authored
  units — otherwise a map that is safe at minute 0 aggroes spawns at minute 40.
- **A tile is a walkable ramp** only if its 4 corners span mixed layers *and*
  ≥2 corners carry `SRC_FLAG_RAMP`. Flag a band of tilepoints spanning the layer
  boundary on both sides; the wedge edges will have <2 flagged corners and
  correctly become the ramp's side walls.
- **Only *mixed*-layer tiles block.** A uniformly layer-4 region has a walkable
  interior — so plateau tops and the outer mountains are walkable pockets that
  are simply unreachable. This is inert: `findReachableNear` gates Blink Dagger
  and `randomWalkablePos` restricts to the shop-reachable region, so nothing can
  strand a hero there. Don't "fix" it, but don't put anything in one either.
- **Water does not block pathing** — `buildPathing` only considers the boundary
  ring, `tileIsCliff`, and solid-rock footprints. Ponds are decorative.
- **A pond needs a ≥3×3 block of water tilepoints** to get an interior floor
  point (`buildTerrain` requires all 8 neighbours be water), i.e. radius ≳ 192u.
- **Trees and `rock` doodads block pathing**; rocks also block projectiles. A
  treeline can silently sever a lane — always re-run reachability after adding
  doodads.
- **Server spawn wrapping**: `MAX_PLAYERS` is 8 and `_spawnPosFor` wraps by team
  index, so an N-spawn map silently doubles players up beyond N. Say so when
  handing over a map with fewer than 8 spawns.

## Verification

Never claim balance — measure it. `scripts/check-map-balance.ts <name>` runs the
audit: reachability of every POI from every spawn, per-player sorted distance
profiles, ladder-max camp aggro clearance, and placements-on-walkable-ground.
`scripts/map-overview.ts <name>` renders a top-down PNG from the *baked* nav grid
(what the sim sees, not what the renderer draws) — the fastest way to eyeball
symmetry.

On a symmetric map the profiles come out visibly paired, e.g. spawns
`[0, 1788, 1789, 3070, 3070]`. That pairing *is* the evidence.

### Two measurement traps

Both of these produce fake asymmetry. If an audit reports a uniform few-percent
error across every metric, suspect the tool before redesigning the map.

- **Never measure with a raw grid BFS.** 8-connected octile distance
  overestimates by up to 8% depending on heading, and N spawns sit at N
  different angles to the lattice — so a BFS attributes its own metric
  anisotropy to the map. Use `pathfinder.findSmoothedPath`, which is what units
  actually walk; string pulling removes the bias.
- **Snap the endpoint, don't minimise over a neighbourhood.** Measuring to the
  cheapest cell within ±k cells shaves a constant off every reading and makes
  short trips meaningless (a 200u walk to your own shop read as 128u). Measure
  to the point's own cell, falling back to the nearest walkable one only if it
  is blocked.

### Residual error is irreducible

An N-fold rotation cannot map a square lattice onto itself for N ∉ {2,4}, so
tilepoint and 32u nav-cell rounding differ slightly per sector. Assert a
*budget* rather than exact equality — 0.25s of running (~87u) is a good ceiling.
Report the residual honestly instead of claiming perfect symmetry.

## Workflow

```
pnpm tsx scripts/gen-<name>-map.ts      # generate maps/<name>.map.json
pnpm publish:map <name>                 # → maps/<name>.amap
pnpm tsx scripts/check-map-balance.ts <name>
pnpm tsx scripts/map-overview.ts <name> /tmp/<name>.png
pnpm build:navdata                      # required for multiplayer; redeploy server
pnpm tsx scripts/shot-map.ts <name>     # in-engine screenshot, catches page errors
pnpm typecheck
```

Keep the generator in `scripts/` and re-run it to edit the map — hand-editing
the generated `.map.json` destroys the symmetry guarantee.

**Known noise:** `pnpm test:map` fails `spawnCamps: unit count — 14/5` on a clean
tree (it tests `glade`). Confirm with `git stash` before attributing it to your
change.
