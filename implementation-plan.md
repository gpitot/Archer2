# Implementation Plan — Archer.js

## Technology Stack (recommended)

| Concern               | Choice                          |
|-----------------------|---------------------------------|
| Language              | TypeScript                      |
| Bundler / Dev Server  | Vite                            |
| Rendering (3D)        | Three.js                        |
| Physics / Collision   | Rapier (WASM) or custom raycasts|
| Pathfinding           | Custom A* on a grid or navmesh  |
| Networking            | WebRTC (simple-peer / peerjs)   |
| Signalling            | Lightweight Node.js + WS server |
| UI                    | HTML/CSS overlay or canvas 2D   |
| ECS / Structure       | Custom lightweight ECS or plain classes |

---

## Phase 1 — Project Setup & Rendering Pipeline

**Goal:** A browser window showing an isometric 3D scene with a ground plane, basic lighting, and a camera that follows a placeholder object.

### Topics

- Scaffold project with Vite + TypeScript
- Configure Three.js, renderer, and scene
- Set up an orthographic or perspective camera in isometric configuration
- Create a flat ground plane with a grid or simple material
- Add ambient + directional lighting (shadows deferred)
- Implement a fixed isometric camera that can pan to follow a target
- Render a placeholder hero (capsule, cylinder, or box)
- Set up the basic game loop (`requestAnimationFrame` with fixed timestep)
- Dev tooling: hot reload, debug overlays, stats panel

**Success criteria:** Browser shows a colored ground plane with a lit placeholder capsule. Camera is isometric and can be scripted to follow a moving object.

---

## Phase 2 — Hero & Click-to-Move

**Goal:** Player clicks on the terrain and the hero navigates there with pathfinding, avoiding obstacles. Hero faces movement direction.

### Topics

- Implement a 2D navigation grid overlaid on the terrain
- Port or write a simple A* pathfinder operating on the grid
- Mouse → world raycasting to determine click destinations
- Click-to-move: on click, compute path, walk along waypoints
- Hero facing direction (smooth rotation toward movement vector)
- Simple movement animations / state machine (idle ↔ walking)
- Obstacle representation in the nav grid (static blockers first)
- Responsive feel: allow re-clicking mid-path to change destination

**Success criteria:** Click anywhere on the terrain. Hero walks there around obstacles (even if obstacles are just blocked grid cells for now). Re-clicking changes destination smoothly.

---

## Phase 3 — Charged Arrow Ability

**Goal:** Hold a key to charge, release to fire a projectile that travels through the world, collides with terrain and (later) other heroes.

### Topics

- Input handling: key down starts charge, key up fires
- Charge state machine: idle → charging → fired → cooldown
- Power meter (linear 0→1 over time, with a cap)
- Visual feedback while charging (hero glow, meter bar, particle buildup)
- Projectile entity: spawn at hero position, fly in facing direction
- Projectile speed and max distance scaling with charge level
- Projectile-terrain collision (raycast or sphere cast each frame)
- Projectile self-destruct on max range or terrain hit
- Impact visual effect (particles, flash)
- Cooldown before next charge can begin

**Success criteria:** Hold mouse button (or key), see charging feedback, release → arrow flies in a straight line, stops at max range or on terrain impact. Cooldown prevents spam.

---

## Phase 4 — Health, Damage & Death

**Goal:** Projectiles that hit heroes deal damage. Heroes have health, can die, and respawn.

### Topics

- Health component on heroes (numeric HP)
- Projectile-hero collision detection (sphere/AABB tests)
- Damage application on hit
- Hit visual/audio feedback (flash red, knockback particles)
- Death state: hero ragdoll-freeze or disappears, death effect
- Death cooldown (timer before respawn)
- Respawn logic: teleport hero to random valid map position
- Invulnerability window after respawn (brief, visual indicator)
- Health bar UI above heroes (billboard sprite or 3D widget)
- Damage numbers (optional, floating text)

**Success criteria:** Arrow hits a hero → HP decreases. HP reaches 0 → hero dies (visual feedback), then respawns elsewhere after a few seconds.

---

## Phase 5 — World & Environment

**Goal:** A proper arena map with varied terrain, elevation, trees, rocks, and meaningful tactical geometry. Pathfinding works across the full map.

### Topics

- Elevation: heightmap-based terrain or modular 3D tiles
- Terrain materials (grass, dirt, rock) with basic texturing
- Tree placement (billboard sprites or simple 3D models)
- Rock and cliff meshes as obstacles
- Navigation grid accounts for elevation (walkable slopes vs. cliffs)
- Line-of-sight / visibility considerations (forests obscure view)
- Map boundaries (invisible walls or natural barriers like cliffs/water)
- Spawn point distribution across the map (valid, separated locations)
- Camera clips or adjusts for tall terrain features
- Basic environment lighting and fog for atmosphere

**Success criteria:** A visually coherent arena exists. Heroes can navigate all walkable areas. Trees and rocks block movement and projectiles. Elevation changes are visible and affect gameplay.

---

## Phase 6 — NPC Test Characters (AI Bots)

**Goal:** AI-controlled heroes that wander, acquire targets, aim, and fight. Serve as test subjects before multiplayer is ready.

### Topics

- NPC behaviour tree or simple state machine: wander → spot enemy → chase → attack → retreat (if low HP)
- Random wandering with obstacle avoidance (use the same pathfinding)
- Target detection: check for heroes within vision radius / cone
- Basic aiming: predict target movement linearly, apply some inaccuracy
- NPC uses the same Charged Arrow ability (same projectile system)
- NPC health, death, and respawn (same as player hero)
- Configurable difficulty (reaction time, accuracy spread, aggression)
- NPC spawning: populate arena with N bots on match start
- NPC count configurable at match setup

**Success criteria:** Boot the game, see N bots moving around the map. They pathfind, detect each other (and the player), fight with charged arrows, die, and respawn. The core combat loop is testable offline.

---

## Phase 7 — Multiplayer Foundation (Networking)

**Goal:** Two or more human players connect via WebRTC, see each other move and fight in the same arena.

### Topics

- Lightweight signalling server (Node.js + WebSocket):
  - Room/lobby creation
  - Peer discovery (exchange SDP offers/answers and ICE candidates)
  - Disconnect detection
- WebRTC DataChannel abstraction (send/receive binary or JSON messages)
- Host election: first peer in room is authoritative host
- Network message protocol (compact binary or JSON with schema):
  - Player input (move destination, charge start, fire)
  - Authoritative state (positions, velocities, HP, scores, projectiles)
  - Match events (player joined, died, respawned, match end)
- Host-side authoritative simulation:
  - Process all player inputs
  - Resolve movement (pathfinding on host, validate against nav)
  - Resolve projectile spawning, flight, and collisions
  - Distribute corrections to peers
- Client-side prediction:
  - Immediately start moving/charging on input, don't wait for host
  - Smoothly reconcile when authoritative state arrives (interpolate/blend)
- Entity interpolation for remote players (smooth visual movement)
- Lag compensation techniques (rewind/replay for hit detection if needed)
- Packet prioritization and rate limiting

**Success criteria:** Two browsers, connected via signalling server, can see each other's heroes moving in the same arena. Movement and projectiles sync with acceptable latency. Host authority resolves conflicts.

---

## Phase 8 — Match Flow & Game Loop

**Goal:** Complete match lifecycle — lobby, countdown, active play, scoring, victory, scoreboard, return to lobby.

### Topics

- Lobby UI:
  - Create or join a room (room code or link)
  - Player list with ready states
  - Match settings (score target, bot count, map selection)
  - Start button (host only)
- Countdown phase: 3-2-1 overlay, heroes not yet spawned
- Spawning: random positions distributed across valid map locations
- Active match:
  - HUD: score, timer, minimap (optional), ability cooldown indicator
  - Score tracking: kill feed events
  - Kill = +1 point (configurable)
  - Death = respawn after short delay
- Victory condition: first player to reach score target
- End-of-match:
  - Freeze gameplay
  - Scoreboard overlay with rankings (kills, deaths, K/D)
  - "Return to lobby" button
- Lobby reset: clear scores, allow config changes, start new match
- Spectator mode for dead players (optional, MVP can skip)

**Success criteria:** Full match plays out from lobby creation through victory screen and back to lobby. Multiple matches can be played in sequence.

---

## Phase 9 — Polish & Feedback

**Goal:** The game feels good. Visual feedback, audio, UI refinement, and performance.

### Topics

- Audio:
  - Arrow charge (building tension sound)
  - Arrow release (whoosh)
  - Arrow impact (thud on terrain, hit sound on hero)
  - Hero death sound
  - Ambient environment audio (wind, forest)
  - UI sounds (lobby join, countdown tick, victory fanfare)
- Visual polish:
  - Better hero model (animated character or stylized capsule)
  - Arrow projectile visual (trail particle, glow)
  - Screen shake on max-charge hit
  - Death effect (explosion, dissolve)
  - Kill notification banner
  - Minimap with hero pings
- UI polish:
  - Charge meter styled as a ring or bar around crosshair
  - Health bar improvements
  - Scoreboard transitions and animations
  - Lobby design pass
- Performance:
  - Object pooling (projectiles, particles, entities)
  - Frustum culling / LOD for distant objects
  - Network message batching
  - Memory profiling and leak checks
- Accessibility:
  - Colorblind-friendly indicators
  - Audio cues for key events
  - Remappable controls

**Success criteria:** Game looks, sounds, and feels polished. Smooth 60 FPS on target hardware. Multiplayer feels responsive.

---

## Phase 10 — Host Migration & Resilience

**Goal:** If the host disconnects, another peer takes over without ending the match.

### Topics

- Host heartbeat detection (peers detect host timeout)
- Migration election algorithm (lowest latency peer, deterministic)
- State transfer: new host reconstructs full game state from last known snapshot
- Brief pause or stutter during migration (acceptable at MVP)
- Client reconnection for temporarily dropped peers
- Graceful degradation: if migration fails, match ends with partial results

**Success criteria:** Kill the host browser tab. After a brief pause, match continues with a new host. Other players barely notice the transition.

---

## Timeline Estimate (rough, single developer)

| Phase | Description                | Effort      |
|-------|----------------------------|-------------|
| 1     | Project Setup & Rendering  | 2–3 days    |
| 2     | Hero & Click-to-Move       | 3–5 days    |
| 3     | Charged Arrow              | 3–4 days    |
| 4     | Health, Damage & Death     | 2–3 days    |
| 5     | World & Environment        | 4–6 days    |
| 6     | NPC AI Bots                | 3–5 days    |
| 7     | Multiplayer Foundation     | 7–10 days   |
| 8     | Match Flow & Game Loop     | 3–5 days    |
| 9     | Polish & Feedback          | 5–7 days    |
| 10    | Host Migration             | 3–4 days    |
| **Total** |                        | **35–52 days** |

---

## Architecture Principles (to carry through all phases)

1. **Separation of concerns** — Rendering, simulation, networking, and UI should be independent modules. The simulation should run without a renderer (for headless host mode in future).

2. **Fixed timestep game loop** — Simulation ticks at a fixed rate (e.g., 60 Hz). Rendering interpolates between ticks for smooth visuals.

3. **Entity-Component pattern** — Heroes, projectiles, obstacles, and pickups should all be entities composed of reusable components (Position, Health, Movement, Collider, Renderable, etc.). Avoid deep inheritance hierarchies.

4. **Deterministic where possible** — Movement, projectile physics, and damage should be deterministic so the host can replicate and validate client actions. Avoid `Math.random()` in simulation; use a seeded PRNG if randomness is needed.

5. **Network-first design** — Even in single-player phases, structure input → action → state updates so that inserting a network layer later doesn't require major refactoring. Client predicts; authority reconciles.

6. **Object pooling** — Projectiles, particles, entities are created and destroyed frequently. Use pools from day one to avoid GC pressure.

7. **Configuration-driven** — Hero stats, map data, match settings, and ability parameters should live in data files (JSON/YAML), not hardcoded. Enables rapid iteration and future modding.

---

## Next Step

For each phase selected to begin work, we will create a detailed plan with:

- File/module breakdown
- Class and interface designs
- Step-by-step implementation order
- Test criteria per step
