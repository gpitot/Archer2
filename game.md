# Game Design Overview

## Vision

The game is a browser-based, online multiplayer competitive arena game viewed from an isometric perspective. Each player controls a single hero in fast-paced matches focused on positioning, prediction, precision, and mechanical skill.

Unlike traditional MOBAs, there are no lanes, towers, bases, or resource farming. Every player begins the match on equal footing, spawning at a random location within the map. The objective is simple: hunt other players, eliminate them using skill-based abilities, and reach the target score before everyone else.

Combat is designed around long-range projectile mechanics where success comes from reading opponents, predicting movement, controlling space, and landing difficult shots rather than relying on lock-on abilities or character statistics.

The game should feel somewhere between a MOBA, a top-down shooter, and a game of archery. Every encounter is a duel of movement, positioning, and accuracy.

---

# Core Gameplay Loop

A match begins with every player spawning at a random location on the map.

Players immediately begin exploring the environment, searching for opponents while attempting to remain hidden or gain advantageous positioning.

When an enemy is located, combat begins.

Players maneuver around terrain, obstacles, and elevation while charging and firing abilities in an attempt to eliminate each other. Every ability is a manually aimed skill shot.

Landing attacks damages opponents. Successfully eliminating another hero awards points.

Defeated players respawn elsewhere on the map after a short delay, allowing matches to continue without downtime.

The game continues until one player reaches the target score, at which point the match ends and final rankings are displayed.

---

# Hero Design

Every player controls exactly one hero.

Heroes are intentionally lightweight in terms of complexity. The emphasis is on player skill rather than RPG progression.

Each hero has:

* Position
* Facing direction
* Movement speed
* Health
* Spell cooldowns
* Inventory (future)
* Status effects (future)

Heroes do not level up during a match.

They begin every game with identical base statistics.

Future updates may introduce multiple hero archetypes, but the MVP focuses on a single hero class.

---

# Movement

Movement is click-to-move, inspired by traditional isometric action RPGs and MOBAs.

Players click anywhere on the terrain and the hero automatically navigates there using pathfinding.

Movement should:

* Navigate naturally around obstacles
* Avoid trees, rocks and cliffs
* Feel responsive
* Allow rapid direction changes

Future improvements may include:

* Holding movement commands
* Queued movement
* Smart obstacle avoidance
* Formation avoidance between heroes

---

# Combat Philosophy

Combat is entirely skill based.

There are no guaranteed hits.

Every offensive spell is a projectile that exists physically within the world.

Players must:

* Aim manually
* Predict enemy movement
* Control projectile timing
* Position carefully
* Dodge incoming attacks

A highly skilled player should consistently outperform inexperienced players regardless of time invested.

---

# Primary Ability — Charged Arrow

The Arrow is the defining mechanic of the game.

Players hold the cast button to charge the attack.

While charging:

* A power meter increases.
* Maximum travel distance increases.
* Projectile speed may increase.
* Visual effects communicate charge level.

Releasing the button fires the arrow.

Arrow behaviour:

* Travels in a straight line.
* Stops after reaching its maximum range.
* Collides with heroes.
* Collides with terrain.
* Can potentially collide with environmental objects.

Charge determines:

* Travel distance
* Flight speed
* Damage (optional)
* Visual appearance

Landing a maximum-range shot should feel highly rewarding.

---

# World Design

The battlefield is a fully navigable 3D environment viewed from an isometric camera.

Although movement occurs primarily across the ground plane, the terrain itself contains meaningful variation.

The map includes:

* Hills
* Valleys
* Raised cliffs
* Forests
* Large rocks
* Rivers (future)
* Narrow pathways
* Open battlefields

Terrain exists for gameplay, not just aesthetics.

Elevation should influence visibility, movement options, and tactical positioning.

Forests can partially obscure players and provide opportunities for ambushes or escape.

Open areas encourage long-range engagements, while tighter spaces create more intense close encounters.

---

# Camera

The camera remains fixed in an isometric perspective.

Players cannot freely rotate it.

Advantages:

* Consistent visibility
* Easier competitive balance
* Predictable aiming
* Simpler controls

Camera movement follows the controlled hero smoothly while keeping enough surrounding space visible for ranged combat.

---

# Match Structure

Every match consists of:

1. Lobby creation
2. Players connect
3. Countdown
4. Random spawning
5. Active combat
6. Score tracking
7. Victory when score target reached
8. End-of-game scoreboard
9. Return to lobby

Typical match duration:

10–20 minutes.

---

# Multiplayer Architecture

The game is designed as a browser-native multiplayer experience using peer-to-peer networking rather than dedicated game servers.

Players establish direct connections with one another using WebRTC DataChannels, allowing gameplay state to be exchanged with low latency once peers are connected. A lightweight signalling service is only required to help peers discover each other and negotiate the initial WebRTC connection; it is not involved in gameplay after connections are established.

One peer acts as the temporary host (authoritative peer) for the duration of a match. The host is responsible for validating game state, resolving combat outcomes, coordinating simulation timing, and distributing authoritative updates to the other peers. If the host disconnects, a host migration process can elect another participant to continue the match.

Each peer is responsible for:

* Local player input
* Local rendering
* Animation
* Audio
* Prediction
* Interpolation

The authoritative host is responsible for:

* Hero positions
* Spell simulation
* Projectile collision
* Damage
* Deaths
* Respawns
* Scores
* Match timers
* Win conditions

To provide responsive controls, player movement and ability usage should be predicted locally, with authoritative corrections applied smoothly when necessary.

This architecture keeps infrastructure requirements minimal while maintaining a consistent game state across all players.

---

# MVP Scope

The first playable milestone should prove the core gameplay before adding additional systems.

The MVP includes:

## World

* One playable arena
* Navigable terrain
* Elevation
* Trees
* Rocks
* Obstacles
* Basic lighting

## Hero

* Single hero model
* Click-to-move controls
* Pathfinding
* Idle animation
* Walking animation
* Health
* Death
* Respawn

## Combat

* Charged Arrow ability
* Projectile simulation
* Collision detection
* Damage
* Hit effects
* Death effects

## Multiplayer

* Lobby creation
* Peer discovery and WebRTC connection setup
* Peer-to-peer gameplay
* Host authority
* Player synchronisation
* Score tracking
* Match completion

## NPC Test Characters

To accelerate development before full multiplayer testing, AI-controlled heroes should be available.

NPCs should support:

* Random wandering
* Obstacle avoidance
* Target acquisition
* Basic aiming
* Arrow attacks
* Taking damage
* Dying
* Respawning

These AI characters serve as repeatable test cases for movement, combat, collision detection, networking, and future gameplay mechanics.

---

# Long-Term Expansion

Once the MVP is stable, the architecture should support incremental additions without requiring major redesign.

Potential future features include:

* Multiple hero classes
* Additional projectile types
* Area-of-effect abilities
* Status effects
* Equipment and consumable items
* Environmental hazards
* Dynamic maps
* Team game modes
* Ranked matchmaking
* Spectator mode
* Replay system
* Cosmetics and progression
* Custom maps
* Tournament support

The overall design philosophy should remain focused on mechanical skill, readable combat, low-latency multiplayer, and satisfying projectile-based gameplay, with new content adding strategic depth without sacrificing the accessibility and responsiveness of the core experience.
