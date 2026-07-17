# Map Editor — High-Level Plan

> **Status: implemented (2026-07-17), all four phases.**
> - `pnpm editor` — open the editor (dev only, never deployed)
> - `?map=<name>` — play a custom map (offline or `&room=` multiplayer)
> - `pnpm test:map` / `pnpm tsx scripts/test-editor.ts` / `scripts/test-map-net.ts` — format, editor, and multiplayer tests
> - `pnpm publish:map <name>` — JSON → .amap (the editor's Save writes both)
> - `pnpm build:navdata` — bake maps (incl. `maps/*.map.json`) for the server
>
> Example: `maps/glade.map.json` (3.4 KB working file → 229 B published .amap).

A local-only, browser-based map editor for creating custom Archer maps: drag/paint
terrain (cliffs, ramps, water), place doodads (trees, rocks, bushes) and gameplay
entities (jungle camps, spawns), with hotkeys for everything, then save to a
compact format the game and server load like any other map.

## Why this is tractable today

Everything downstream of map loading consumes one shape — `MapData`
(`src/world/wc3/MapData.ts`): per-tilepoint terrain arrays, a pathing grid,
a doodad list, and bounds. `src/world/testMap.ts` already builds that shape
entirely in code, and — critically — **derives** the pathing grid from cliffs,
ramps, boundaries, and rock footprints instead of storing it. The editor is
therefore "a UI that emits the inputs `buildTestMapData()` hardcodes", and the
custom-map loader is a generalized `buildTestMapData()`.

---

## 1. Compact map format (`.amap`)

### Principle: store only author intent, derive everything else

The WC3 assets are large (~1.2 MB for w3e+wpm+doo) because they store *baked
output*: a 4×4-cells-per-tile pathing bitmap, final heights, per-point
variation, etc. A custom map should store only what the author actually chose;
the loader recomputes the rest exactly the way `testMap.ts` does:

| Stored (source of truth) | Derived at load (not stored) |
|---|---|
| map size in tiles, tileset | `bounds`, arena rect |
| per-tilepoint: cliff layer (4 bits) | `finalHeight` (layer × 128 + height/4) |
| per-tilepoint: texture index (4 bits) | texture `variation` (seeded hash, as testMap does) |
| per-tilepoint: ramp/water flags (2 bits) | `finalWaterHeight` |
| — | **all ground heights**: layer × 128, plus fixed pond floor/rim dips on water tilepoints (same constants as `testMap.ts`) |
| — | **entire pathing grid** (cliff/boundary/rock logic from `testMap.buildPathing`) |
| doodads: `{typeId, x, z, angle, scale}` quantized | projectile-blocking AABBs, tree footprints, nav grid |
| creep camps: `{x, z, unitKinds[]}` | creep spawn state |
| hero spawn points | — |

### Encoding

Binary, versioned header, then bit-packed sections, then **deflate** via the
browser-native `CompressionStream('deflate-raw')` (no dependency; Node ≥18 has
it too, so `scripts/` and the server can decode identically).

- Terrain: 10 bits/tilepoint (layer 4 + texture 4 + flags 2) packed — that's
  the *entire* terrain payload, since heights are fully derived from layer +
  water flags. A 64×64 map = 65×65 = 4 225 points ≈ **5.3 KB raw**, and since
  authored terrain is highly repetitive (runs of same layer/texture) deflate
  takes it to **~1–2 KB**.
- Doodads: typeId as index into a palette table in the header; x/z quantized
  to uint16 (map-relative, sub-unit precision is irrelevant for placement),
  angle uint8, scale uint8 → **7 bytes each**, so 300 doodads ≈ 2 KB.
- Camps/spawns: a few dozen bytes.

**Expected total: 3–8 KB per map** vs ~1.2 MB today — small enough to embed in
server navdata, cache aggressively, or even put in a URL later. A JSON variant
of the same fields (pretty for git diffs) is the editor's *working* format;
`.amap` binary is the *published* format. Both live in a new `maps/` dir.

### Loader

New `src/world/customMap.ts`:
`decodeAmap(buf) → MapSource` → `buildCustomMapData(src) → MapData` (generalizing
`buildTestMapData`: same height math, same `buildPathing`, same obstacle/AABB
derivation). `maps.ts` grows a third branch: any `?map=<name>` not in the
built-in list fetches `maps/<name>.amap`.

---

## 2. The editor app (dev-only, never deployed)

A second Vite entry — `editor.html` + `src/editor/` — run via `pnpm dev:editor`
(its own `vite.config.editor.ts` / port). It is excluded from `pnpm build`, so
nothing ships. It **imports the game's own rendering modules** (`Wc3Terrain`,
`Doodads`, `Water`, camera) so what you see is exactly what players get — no
second renderer to maintain.

### Core pieces

- **EditorState**: the `MapSource` being edited + an undo/redo command stack
  (every tool action is a command; cheap because MapSource is small).
- **Live preview**: on each edit, rebuild the affected chunk of terrain mesh /
  doodad instances (terrain meshing is already chunk-friendly; worst case a
  full rebuild of a 64×64 map is fast enough at editor cadence).
- **Overlays** (toggleable): derived pathing grid (walkable/blocked cells),
  tile grid, camp aggro radii, spawn markers. The pathing overlay is the
  killer feature — since pathing is derived, the author must see it live.

### Tools & hotkeys

Single-key tool switching, matching your "hotkey per object" ask:

| Key | Tool | Interaction |
|---|---|---|
| `1` | Raise cliff layer | click/drag paints tiles up a layer |
| `2` | Lower cliff layer | drag paints down |
| `3` | Ramp | click a cliff edge tile → auto-places the 2-wide ramp flag pattern testMap uses |
| `4` | Water/pond | drag paints water flag + floor dip |
| `5` | Texture paint | drag; `[`/`]` cycles ground texture |
| `Q/W/E` | Tree (dark/green/teal) | click to place, drag to scatter-paint a cluster |
| `R` | Rock (solid) | click to place |
| `T` | Bush/flower/mushroom | `[`/`]` cycles variant |
| `C` | Creep camp | click places camp; `[`/`]` cycles composition (ghoul×2, dragon, …) |
| `P` | Hero spawn | click (max N, numbered) |
| `X` / `Esc` | Eraser / select | click deletes hovered object |
| `,` `.` / scroll | rotate / scale hovered doodad before drop |
| `G` | grid-snap toggle |
| `Ctrl+Z / Ctrl+Shift+Z` | undo / redo |
| `Ctrl+S` | save |

A thin left palette panel mirrors the hotkeys (click = same as key) and shows
the active brush; a `?` overlay lists all bindings. Drag-and-drop from the
palette onto the canvas is the pointer path for the same placements.

### Map lifecycle

- **New map** dialog: name + dimensions in tiles (e.g. 32–128, square or rect);
  generates flat layer-2 grass with the blocked boundary ring.
- **Save/Load**: `pnpm dev:editor` serves through a tiny Vite dev-server
  middleware exposing `GET/PUT /maps/:name` that reads/writes `maps/*.map.json`
  in the repo — saves land directly in git, no download dance.
- **Export**: "Publish" button runs the JSON→`.amap` encoder and writes
  `maps/<name>.amap`.
- **Playtest**: button opens `http://localhost:5173/?map=<name>` in a new tab.

---

## 3. Game & server integration

- **Client**: `maps.ts` registry change described above; `Doodads`,
  fog, minimap, sim all work unchanged because `MapData` is unchanged.
- **Creeps**: `creepRules.ts` currently hardcodes camps as arena-rect
  fractions. Add an optional per-map camp list (world coords) to `LoadedMap`;
  fall back to the current fractional defaults for arena/test.
- **Server**: `scripts/build-navdata-compact.ts` already bakes each map into
  `server/navdata.ts`. Extend it to sweep `maps/*.amap` (decode → same
  nav-grid bake). Since `.amap` is a few KB, the map's *source* can also be
  embedded so the server derives camps/spawns/obstacles from one artifact.
  `GameRoom` map-name validation switches from the hardcoded union to
  "exists in NAVDATA".

---

## 4. Phases

1. **Format + loader** (no UI): `MapSource` type, JSON + binary codecs,
   `buildCustomMapData`, `maps.ts` hookup. Prove it by hand-writing a small
   JSON map and playing it via `?map=`. Add a round-trip + size test.
2. **Editor MVP**: editor entry point, camera, terrain painting (layers,
   ramps, water, textures), doodad placement, hotkeys, undo, save/load via
   the dev-server middleware, pathing overlay.
3. **Gameplay layer**: creep camps, spawns, arena-rect editing, aggro-radius
   overlay, playtest button; per-map camps in sim + client.
4. **Server support**: navdata sweep of `maps/`, GameRoom validation, one
   multiplayer smoke test on a custom map.

Phase 1 is the risk-retiring step — it locks the format and proves derived
pathing matches gameplay expectations before any UI work.

## Decisions

- **Heights: cliff layers + pond dips + ramps only** (decided 2026-07-17).
  No free-form sculpting; no per-point height data is stored. The water tool
  paints flags and the loader bakes the fixed floor/rim dip pattern from
  `testMap.ts`. If smooth hills are ever wanted, a sparse height-offset
  section can be added behind a format version bump.

## Open questions

- Rect (non-square) maps: `testMap` assumes square; the generalized builder
  should take width×height from day one even if the editor UI starts square.
- Whether the editor needs the WC3 arena loaded as a reference/starting point
  (import path from `MapData` → `MapSource` is possible but lossy; suggest
  custom maps are born in the editor only).
