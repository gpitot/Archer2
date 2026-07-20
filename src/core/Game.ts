import * as THREE from 'three';
import { GameLoop } from './GameLoop';
import { Renderer } from '../rendering/Renderer';
import { createScene } from '../rendering/Scene';
import { createLighting } from '../rendering/Lighting';
import { IsometricCamera } from '../rendering/Camera';
import { Minimap } from '../rendering/Minimap';
import { Shop, ShopItem } from '../world/Shop';
import { ObstacleRegistry } from '../world/ObstacleRegistry';
import { MapData, ArenaRect, ARENA_TERRAIN1 } from '../world/wc3/MapData';
import { MapName, loadMap, resolveMapName } from '../world/maps';
import { Wc3Terrain } from '../world/Wc3Terrain';
import { Water } from '../world/Water';
import { Doodads } from '../world/Doodads';
import { NavGrid } from '../navigation/NavGrid';
import { Pathfinder } from '../navigation/Pathfinder';
import { FogOfWar, VisionSource } from '../vision/FogOfWar';
import { FogLayer } from '../vision/FogLayer';
import { InputManager } from '../input/InputManager';
import { TargetingSystem, walkableValidator } from '../input/TargetingSystem';
import { ItemBar } from '../ui/ItemBar';
import { KDDisplay } from '../ui/KDDisplay';
import { ShopWindow } from '../ui/ShopWindow';
import { FloatingTextManager } from '../ui/FloatingText';
import { ShopOverlay } from '../ui/ShopOverlay';
import { MoveIndicatorManager } from '../ui/MoveIndicator';
import { DebugPanel } from '../ui/DebugPanel';
import { HeroStatusBar } from '../ui/HeroStatusBar';
import { SpellBar } from '../ui/SpellBar';
import { ScoreWindow } from '../ui/ScoreWindow';
import { KillFeed } from '../ui/KillFeed';
import { playerColor } from '../ui/colors';
import { DEFAULT_NAME, loadPlayerName } from './playerPrefs';

// ── Audio ──
import { SoundManager, STREAK_SOUNDS, MULTI_KILL_SOUNDS } from '../audio/SoundManager';

// ── Sim layer ──
import { HeroState, ProjectileState, WardState, BlastState, CreepState, RuneState, MatchState, Command, HeroInput, SimEvent, createHeroState, createMatchState } from '../sim/state';
import { stepMatch, heroSpeed } from '../sim/stepMatch';
import { spawnCamps } from '../sim/stepCreeps';
import { spawnRunes } from '../sim/stepRunes';
import type { CampPlacement } from '../sim/creepRules';
import { RUNE_TYPES, RunePlacement } from '../sim/runeRules';
import { SimWorld, sphereHitsObstacle, FountainDef, findWalkableNearOnGrid, findWalkableCellNear } from '../sim/world';
import { advanceProjectile } from '../sim/projectiles';
import { buildSimWorld, buildNavGridFromWpm, buildObstaclesFromSolids } from '../sim/buildWorld';
import { AiController, AI_DIFFICULTY_PRESETS, type AiDifficulty } from '../sim/ai/AiController';
import { HERO, ARROW, WARD, SCOUT, BLAST, FOUNTAIN, heroMaxHp } from '../sim/rules';
import { ABILITIES, ABILITY_ORDER, AbilityDef, abilityTooltip, canCast } from '../sim/abilities';
import { SHOP_ITEMS, SHOP_ITEMS_BY_ID } from '../sim/shopItems';
import { SnapshotMessage, MatchInit, Snapshot, SnapshotHero, HeroMeta, CreepMeta, RuneMeta } from '../sim/protocol';
import { creepMaxHp } from '../sim/creepRules';
import { Vec2, distance } from '../sim/math';

// ── Networking ──
import { NetworkClient } from '../net/NetworkClient';

// ── View layer ──
import { HeroView } from '../entities/HeroView';
import { ProjectileView } from '../combat/ProjectileView';
import { WardView } from '../entities/WardView';
import { BlastView } from '../entities/BlastView';
import { RuneView } from '../entities/RuneView';
import { FountainView } from '../entities/FountainView';
import { ExplosionEffects } from '../rendering/ExplosionEffect';
import { ImpactEffects, ImpactElement } from '../rendering/ImpactEffect';
import { PortalEffects } from '../rendering/PortalEffects';
import { LevelUpEffect } from '../rendering/LevelUpEffect';
import { DeathEffect } from '../rendering/DeathEffect';
import { CreepView } from '../entities/CreepView';
import { syncKeyedViews, syncStableViews } from './ViewSync';
import { findStraddlingPair, pruneSnapshots, RenderClock, lerpHero, lerpCreep } from './NetSync';
import { updateHud, type HudContext } from './Hud';
import { bindInput, type InputCallbacks } from './InputBindings';

// ── Debug tooling ──
import { ClientTrace } from '../testing/ClientTrace';
import { perf } from './PerformanceMonitor';

const FOG_CELL_SIZE = 40;

/** Ground surface abstraction. */
interface GroundProvider {
  mesh: THREE.Object3D;
  /** Stepped height — matches the rendered cliffs. */
  heightAt(x: number, z: number): number;
  /** Smooth bilinear height — for consumers that must not step (camera). */
  smoothHeightAt(x: number, z: number): number;
  /** Discrete WC3 cliff layer. */
  layerAt(x: number, z: number): number;
  /** Cliff layer for vision — ramps stay on the lower layer until near the top. */
  visionLayerAt(x: number, z: number): number;
}

export class Game {
  // ── Rendering ──
  private _loop: GameLoop;
  private _renderer!: Renderer;
  private _scene!: THREE.Scene;
  private _camera!: IsometricCamera;
  private _map!: MapData;
  private _mapName: MapName = 'arena';
  private _arena: ArenaRect = ARENA_TERRAIN1;
  /** Fixed spawn points from the map definition (test map); null → random. */
  private _mapSpawns: { x: number; z: number }[] | null = null;
  private _mapCamps: CampPlacement[] | null = null;
  private _mapRunes: RunePlacement[] | null = null;
  private _mapFountains: FountainDef[] | null = null;
  private _mapShops: { x: number; z: number }[] | null = null;
  private _terrain!: GroundProvider;
  private _water!: Water;
  private _doodads!: Doodads;

  // ── Shared world data ──
  private _navGrid!: NavGrid;
  private _pathfinder!: Pathfinder;
  private _obstacleRegistry!: ObstacleRegistry;

  // ── Simulation ──
  private _world!: SimWorld;
  private _state!: MatchState;
  private _playerId!: string;
  /** playerId → display name, for nameplates and the scoreboard. */
  private _names = new Map<string, string>();
  private _pendingCommands: Command[] = [];

  /** Offline AI opponent driving the enemy hero (null in network mode). */
  private _ai: AiController | null = null;
  /** Selected difficulty for the offline AI; defaults to max strength. */
  private _aiDifficulty: AiDifficulty = 'hard';

  // ── Networking ──
  private _network: NetworkClient | null = null;
  private _networkMode = false;
  private _roomCode: string | null = null;

  // ── Prediction & reconciliation ──
  // Own-hero position is predicted locally and only *snapped* to the server
  // on large desync (below). Small drift is left alone on purpose: with
  // click-to-move both sides path the same NavGrid deterministically, so the
  // client is simply a little ahead of the server, and lerping back would
  // rubber-band the hero toward stale state.
  private static readonly SNAP_THRESHOLD = 64; // 2 cells → snap to server

  // ── Interpolation buffer ──
  private _snapshots: SnapshotMessage[] = [];
  /** Server tick duration in seconds; overwritten from the welcome message. */
  private _tickDt = 1 / 60;
  /**
   * How far behind the server tick timeline remote entities render. Sized
   * from the welcome snapshot rate: ~3 snapshot intervals absorbs one
   * dropped/late snapshot plus jitter (150 ms at 20 Hz).
   */
  private _interpDelay = 0.05;

  // ── Render clock ──
  // Remote entities are rendered _interpDelay behind the server tick
  // timeline. The clock advances with local time every frame so remote
  // motion never freezes between snapshot arrivals.
  private _clock!: RenderClock;

  // ── Own projectiles (fully client-rendered) ──
  // Our arrows fly locally from the moment of input: straight line, same
  // speed and obstacle collision as the sim, retired by the server's hit
  // event. The server's copy of an own arrow is *never* rendered — switching
  // mid-flight to its interp-delayed track would teleport the arrow backwards.
  private _cosmeticProjectiles: {
    view: ProjectileView;
    pos: Vec2;
    dir: Vec2;
    speed: number;
    traveled: number;
    maxRange: number;
    /** Server projectile id claimed via our 'fire' event, once known. */
    serverId: string | null;
  }[] = [];
  /**
   * Server ids of our own arrows, kept (even after the local arrow retires)
   * so `_renderProjectiles` never shows the simulated duplicate. An entry
   * lives until its `_remoteProjectiles` entry dies on the render timeline.
   */
  private _ownArrowIds = new Set<string>();

  /**
   * Remote projectiles, keyed by server id. Registered from `fire` events
   * (which carry the full spawn state) and welcome snapshots, then simulated
   * locally — the server never re-sends a projectile after launch.
   * `deathTime` lands with the server's `hit` event; obstacle and max-range
   * deaths are computed locally, mirroring the sim.
   */
  private _remoteProjectiles = new Map<string, {
    ownerId: string;
    /** Absent = hero-owned; 'creep' renders as a fireball. */
    ownerKind?: 'creep';
    /** 'scout' = E vision projectile (no collision, never fog-hidden). */
    kind?: 'scout';
    team: number;
    spawnPos: Vec2;
    dir: Vec2;
    speed: number;
    maxRange: number;
    damage: number;
    /** Seconds on the server tick timeline when the arrow left the bow. */
    spawnTime: number;
    /** Render-timeline death from the server's hit event; null while flying. */
    deathTime: number | null;
  }>();

  // ── Views ──
  private _heroViews = new Map<string, HeroView>();
  private _projectileViews = new Map<string, ProjectileView>();
  private _wardViews = new Map<string, WardView>();
  private _blastViews = new Map<string, BlastView>();
  private _explosions!: ExplosionEffects;
  private _impacts!: ImpactEffects;
  private _portalEffects!: PortalEffects;
  private _levelUpEffect!: LevelUpEffect;
  private _deathEffect!: DeathEffect;
  /** Previous blinkCastTimer per hero, to detect cast completion. */
  private _prevBlinkTimer = new Map<string, number>();
  private _creepViews = new Map<string, CreepView>();
  private _runeViews = new Map<string, RuneView>();
  private _fountainViews = new Map<number, FountainView>();
  private _projectilePool: ProjectileView[] = [];

  // ── Player helpers ──
  /** The local player's HeroState (a live reference into _state.heroes). */
  private _playerState!: HeroState;
  /** The local player's HeroView. */
  private _playerView!: HeroView;

  // ── Vision ──
  private _fog!: FogOfWar;
  private _fogLayer!: FogLayer;
  private _heroVisionAdapters = new Map<string, VisionSource>();
  private _wardVisionAdapters = new Map<string, VisionSource>();
  /** Fog vision granted by in-flight scout (E) projectiles, keyed by id. */
  private _scoutVisionAdapters = new Map<string, VisionSource>();
  /** Lingering vision bubbles dropped along each scout's path (see SCOUT.trail*). */
  private _scoutTrail: { src: VisionSource; ttl: number }[] = [];
  /** Per-scout breadcrumb tracking: where the last bubble was dropped + last known pos. */
  private _scoutTrailDrop = new Map<string, { dropX: number; dropZ: number; lastX: number; lastZ: number; team: number; radius: number }>();

  // ── Input ──
  private _input!: InputManager;
  private _targeting!: TargetingSystem;

  // ── Debug trace (?debug=1) ──
  private _trace: ClientTrace | null = null;
  private _debugReady = false;

  // ── UI ──
  private _floatingText = new FloatingTextManager();

  private _minimap!: Minimap;
  private _spellBar!: SpellBar;
  private _statusBar!: HeroStatusBar;
  private _itemBar!: ItemBar;
  private _kdDisplay!: KDDisplay;
  private _shops: Shop[] = [];
  private _shopOverlay!: ShopOverlay;
  private _shopWindow!: ShopWindow;
  private _scoreWindow!: ScoreWindow;
  private _moveIndicators!: MoveIndicatorManager;
  private _debugPanel: DebugPanel | null = null;
  private _killFeed!: KillFeed;

  // ── Death overlay ──
  private _deathOverlay: HTMLDivElement | null = null;
  private _deathCountdown: HTMLSpanElement | null = null;
  private _wasPlayerAlive = true;

  // ── Audio ──
  private _sound = new SoundManager();
  /** Lazy-init flag: set true on first user interaction (unlocks AudioContext). */
  private _audioInit = false;

  constructor() {
    this._loop = new GameLoop(60);
    this._loop.updateCb = this.update.bind(this);
    this._loop.renderCb = this._render.bind(this);
  }

  /** Map this session will load, resolved from `?map=`. */
  get mapName(): string { return this._mapName; }

  /**
   * Build everything that doesn't depend on who's playing: renderer, scene,
   * terrain, navigation, doodads, fog, sim world, shops.
   *
   * Split out from the match setup so the start screen and lobby can be on
   * screen while this runs — it's the slow part of startup, and `Wc3Terrain`
   * blocks the main thread while it builds. Callers follow this with exactly
   * one of `startNetworkMatch` / `startOfflineMatch`, then `finish()`.
   */
  async preload(): Promise<void> {
    (window as any).__game = this;

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug')) this._trace = new ClientTrace();
    if (urlParams.get('perf')) {
      // Defer enable until renderer is ready (set in the renderer block below).
      perf.getRendererStats = () => {
        try { return this._renderer?.info ?? null; } catch { return null; }
      };
      perf.enable();
    }

    // ── Map data (terrain, pathing, doodads) — ?map= selects the map ──
    this._mapName = resolveMapName(urlParams.get('map'));
    const loaded = await loadMap(this._mapName);
    this._map = loaded.data;
    this._arena = loaded.arena;
    this._mapSpawns = loaded.spawns;
    this._mapCamps = loaded.camps;
    this._mapRunes = loaded.runes;
    this._mapFountains = loaded.fountains;
    this._mapShops = loaded.shops;
    const bounds = this._map.bounds;

    // ── Renderer ──
    this._renderer = new Renderer();
    this._renderer.resize(window.innerWidth, window.innerHeight);
    document.body.appendChild(this._renderer.domElement);

    // ── Scene ──
    this._scene = createScene();
    createLighting(this._scene);

    // ── Terrain (only build chunks overlapping the playable arena) ──
    // ?margin=N  → custom margin in world units (default 1024 = 8 tiles)
    // ?margin=-1 → full map (old behaviour)
    const marginRaw = urlParams.get('margin');
    const arenaBounds = {
      minX: this._arena.minX,
      minZ: this._arena.minZ,
      maxX: this._arena.maxX,
      maxZ: this._arena.maxZ,
    };
    if (marginRaw === '-1') {
      this._terrain = new Wc3Terrain(this._map); // full map
    } else {
      this._terrain = new Wc3Terrain(
        this._map,
        arenaBounds,
        marginRaw !== null ? Number(marginRaw) : 1024,
      );
    }
    this._scene.add(this._terrain.mesh);
    const heightAt = (x: number, z: number) => this._terrain.heightAt(x, z);

    // ── Water ──
    this._water = new Water(this._map);
    this._scene.add(this._water.group);

    // ── Navigation (WPM pathing + tree footprints, same as the server grid) ──
    this._navGrid = buildNavGridFromWpm(
      this._map.pathing,
      { minX: bounds.minX, minZ: bounds.minZ },
      this._map.doodads,
    );
    this._pathfinder = new Pathfinder(this._navGrid);

    // ── Doodads ──
    // Held as a field because `finish()` applies the fog layer to its group,
    // and that now runs in a separate call from this one.
    this._obstacleRegistry = new ObstacleRegistry();
    const doodads = new Doodads(this._map, heightAt, this._obstacleRegistry);
    this._doodads = doodads;
    this._scene.add(doodads.group);

    // ── Fog of war (WC3 rules: discrete cliff layers + tree blockers) ──
    this._fog = new FogOfWar(this._arena, FOG_CELL_SIZE, (x, z) => this._terrain.visionLayerAt(x, z));
    for (const s of doodads.sightBlockers) {
      if (s.x >= this._arena.minX && s.x <= this._arena.maxX &&
          s.z >= this._arena.minZ && s.z <= this._arena.maxZ) {
        this._fog.addSightBlocker(s.x, s.z, s.halfW, s.halfD);
      }
    }
    this._fogLayer = null!; // set below after we know the player's team

    // ── Simulation world ──
    this._world = buildSimWorld(
      this._map.pathing,
      { minX: bounds.minX, minZ: bounds.minZ },
      {
        minX: this._arena.minX, minZ: this._arena.minZ,
        maxX: this._arena.maxX, maxZ: this._arena.maxZ,
        centerX: this._arena.centerX, centerZ: this._arena.centerZ,
        width: this._arena.width, height: this._arena.height,
      },
      this._map.doodads,
    );
    this._world.obstacles = buildObstaclesFromSolids(doodads.projectileSolids);

    // ── Fountains: use authored placements or built-in default positions ──
    if (this._mapFountains) {
      this._world.fountains = this._mapFountains;
    } else {
      // Built-in maps: place two fountains at the arena's quarter-points.
      this._world.fountains = buildDefaultFountains(this._arena, this._navGrid);
    }

    // Shop positions: use authored map spots if available, else arena centre.
    const shopSources: THREE.Vector3[] = this._mapShops && this._mapShops.length > 0
      ? this._mapShops.map((s) => this._findWalkableNear(s.x, s.z))
      : [this._findWalkableNear(this._arena.centerX, this._arena.centerZ)];

    // Sync sim world shop positions to match
    this._world.shops = shopSources.map((src, i) => {
      if (i < this._world.shops.length) {
        this._world.shops[i].pos = { x: src.x, z: src.z };
        return this._world.shops[i];
      }
      return { pos: { x: src.x, z: src.z }, interactRadius: 85, buyRadius: 400, items: SHOP_ITEMS };
    });
    this._world.shops.length = shopSources.length;

    // ── Shop (3D meshes only; buy logic is in the sim) ──
    this._shops = shopSources.map((src) => {
      const s = new Shop(
        new THREE.Vector3(src.x, heightAt(src.x, src.z), src.z),
        SHOP_ITEMS as ShopItem[],
      );
      this._scene.add(s.mesh);
      return s;
    });

    this._shopOverlay = new ShopOverlay();
    this._shopWindow = new ShopWindow({
      onBuy: (shopIdx, itemIdx) => this._enqueueCommand({ type: 'buy', shopIndex: shopIdx, itemIndex: itemIdx }),
      onClose: () => {},
    });

    this._scoreWindow = new ScoreWindow({
      onClose: () => {},
    });

    // ── Match state ──
    this._state = createMatchState();
  }

  /**
   * Adopt a match handed over by the server. `init` comes from `matchStart`
   * (lobby started) or from the `welcome` of a match already in progress —
   * identical payloads, so this is the only network entry point.
   */
  startNetworkMatch(net: NetworkClient, init: MatchInit, names: Map<string, string>): void {
    this._networkMode = true;
    this._network = net;
    this._names = names;

    const welcome = net.welcome!;
    if (init.map && init.map !== this._mapName) {
      throw new Error(`room is on map '${init.map}' — reload with ?map=${init.map}`);
    }

    // All snapshot-timeline math derives from the server's tick rate; the
    // interpolation delay derives from the (lower) snapshot broadcast rate.
    this._tickDt = 1 / welcome.tickRate;
    const snapshotDt = 1 / (welcome.snapshotRate ?? welcome.tickRate);
    this._interpDelay = Math.max(0.05, 3 * snapshotDt);
    this._clock = new RenderClock(this._tickDt, this._interpDelay);

    // Apply the initial snapshot to initialise our state and views.
    this._playerId = welcome.playerId;
    this._applySnapshot(init.snapshot, init.meta, init.creepMeta ?? [], init.runeMeta ?? []);

    // Confirm our hero made it into the snapshot (`_applySnapshot` set
    // `_playerState` from it).
    const ourHero = this._state.heroes.find((h) => h.id === welcome.playerId);
    if (!ourHero) throw new Error('match did not include our hero');

    this._playerView = this._heroViews.get(welcome.playerId)!;
    this._fog.recomputeNow();

    // Later roster changes (joins, renames) refresh the nameplates in place.
    net.onRoster = (players) => {
      this._names = new Map(players.map((p) => [p.playerId, p.name]));
      this._refreshNameplates();
    };

    console.log(`[Game] network mode ready, playerId=${welcome.playerId}, team=${this._playerState.team}, heroes=${this._state.heroes.length}, pos=${this._playerState.pos.x.toFixed(0)},${this._playerState.pos.z.toFixed(0)}`);
  }

  /** Offline practice: local sim, one player plus a dummy bot. */
  startOfflineMatch(playerName: string): void {
    this._names = new Map([['player', playerName], ['dummy', 'Bot']]);

    // ── Offline mode: jungle creep camps, simulated by the local stepMatch ──
    spawnCamps(this._state, this._world, this._mapCamps);

    // ── Offline mode: power-up rune spots ──
    spawnRunes(this._state, this._world, this._mapRunes);

    // ── Offline mode: create local heroes ──
    // Maps with fixed spawns (test map) place the heroes deterministically.
    const heroSpawn = this._mapSpawns
      ? this._findWalkableNear(this._mapSpawns[0].x, this._mapSpawns[0].z)
      : this._findRespawnPosition();
    const playerState = createHeroState('player', 0, { x: heroSpawn.x, z: heroSpawn.z });
    this._state.heroes.push(playerState);
    this._playerId = 'player';
    this._playerState = playerState;

    const dummySpawn = this._mapSpawns && this._mapSpawns.length > 1
      ? this._findWalkableNear(this._mapSpawns[1].x, this._mapSpawns[1].z)
      : this._findWalkableNear(heroSpawn.x + 400, heroSpawn.z + 200);
    const dummyState = createHeroState('dummy', 1, { x: dummySpawn.x, z: dummySpawn.z });
    this._state.heroes.push(dummyState);

    this._syncHeroViews(this._state.heroes);
    this._playerView = this._heroViews.get('player')!;
    this._fog.recomputeNow();
  }

  /**
   * Wire up everything that needs a live match: fog layer, camera, input,
   * HUD, minimap — then start the loop. Call after one of the `start*Match`
   * methods.
   */
  finish(): void {
    if (!this._playerState) {
      throw new Error('finish() called before startNetworkMatch/startOfflineMatch');
    }
    const doodads = this._doodads;

    // ── Fog render layer (needs the player's team, set above) ──
    this._fogLayer = new FogLayer(this._fog, this._playerState.team);
    this._fogLayer.applyTo(this._terrain.mesh);
    this._fogLayer.applyTo(this._water.group);
    this._fogLayer.applyTo(doodads.group);
    for (const s of this._shops) this._fogLayer.applyTo(s.mesh);

    // ── Fountain views (static map objects) ──
    for (let i = 0; i < this._world.fountains.length; i++) {
      const fountain = this._world.fountains[i];
      const fv = new FountainView();
      this._scene.add(fv.mesh);
      this._fountainViews.set(i, fv);
      this._fogLayer.applyTo(fv.mesh);
    }

    // ── Projectile view pool (20 pre-allocated) ──
    for (let i = 0; i < 20; i++) {
      const pv = new ProjectileView(`pool_${i}`);
      this._scene.add(pv.mesh);
      this._projectilePool.push(pv);
    }

    // ── Camera ──
    this._camera = new IsometricCamera();
    this._camera.setBounds(this._arena.minX, this._arena.minZ, this._arena.maxX, this._arena.maxZ);
    this._camera.setTarget(new THREE.Vector3(
      this._playerState.pos.x,
      this._smoothHeightAt(this._playerState.pos.x, this._playerState.pos.z),
      this._playerState.pos.z,
    ));
    this._camera.setFocusY(this._smoothHeightAt(this._playerState.pos.x, this._playerState.pos.z));

    // ── Input ──
    this._input = new InputManager(this._renderer.domElement, this._camera.camera);
    this._input.setGround(this._terrain.mesh);

    // ── Targeting system ──
    this._targeting = new TargetingSystem();

    // Click to move: left-click walks the hero (right-click cancels targeting).
    this._input.onClick((pos) => {
      // Check if click is on any shop
      for (let si = 0; si < this._world.shops.length; si++) {
        const shop = this._world.shops[si];
        const clickDist = Math.hypot(pos.x - shop.pos.x, pos.z - shop.pos.z);
        if (clickDist < shop.interactRadius) {
          const inRange = this._isPlayerNearShop(si);
          const heroDist = Math.hypot(this._playerState.pos.x - shop.pos.x, this._playerState.pos.z - shop.pos.z);
          console.log(`[shop-click] shop=${si} clickDist=${clickDist.toFixed(0)} heroDist=${heroDist.toFixed(0)} clickRadius=${shop.interactRadius} buyRadius=${shop.buyRadius} inRange=${inRange}`);
          this._shopWindow.open(SHOP_ITEMS as ShopItem[], this._playerState.gold, this._playerState.inventory, inRange, si);
          return;
        }
      }
      this._enqueueCommand({ type: 'moveTo', x: pos.x, z: pos.z });
      this._moveIndicators.spawn(pos);
    });

    // ── Keyboard bindings ──
    const inputCb: InputCallbacks = {
      getPlayerState: () => this._playerState,
      enqueueCommand: (cmd) => this._enqueueCommand(cmd),
      activateAbilityTargeting: (def) => this._activateAbilityTargeting(def),
      activateItemTargeting: (def, slot) => this._activateItemTargeting(def, slot),
      openShop: () => {
        if (this._scoreWindow.visible) this._scoreWindow.close();
        const nearest = this._getNearestShop();
        if (nearest) {
          this._shopWindow.open(SHOP_ITEMS as ShopItem[], this._playerState.gold, this._playerState.inventory,
            this._isPlayerNearShop(nearest.index), nearest.index);
        }
      },
      closeShop: () => { if (this._shopWindow.visible) this._shopWindow.close(); },
      isPlayerNearShop: () => {
        const nearest = this._getNearestShop();
        return nearest ? this._isPlayerNearShop(nearest.index) : false;
      },
      isShopVisible: () => this._shopWindow.visible,
      getShopIndex: () => this._shopWindow.shopIndex,
      toggleScore: () => {
        if (this._scoreWindow.visible) {
          this._scoreWindow.close();
        } else {
          if (this._shopWindow.visible) this._shopWindow.close();
          this._scoreWindow.open(this._state.heroes, this._playerState.id, this._names);
        }
      },
      isScoreVisible: () => this._scoreWindow.visible,
      centerOnHero: () => {
        if (this._playerState) {
          this._camera.setTarget(new THREE.Vector3(
            this._playerState.pos.x,
            this._smoothHeightAt(this._playerState.pos.x, this._playerState.pos.z),
            this._playerState.pos.z,
          ));
        }
      },
    };
    bindInput(this._input, this._targeting, inputCb);

    // ── UI ──
    this._spellBar = new SpellBar(ABILITY_ORDER.map((id) => ({
      key: ABILITIES[id].slot,
      abilityId: id,
      maxLevel: ABILITIES[id].maxLevel,
      tooltip: (level: number) => abilityTooltip(ABILITIES[id], level),
      onLevel: (abilityId: string) => this._enqueueCommand({ type: 'levelAbility', ability: abilityId as 'arrow' | 'dodge' | 'reveal' | 'blast' }),
    })));
    this._statusBar = new HeroStatusBar();
    this._itemBar = new ItemBar();
    this._kdDisplay = new KDDisplay();
    this._moveIndicators = new MoveIndicatorManager(this._scene);
    this._explosions = new ExplosionEffects(this._scene);
    this._impacts = new ImpactEffects(this._scene);
    this._portalEffects = new PortalEffects(this._scene);
    this._levelUpEffect = new LevelUpEffect(this._scene);
    this._deathEffect = new DeathEffect(this._scene);
    this._killFeed = new KillFeed();

    // ── Debug panel (local dev only) ──
    if (!this._networkMode) {
      this._debugPanel = new DebugPanel(
        () => this._toggleFog(),
        () => this._debugLevelUp(),
        () => this._debugAddGold(),
        this._mapName === 'test' ? 'arena' : 'test',
        () => this._swapMap(),
        () => this._toggleAI(),
        () => this._cycleDifficulty(),
      );
    }

    // ── Death overlay (desaturate + respawn countdown) ──
    this._createDeathOverlay();

    this._minimap = new Minimap(this._map, this._arena, 200, 8);
    this._minimap.setFog(this._fog, this._playerState.team);
    this._minimap.onClick = (wx, wz) => {
      this._camera.setTarget(new THREE.Vector3(wx, this._smoothHeightAt(wx, wz), wz));
    };
    this._minimap.onDrag = (wx, wz) => {
      this._camera.setTarget(new THREE.Vector3(wx, this._smoothHeightAt(wx, wz), wz));
    };

    window.addEventListener('resize', this._onResize.bind(this));

    // ── Audio init — browsers require a user gesture to unlock AudioContext ──
    const initAudio = () => {
      if (this._audioInit) return;
      this._audioInit = true;
      this._sound.init().catch(() => {});
      document.removeEventListener('pointerdown', initAudio);
      document.removeEventListener('keydown', initAudio);
    };
    document.addEventListener('pointerdown', initAudio);
    document.addEventListener('keydown', initAudio);

    this._loop.start();
    this._debugReady = true;
  }

  /**
   * Straight-to-game startup with no start screen or lobby, for the automated
   * harnesses (`scripts/drive.ts` and friends) that drive the page with
   * `?auto=1`. In a room it joins, readies up, and starts immediately.
   */
  async init(): Promise<void> {
    await this.preload();

    const roomCode = new URLSearchParams(window.location.search).get('room');
    const name = loadPlayerName() ?? DEFAULT_NAME;

    if (roomCode) {
      this._roomCode = roomCode;
      const net = new NetworkClient();
      await net.connect(roomCode, name, this._mapName);
      net.setReady(true);
      net.startGame();
      const init = await net.waitForMatchStart();
      const names = new Map(net.roster.map((p) => [p.playerId, p.name]));
      this.startNetworkMatch(net, init, names);
    } else {
      this.startOfflineMatch(name);
    }

    this.finish();
  }

  get heroState(): HeroState { return this._playerState; }

  // ── Input queue ─────────────────────────────────────────────────────

  private _enqueueCommand(cmd: Command): void {
    // Network mode: put the command on the wire immediately rather than on
    // the next fixed update — shaves up to one update tick of input latency.
    // The queue entry still drives prediction and cosmetic spawns.
    if (this._networkMode && this._network?.isReady) {
      this._network.sendInput(cmd);
    }
    this._pendingCommands.push(cmd);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Re-label existing hero views after a roster change (join, rename). */
  private _refreshNameplates(): void {
    for (const [id, view] of this._heroViews) {
      const hero = this._state.heroes.find((h) => h.id === id);
      if (!hero) continue;
      view.setName(this._names.get(id) ?? id, playerColor(hero.team));
    }
  }

  /**
   * Spawn HeroViews (and fog vision sources) for heroes that appeared and
   * dispose those for heroes that left, so the view layer matches `heroes`.
   * The vision source captures the passed state object, so callers must hand
   * in the *persistent* `_state.heroes` entries — not transient snapshot
   * objects — for `active`/`team` to keep tracking live state.
   */
  private _syncHeroViews(heroes: HeroState[]): void {
    const ids = new Set(heroes.map((h) => h.id));

    for (const [id, view] of this._heroViews) {
      if (ids.has(id)) continue;
      const vSrc = this._heroVisionAdapters.get(id);
      if (vSrc) this._fog.removeSource(vSrc);
      this._heroVisionAdapters.delete(id);
      view.dispose();
      this._heroViews.delete(id);
    }

    const heightAt = this._heightAt.bind(this);
    for (const hs of heroes) {
      if (this._heroViews.has(hs.id)) continue;
      const color = playerColor(hs.team);
      const view = new HeroView(hs.id, color, heightAt);
      view.setName(this._names.get(hs.id) ?? hs.id, color);
      view.sync(hs, 0);
      this._heroViews.set(hs.id, view);
      this._scene.add(view.mesh);
      const vSrc = this._createHeroVisionSource(hs, view);
      this._heroVisionAdapters.set(hs.id, vSrc);
      this._fog.addSource(vSrc);
    }
  }

  // Snapshot entities are deep-copied into `_state` because
  // `_interpolateEntities` mutates their `pos`, and the snapshot buffer it
  // reads from as the interpolation source must stay pristine.
  private _cloneProjectiles(src: ProjectileState[]): ProjectileState[] {
    return src.map((p) => ({ ...p, pos: { x: p.pos.x, z: p.pos.z }, dir: { x: p.dir.x, z: p.dir.z } }));
  }

  private _cloneWards(src: WardState[]): WardState[] {
    return src.map((w) => ({ ...w, pos: { x: w.pos.x, z: w.pos.z } }));
  }

  private _cloneBlasts(src: BlastState[]): BlastState[] {
    return src.map((b) => ({ ...b, pos: { x: b.pos.x, z: b.pos.z } }));
  }

  /**
   * Adopt a full snapshot as the initial local state (welcome handshake).
   * Hydrates full HeroStates from the wire hot fields + cold meta, then
   * builds views. Nothing aliases the snapshot.
   */
  private _applySnapshot(snap: Snapshot, meta: HeroMeta[], creepMeta: CreepMeta[] = [], runeMeta: RuneMeta[] = []): void {
    const metaById = new Map(meta.map((m) => [m.id, m]));
    this._state.heroes = snap.heroes.map((h) => this._heroFromWire(h, metaById.get(h.id)));
    this._state.projectiles = this._cloneProjectiles(snap.projectiles);
    this._state.wards = this._cloneWards(snap.wards);
    this._state.blasts = this._cloneBlasts(snap.blasts ?? []);
    // Hydrate persistent creeps from the cold registry. Ids are stable for
    // the whole match, so this list is never rebuilt — snapshots update hot
    // fields, events carry death/respawn/level.
    this._state.creeps = creepMeta.map((m) => this._creepFromMeta(m));
    // Same for runes: welcome registry, pickup/respawn are event-carried.
    this._state.runes = runeMeta.map((m) => this._runeFromMeta(m));
    this._state.tick = snap.tick;

    // Seed the remote-projectile registry with arrows already in flight,
    // walking each spawn time back from how far it has traveled.
    this._remoteProjectiles.clear();
    for (const p of snap.projectiles) {
      this._registerRemoteProjectile(p, snap.tick * this._tickDt - p.traveled / p.speed);
    }

    const ourHero = this._state.heroes.find((h) => h.id === this._playerId);
    if (ourHero) this._playerState = ourHero;

    this._syncHeroViews(this._state.heroes);
  }

  /** Build a persistent local CreepState from a welcome registry entry. */
  private _creepFromMeta(m: CreepMeta): CreepState {
    return {
      id: m.id,
      campId: m.campId,
      type: m.type,
      pos: { x: m.pos.x, z: m.pos.z },
      facing: 0,
      spawnPos: { x: m.spawnPos.x, z: m.spawnPos.z },
      hp: m.hp,
      level: m.level,
      alive: m.alive,
      respawnTimer: 0,
      aggroTargetId: null,
      attackCooldown: 0,
      path: [],
      lastActiveTick: 0,
      slowTimer: 0,
      burnRemaining: 0,
      burnDps: 0,
      burnSourceId: null,
      burnTickAccum: 0,
      leashing: false,
    };
  }

  /** Build a persistent local RuneState from a welcome registry entry. */
  private _runeFromMeta(m: RuneMeta): RuneState {
    return {
      id: m.id,
      pos: { x: m.pos.x, z: m.pos.z },
      type: m.type,
      active: m.active,
      respawnTimer: 0,
    };
  }

  // ── Network prediction helpers ──────────────────────────────────────

  /**
   * Apply server-authoritative state from the latest snapshot. Remote heroes
   * adopt the server's non-position state (position is set by interpolation);
   * the local player's hero is left to prediction + snap reconciliation.
   */
  private _applyServerState(snap: SnapshotMessage): void {
    const snapIds = new Set(snap.heroes.map((h) => h.id));

    // Update persistent remote hero state (skip our own — prediction owns it).
    for (const sh of snap.heroes) {
      if (sh.id === this._playerId) continue;
      let local = this._state.heroes.find((h) => h.id === sh.id);
      if (!local) {
        // New peer — hydrate from hot fields; cold fields land with the
        // heroMeta flush the server broadcasts on every join.
        local = this._heroFromWire(sh);
        this._state.heroes.push(local);
      }
      this._applyHotFields(local, sh);
      // Position/facing come from interpolation; `moving` drives animation.
      local.moving = sh.moving;
    }
    this._state.heroes = this._state.heroes.filter((h) =>
      h.id === this._playerId || snapIds.has(h.id),
    );

    // Match views to the persistent hero list, then adopt server entities.
    // (Projectiles are rebuilt every frame from the interpolation timeline in
    // `_renderProjectiles`, not adopted here.)
    this._syncHeroViews(this._state.heroes);
    this._state.wards = this._cloneWards(snap.wards);
    this._state.blasts = this._cloneBlasts(snap.blasts ?? []);

    // Creeps: presence in the snapshot means alive; update hot fields.
    // Absence means idle (hold last state) or dead — death arrives via the
    // `creepKill` event, never by omission. The persistent list is stable.
    for (const sc of snap.creeps ?? []) {
      const creep = this._state.creeps.find((c) => c.id === sc.id);
      if (!creep) continue;
      creep.alive = true;
      creep.hp = sc.hp;
      creep.pos.x = sc.pos.x;
      creep.pos.z = sc.pos.z;
      creep.facing = sc.facing;
    }
    this._state.tick = snap.tick;
  }

  /**
   * Reconcile the player's predicted hero with the server snapshot. Non-
   * position state (HP, gold, …) is always taken from the server; position is
   * left to local prediction and only snapped on large desync (see
   * SNAP_THRESHOLD).
   */
  private _reconcileFromSnapshot(snap: SnapshotMessage): void {
    const serverHero = snap.heroes.find((h) => h.id === this._playerId);
    const localHero = this._state.heroes.find((h) => h.id === this._playerId);
    if (!serverHero || !localHero) return;

    // Always adopt server authority for combat state.
    this._applyHotFields(localHero, serverHero);

    // Position: only snap on large desync. Local prediction is authoritative
    // until the server disagrees by more than the snap threshold.
    const dist = distance(localHero.pos, serverHero.pos);
    if (dist > Game.SNAP_THRESHOLD) {
      localHero.pos = { x: serverHero.pos.x, z: serverHero.pos.z };
      localHero.facing = serverHero.facing;
      localHero.targetFacing = serverHero.facing;
      // The wire carries only the destination — rebuild the waypoint path
      // on the same NavGrid the server pathed, from the snapped position.
      localHero.path = [];
      localHero.moving = false;
      if (serverHero.moving && serverHero.dest) {
        const path = this._world.pathfinder.findSmoothedPath(
          serverHero.pos.x, serverHero.pos.z, serverHero.dest.x, serverHero.dest.z,
        );
        if (path && path.length > 1) {
          localHero.path = path.slice(1).map((p) => ({ x: p.wx, z: p.wz }));
          localHero.moving = true;
        }
      }
    }
  }

  /** Build a full local HeroState from wire hot fields (+ cold meta if known). */
  private _heroFromWire(hot: SnapshotHero, meta?: HeroMeta): HeroState {
    const hero = createHeroState(hot.id, hot.team, hot.pos);
    hero.facing = hot.facing;
    hero.targetFacing = hot.facing;
    hero.moving = hot.moving;
    this._applyHotFields(hero, hot);
    if (meta) this._applyMetaFields(hero, meta);
    return hero;
  }

  /** Server-authoritative per-tick fields, safe to adopt for any hero. */
  private _applyHotFields(dst: HeroState, src: SnapshotHero): void {
    dst.team = src.team;
    dst.hp = src.hp;
    dst.alive = src.alive;
    dst.blinkCastTimer = src.blinkCastTimer ?? 0;
  }

  /** Cold fields from a heroMeta message (shallow, safe for plain data). */
  private _applyMetaFields(dst: HeroState, src: HeroMeta): void {
    dst.invulnerable = src.invulnerable;
    dst.invulnerableTimer = src.invulnerableTimer;
    dst.respawnTimer = src.respawnTimer;
    dst.gold = src.gold;
    dst.xp = src.xp;
    dst.level = src.level;
    dst.skillPoints = src.skillPoints;
    dst.kills = src.kills;
    dst.deaths = src.deaths;
    dst.killStreak = src.killStreak;
    dst.multiKillCount = src.multiKillCount;
    dst.multiKillTimer = src.multiKillTimer;
    dst.speedBonus = src.speedBonus;
    dst.bonusHp = src.bonusHp;
    dst.bonusDamage = src.bonusDamage;
    dst.critChance = src.critChance;
    dst.inventory = [...src.inventory];
    dst.wardCharges = src.wardCharges;
    dst.ddTimer = src.ddTimer;
    dst.hasteTimer = src.hasteTimer;
    dst.invisTimer = src.invisTimer;
    dst.slowTimer = src.slowTimer;
    for (const id of ABILITY_ORDER) {
      const srcAbility = src.abilities[id];
      if (!srcAbility) continue;
      const a = dst.abilities[id];
      a.level = srcAbility.level;
      // Don't reconcile the local player's arrow charge / cooldown / recoil —
      // prediction ticks them correctly and the server's value could be stale
      // (not yet processed our fire command). Other abilities' cooldowns keep
      // adopting the server value, exactly as before the record migration.
      const skipPredicted = id === 'arrow' && dst.id === this._playerId;
      if (!skipPredicted) {
        a.cooldown = srcAbility.cooldown;
        if (srcAbility.charges !== undefined) a.charges = srcAbility.charges;
        if (srcAbility.recoil !== undefined) a.recoil = srcAbility.recoil;
      }
      if (srcAbility.active !== undefined) a.active = srcAbility.active;
      if (srcAbility.activeTimer !== undefined) a.activeTimer = srcAbility.activeTimer;
    }
    dst.itemCooldowns = { ...src.itemCooldowns };
  }

  /** Run local stepMatch for the player's hero only (instant movement feel). */
  private _predictMovement(inputs: HeroInput[], dt: number): void {
    // A pending arrow cast point must run through the full step (below) so the
    // wind-up ticks and looses — the timers-only fast path can't spawn it.
    const drawingArrow = (this._playerState?.abilities.arrow.windup ?? 0) > 0;
    if (inputs.length === 0 && !this._playerState?.moving && !drawingArrow) {
      // Prediction isn't stepping this frame, but predicted timers must still
      // run — otherwise a stationary hero's cooldown stays stuck until the
      // next move and the fire guard wrongly rejects follow-up shots.
      const idle = this._state.heroes.find((h) => h.id === this._playerId);
      if (idle) {
        // Same registry loop the sim runs — the idle prediction can't drift
        // from stepHero's recharge/cooldown behavior.
        for (const id of ABILITY_ORDER) {
          ABILITIES[id].tick(idle, dt);
        }
        for (const itemId in idle.itemCooldowns) {
          if (idle.itemCooldowns[itemId] > 0) {
            idle.itemCooldowns[itemId] = Math.max(0, idle.itemCooldowns[itemId] - dt);
          }
        }
      }
      return;
    }

    const player = this._state.heroes.find((h) => h.id === this._playerId);
    if (!player || !player.alive) return;

    // The scratch state carries the live player object and stepMatch writes
    // the predicted pos/path/facing/ability state straight onto it. The rest
    // is reset every call so discarded side effects of a predicted cast
    // (projectiles, blasts, income accumulation) never leak across ticks.
    const temp = this._predictScratch;
    temp.tick = 0;
    temp.heroes.length = 0;
    temp.heroes.push(player);
    temp.projectiles.length = 0;
    temp.wards.length = 0;
    temp.blasts.length = 0;
    temp.firstBlood = true;
    temp.incomeAccumulator = 0;
    temp.nextProjectileId = 1;
    temp.nextWardId = 1;
    temp.nextBlastId = 1;

    const tempInputs = this._predictInputs;
    tempInputs.length = 0;
    for (const input of inputs) {
      if (input.heroId === this._playerId) tempInputs.push(input);
    }

    const predEvents = stepMatch(temp, tempInputs, dt, this._world);
    // Our own arrows loose when their predicted cast point elapses; spawn the
    // visible cosmetic from that fire event so the shot is delayed by the
    // wind-up and never appears for a draw the player cancelled.
    for (const ev of predEvents) {
      if (ev.type === 'fire' && ev.heroId === this._playerId && ev.projectile.kind !== 'scout') {
        this._spawnCosmeticFromFire(ev.projectile);
      }
    }
  }

  /** Reused by _predictMovement so prediction allocates nothing per tick. */
  private _predictScratch = createMatchState();
  private _predictInputs: HeroInput[] = [];

  /**
   * Interpolate remote hero positions between the pair of snapshots that
   * straddles `renderTime`, so tick-rate snapshots render as smooth motion
   * at any display refresh rate.
   */
  private _interpolateHeroes(renderTime: number): void {
    const pair = findStraddlingPair(this._snapshots, renderTime, this._tickDt);
    if (!pair) return;
    for (const hero of this._state.heroes) {
      if (hero.id === this._playerId) continue;
      const prevH = pair.prev.heroes.find((h) => h.id === hero.id);
      const nextH = pair.next.heroes.find((h) => h.id === hero.id);
      if (!prevH || !nextH) continue;
      lerpHero(hero, prevH, nextH, pair.t);
    }
  }

  /**
   * Interpolate creep positions between the snapshot pair straddling
   * `renderTime` — the same timeline as remote heroes, with no local-player
   * skip (creeps are always server-driven). A creep absent from either
   * snapshot is idle or dead and simply holds its last state.
   */
  private _interpolateCreeps(renderTime: number): void {
    const pair = findStraddlingPair(this._snapshots, renderTime, this._tickDt);
    if (!pair) return;
    for (const creep of this._state.creeps) {
      const prevC = pair.prev.creeps?.find((c) => c.id === creep.id);
      const nextC = pair.next.creeps?.find((c) => c.id === creep.id);
      if (!prevC || !nextC) continue;
      lerpCreep(creep, prevC, nextC, pair.t);
    }
  }

  /** Enter a projectile's spawn state into the remote-projectile registry. */
  private _registerRemoteProjectile(p: ProjectileState, spawnTime: number): void {
    this._remoteProjectiles.set(p.id, {
      ownerId: p.ownerId,
      ownerKind: p.ownerKind,
      kind: p.kind,
      team: p.team,
      // Walk back to the spawn point (`traveled` is 0 for fire events, >0 for
      // welcome-snapshot arrows already in flight).
      spawnPos: { x: p.pos.x - p.dir.x * p.traveled, z: p.pos.z - p.dir.z * p.traveled },
      dir: { x: p.dir.x, z: p.dir.z },
      speed: p.speed,
      maxRange: p.maxRange,
      damage: p.damage,
      spawnTime,
      deathTime: null,
    });
  }

  /** Register fire events (spawns) and hit events (deaths) from a snapshot. */
  private _trackProjectileEvents(snap: SnapshotMessage): void {
    if (!snap.events) return;
    for (const ev of snap.events) {
      if (ev.type === 'fire') {
        this._registerRemoteProjectile(ev.projectile, ev.tick * this._tickDt);
      } else if (ev.type === 'hit') {
        const rp = this._remoteProjectiles.get(ev.projectileId);
        // The projectile is gone server-side by this snapshot's tick; let the
        // render timeline carry it to (approximately) the impact before hiding.
        if (rp) rp.deathTime = snap.tick * this._tickDt;
      }
    }
  }

  /**
   * Rebuild `_state.projectiles` for this frame by advancing every registered
   * remote projectile to `renderTime`: a straight line at constant speed from
   * its spawn state, so per-frame motion is exact without the server ever
   * re-sending positions. Deaths: hero hits come from the server's `hit`
   * event (`deathTime`); obstacle and max-range deaths are deterministic and
   * computed locally, mirroring the sim.
   */
  private _renderProjectiles(renderTime: number): void {
    const out: ProjectileState[] = [];
    for (const [id, rp] of this._remoteProjectiles) {
      if (rp.deathTime !== null && renderTime >= rp.deathTime) {
        this._retireRemoteProjectile(id);
        continue;
      }
      const traveled = rp.speed * (renderTime - rp.spawnTime);
      if (traveled < 0) continue; // fired ahead of the render timeline
      if (traveled >= rp.maxRange) {
        this._retireRemoteProjectile(id);
        continue;
      }
      const pos = { x: rp.spawnPos.x + rp.dir.x * traveled, z: rp.spawnPos.z + rp.dir.z * traveled };
      // Scouts fly over obstacles — only arrows die on them.
      if (rp.kind !== 'scout' && rp.deathTime === null && sphereHitsObstacle(this._world, pos, ARROW.collisionRadius)) {
        this._retireRemoteProjectile(id);
        continue;
      }
      if (this._ownArrowIds.has(id)) continue; // own arrows render locally
      out.push({
        id,
        ownerId: rp.ownerId,
        ownerKind: rp.ownerKind,
        kind: rp.kind,
        team: rp.team,
        pos,
        dir: { x: rp.dir.x, z: rp.dir.z },
        speed: rp.speed,
        maxRange: rp.maxRange,
        traveled,
        damage: rp.damage,
      });
    }
    this._state.projectiles = out;
  }

  private _retireRemoteProjectile(id: string): void {
    this._remoteProjectiles.delete(id);
    this._ownArrowIds.delete(id);
  }

  /** Track our fire/hit events to link cosmetic arrows to server projectiles. */
  private _handleOwnArrowEvent(ev: SimEvent): void {
    if (ev.type === 'fire' && ev.heroId === this._playerId) {
      // Scout (E) projectiles never spawn a cosmetic copy — they must not
      // claim a pending Q arrow's slot.
      if (ev.projectile.kind === 'scout') return;
      const cosmetic = this._cosmeticProjectiles.find((c) => c.serverId === null);
      // Only hide the server projectile when a local arrow actually claimed
      // it — if the cosmetic guard suppressed the spawn, the simulated remote
      // projectile is the only visible copy and must stay rendered.
      if (cosmetic) {
        cosmetic.serverId = ev.projectile.id;
        this._ownArrowIds.add(ev.projectile.id);
      }
      return;
    }
    // Our arrow hit someone: retire the local arrow claimed by that server
    // projectile. (Obstacle and max-range deaths are computed locally and
    // need no event.)
    if (ev.type === 'hit' && ev.sourceId === this._playerId) {
      const cosmetic = this._cosmeticProjectiles.find((c) => c.serverId === ev.projectileId);
      if (cosmetic) this._retireCosmetic(cosmetic);
    }
  }

  private _retireCosmetic(c: (typeof this._cosmeticProjectiles)[number]): void {
    const i = this._cosmeticProjectiles.indexOf(c);
    if (i >= 0) this._cosmeticProjectiles.splice(i, 1);
    c.view.hide();
    this._projectilePool.push(c.view);
  }

  // ── Cosmetic projectiles ────────────────────────────────────────────

  /**
   * Spawn the local cosmetic arrow from our own predicted `fire` event — i.e.
   * once the cast point has elapsed, mirroring exactly when and where the sim
   * loosed the shot (pos already carries the spawn offset, dir/speed/range are
   * the sim's). No cast guard is needed: prediction only emits this for a shot
   * that actually fired.
   */
  private _spawnCosmeticFromFire(proj: ProjectileState): void {
    const player = this._playerState;
    if (!player) return;

    const pv = this._projectilePool.pop();
    if (!pv) return;
    const hasIceBow = player.inventory.includes('ice_bow');
    pv.setStyle(hasIceBow ? 'ice' : 'arrow'); // pooled views may last have flown as other styles

    const spawnPos = { x: proj.pos.x, z: proj.pos.z };
    pv.mesh.position.set(
      spawnPos.x,
      this._heightAt(spawnPos.x, spawnPos.z) + ARROW.flyHeight,
      spawnPos.z,
    );
    pv.mesh.rotation.y = Math.atan2(proj.dir.x, proj.dir.z);
    pv.mesh.visible = true;

    this._cosmeticProjectiles.push({
      view: pv,
      pos: spawnPos,
      dir: { x: proj.dir.x, z: proj.dir.z },
      speed: proj.speed,
      traveled: 0,
      maxRange: proj.maxRange,
      serverId: null,
    });
  }

  /**
   * Advance our local arrows and retire those that expire or hit an obstacle
   * (mirroring stepProjectiles, so the local flight ends where the server's
   * does). Hits on heroes are retired by the server's hit event instead —
   * see `_handleOwnArrowEvent`.
   */
  private _tickCosmeticProjectiles(dt: number): void {
    for (let i = this._cosmeticProjectiles.length - 1; i >= 0; i--) {
      const c = this._cosmeticProjectiles[i];
      if (advanceProjectile(c, dt, this._world, ARROW.collisionRadius) !== 'flying') {
        this._retireCosmetic(c);
        continue;
      }
      c.view.mesh.position.set(
        c.pos.x,
        this._heightAt(c.pos.x, c.pos.z) + ARROW.flyHeight,
        c.pos.z,
      );
    }
  }

  private _shopRangePrev: boolean | null = null;
  private _isPlayerNearShop(shopIndex?: number): boolean {
    const idx = shopIndex ?? this._shopWindow.shopIndex;
    if (idx < 0 || idx >= this._world.shops.length) return false;
    const s = this._world.shops[idx].pos;
    const p = this._playerState?.pos;
    if (!s || !p) {
      console.log('[shop] missing shop or player pos');
      return false;
    }
    const dist = Math.hypot(s.x - p.x, s.z - p.z);
    const result = dist <= this._world.shops[idx].buyRadius;
    if (result !== this._shopRangePrev) {
      console.log(`[shop] inRange changed to ${result}, shop=${idx} dist=${dist.toFixed(0)} (buyRadius=${this._world.shops[idx].buyRadius}), player=(${p.x.toFixed(0)},${p.z.toFixed(0)}), shopPos=(${s.x.toFixed(0)},${s.z.toFixed(0)})`);
      this._shopRangePrev = result;
    }
    return result;
  }

  /** Find the nearest shop to the player, or null if no shops exist. */
  private _getNearestShop(): { index: number; pos: Vec2 } | null {
    if (this._world.shops.length === 0) return null;
    const p = this._playerState?.pos;
    if (!p) return null;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this._world.shops.length; i++) {
      const d = Math.hypot(this._world.shops[i].pos.x - p.x, this._world.shops[i].pos.z - p.z);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return { index: bestIdx, pos: this._world.shops[bestIdx].pos };
  }

  private _heightAt(x: number, z: number): number {
    return this._terrain.heightAt(x, z);
  }

  private _smoothHeightAt(x: number, z: number): number {
    return this._terrain.smoothHeightAt(x, z);
  }

  private _onResize(): void {
    this._renderer.resize(window.innerWidth, window.innerHeight);
    this._camera.resize(window.innerWidth, window.innerHeight);
  }

  // ── Vision adapters ─────────────────────────────────────────────────

  private _createHeroVisionSource(state: HeroState, view: HeroView): VisionSource {
    return {
      get position() { return view.mesh.position; },
      get sightRadius() { return HERO.sightRadius; },
      get active() { return state.alive; },
      get team() { return state.team; },
    };
  }

  private _createWardVisionSource(state: { life: number; team: number }, view: WardView): VisionSource {
    return {
      get position() { return view.mesh.position; },
      get sightRadius() { return WARD.sightRadius; },
      get active() { return state.life > 0; },
      get team() { return state.team; },
    };
  }

  // ── Update loop ─────────────────────────────────────────────────────

  private update(delta: number): void {
    const dt = Math.min(delta, 0.1);

    if (this._networkMode) {
      this._updateNetwork(dt);
    } else {
      this._updateOffline(dt);
    }
  }

  private _updateOffline(dt: number): void {
    // ── Targeting ──
    this._updateTargeting();

    // ── Camera ──
    this._updateCamera(dt);

    // ── Drain input queue ──
    const inputs: HeroInput[] = [];
    for (const cmd of this._pendingCommands) {
      inputs.push({ heroId: this._playerId, cmd });
    }
    this._pendingCommands = [];

    // ── AI opponent: append the enemy hero's commands for this tick ──
    if (this._ai) inputs.push(...this._ai.think(this._state, this._world, dt));

    // ── Step the simulation ──
    const events = stepMatch(this._state, inputs, dt, this._world);

    // ── Process events ──
    for (const ev of events) this._handleEvent(ev, dt);

    // ── Common tail ──
    this._updateCommon(dt, events, []);
  }

  private _updateNetwork(dt: number): void {
    // ── Targeting ──
    this._updateTargeting();

    // ── Camera ──
    this._updateCamera(dt);
    const renderTime = this._clock.advance(dt);

    // ── Drain pending commands for prediction & cosmetics ──
    // (Commands already went on the wire in `_enqueueCommand`.)
    const localInputs: HeroInput[] = [];
    for (const cmd of this._pendingCommands) {
      localInputs.push({ heroId: this._playerId, cmd });
    }
    this._pendingCommands = [];
    // Note: the cosmetic arrow is no longer spawned here on cast — it now
    // spawns from the predicted `fire` event in `_predictMovement`, so it is
    // delayed by the arrow's cast point and suppressed for a cancelled draw.

    // ── Drain snapshots into buffer, sync the render clock ──
    const snaps = this._network?.drainSnapshots() ?? [];
    for (const snap of snaps) {
      this._snapshots.push(snap);
      this._reconcileFromSnapshot(snap);
      this._trackProjectileEvents(snap);
      this._clock.feedSample(snap.tick * this._tickDt);
    }

    // ── Apply server state for remote entities ──
    if (snaps.length > 0) {
      this._applyServerState(snaps[snaps.length - 1]);
    }

    // ── Cold hero fields (low rate + event-triggered flushes) ──
    const meta = this._network?.takeMeta();
    if (meta) {
      for (const m of meta) {
        const hero = this._state.heroes.find((h) => h.id === m.id);
        if (hero) this._applyMetaFields(hero, m);
      }
    }

    // Prune snapshots that fell behind the straddling pair.
    if (renderTime !== null) pruneSnapshots(this._snapshots, renderTime, this._tickDt);

    // ── Drain events (own-arrow bookkeeping first: it may retire arrows) ──
    const frameEvents = this._network?.drainEvents() ?? [];
    for (const ev of frameEvents) {
      this._handleOwnArrowEvent(ev);
      this._handleEvent(ev, dt);
    }

    // ── Interpolate remote heroes & creeps ──
    if (renderTime !== null) {
      this._interpolateHeroes(renderTime);
      this._interpolateCreeps(renderTime);
    }

    // ── Local prediction: move own hero with pending inputs ──
    // (Snap-based reconciliation already happened per-snapshot above.)
    this._predictMovement(localInputs, dt);

    // ── Own arrows fly locally; remote projectiles simulate on the render timeline ──
    this._tickCosmeticProjectiles(dt);
    if (renderTime !== null) this._renderProjectiles(renderTime);

    // ── Common tail ──
    this._updateCommon(dt, frameEvents, snaps.map((s) => s.tick));
  }

  // ── Debug trace & driver API (?debug=1, used by scripts/drive.ts) ────

  /** Record one trace line: sim positions and view-mesh positions side by side. */
  private _recordTraceFrame(snapTicks: number[], events: SimEvent[]): void {
    if (!this._trace) return;
    const r = (v: number) => +v.toFixed(2);
    this._trace.record({
      tick: this._state.tick,
      snapTicks: snapTicks.length > 0 ? snapTicks : undefined,
      heroes: this._state.heroes.map((h) => {
        const view = this._heroViews.get(h.id);
        return {
          id: h.id, x: r(h.pos.x), z: r(h.pos.z),
          vx: r(view?.mesh.position.x ?? NaN), vz: r(view?.mesh.position.z ?? NaN),
          hp: h.hp, alive: h.alive,
        };
      }),
      projectiles: this._state.projectiles.map((p) => {
        const view = this._projectileViews.get(p.id);
        return {
          id: p.id, x: r(p.pos.x), z: r(p.pos.z),
          vx: r(view?.mesh.position.x ?? NaN), vz: r(view?.mesh.position.z ?? NaN),
          traveled: r(p.traveled), visible: view?.mesh.visible ?? false,
        };
      }),
      cosmetic: this._cosmeticProjectiles.map((c) => ({
        id: c.view.projectileId,
        x: r(c.pos.x), z: r(c.pos.z),
        vx: r(c.view.mesh.position.x), vz: r(c.view.mesh.position.z),
      })),
      events: events.length > 0 ? events : undefined,
    });
  }

  /** True once init() has finished (drivers poll this before issuing input). */
  get debugReady(): boolean {
    return this._debugReady;
  }

  /** Inject a command exactly as player input would (driver entry point). */
  debugIssue(cmd: Command): void {
    this._enqueueCommand(cmd);
  }

  /** JSON-safe snapshot of the current client state for drivers. */
  debugState(): { tick: number; playerId: string; shop: Vec2; heroes: { id: string; x: number; z: number; hp: number; alive: boolean; abilityLevel: number; abilityCooldown: number }[] } {
    return {
      tick: this._state.tick,
      playerId: this._playerId,
      shop: { ...this._world.shops[0].pos },
      heroes: this._state.heroes.map((h) => ({
        id: h.id, x: h.pos.x, z: h.pos.z, hp: h.hp, alive: h.alive,
        abilityLevel: h.abilities.arrow.level, abilityCooldown: h.abilities.arrow.cooldown,
      })),
    };
  }

  /** The recorded trace as JSONL (empty string when tracing is off). */
  debugDumpTrace(): string {
    return this._trace ? this._trace.dump() : '';
  }

  /** Advance the targeting state machine (walk-then-place progress). */
  private _updateTargeting(): void {
    if (!this._targeting.isActive) return;
    const p = this._playerState;
    if (!p || !p.alive) {
      this._targeting.cancel();
      return;
    }
    this._targeting.update(
      p.pos.x, p.pos.z,
      this._heightAt(p.pos.x, p.pos.z),
    );
  }

  /** If the local hero is within a fountain's heal radius, trigger a sparkle effect. */
  private _updateHealSparkle(_dt: number): void {
    const hero = this._playerState;
    if (!hero || !hero.alive || hero.hp >= heroMaxHp(hero.level, hero.bonusHp)) return;
    const view = this._playerView;
    if (!view) return;
    for (const fountain of this._world.fountains) {
      const dx = hero.pos.x - fountain.pos.x;
      const dz = hero.pos.z - fountain.pos.z;
      if (dx * dx + dz * dz <= fountain.healRadius * fountain.healRadius) {
        view.flashHeal();
        return;
      }
    }
  }

  /** Activate ground-targeting for an item with point-targeted on-use (wards, blink). */
  private _activateItemTargeting(def: import('../sim/shopItems').ShopItemDef, slot: number): void {
    const p = this._playerState;
    if (!p || !p.alive) return;
    const use = def.use!;
    if (use.cooldown && (p.itemCooldowns[def.id] ?? 0) > 0) return;
    if (use.canUse && !use.canUse(p)) return;
    this._targeting.activate(
      {
        range: use.range ?? 0,
        indicatorColor: def.id === 'blink_dagger' ? 0x9966ff : 0x66ff88,
        validateTarget: walkableValidator(this._navGrid, this._world.obstacles),
        onTarget: (x, z) => {
          this._enqueueCommand({ type: 'useItem', slot, x, z });
          // For wards, anchor the hero after placing so the ward drops at
          // the clicked spot (harmless if already stationary).
          if (def.id === 'sentry_wards') {
            this._enqueueCommand({ type: 'moveTo', x: p.pos.x, z: p.pos.z });
          }
        },
        onCancel: () => {},
        onMove: (x, z) => {
          this._enqueueCommand({ type: 'moveTo', x, z });
          this._moveIndicators.spawn(
            new THREE.Vector3(x, this._heightAt(x, z), z),
          );
        },
      },
      def.id,
      p.pos.x, p.pos.z,
      this._heightAt(p.pos.x, p.pos.z),
      this._scene,
    );
  }

  /** Activate ground-targeting for a point-targeted ability (e.g. R blast). */
  private _activateAbilityTargeting(def: AbilityDef): void {
    const p = this._playerState;
    if (!p || !canCast(def, p)) return;
    this._targeting.activate(
      {
        range: def.castRange ?? 0,
        indicatorColor: 0xff5522,
        onTarget: (x, z) => {
          this._enqueueCommand({ type: 'cast', ability: def.id, x, z });
        },
        onCancel: () => {},
        onMove: (x, z) => {
          this._enqueueCommand({ type: 'moveTo', x, z });
          this._moveIndicators.spawn(
            new THREE.Vector3(x, this._heightAt(x, z), z),
          );
        },
      },
      def.id,
      p.pos.x, p.pos.z,
      this._heightAt(p.pos.x, p.pos.z),
      this._scene,
    );
  }

  private _updateCamera(dt: number): void {
    const pan = this._input.edgePan;
    if (pan.length() > 0) {
      const speed = 1200 * dt;
      this._camera.panScreen(pan.x * speed, pan.z * speed);
    }
    const focus = this._camera.focus;
    this._camera.setFocusY(this._smoothHeightAt(focus.x, focus.z));
  }

  /** Tail shared by offline and network update paths (fog, views, misc). */
  private _updateCommon(dt: number, events: SimEvent[], snapTicks: number[]): void {
    this._updateDeathOverlay();
    this._updateHealSparkle(dt);
    this._syncAllViews(dt);
    this._fog.update(dt);
    this._fogLayer.update(dt);
    this._applyFogVisibility();
    this._floatingText.update(dt, this._camera.camera);
    this._killFeed.update(dt);
    this._water.update(dt);
    this._moveIndicators.update(dt);
    this._recordTraceFrame(snapTicks, events);
  }

  // ── View sync ──────────────────────────────────────────────────────

  private _syncAllViews(dt: number): void {
    // Sync hero views
    for (const hero of this._state.heroes) {
      const view = this._heroViews.get(hero.id);
      if (view) view.sync(hero, dt);
      // Blink Dagger portal visuals
      const prev = this._prevBlinkTimer.get(hero.id) ?? 0;
      const y = this._heightAt(hero.pos.x, hero.pos.z) + 2;
      if (hero.blinkCastTimer > 0) {
        this._portalEffects.showSourceRing(hero.id, hero.pos.x, y, hero.pos.z, hero.blinkCastTimer);
      } else {
        this._portalEffects.showSourceRing(hero.id, hero.pos.x, y, hero.pos.z, 0);
        // Cast just completed — spawn destination burst
        if (prev > 0 && hero.alive) {
          this._portalEffects.spawnBurst(hero.pos.x, y, hero.pos.z);
        }
      }
      this._prevBlinkTimer.set(hero.id, hero.blinkCastTimer);
    }
    // Sync projectile views
    this._syncProjectileViews();
    this._updateScoutTrail(dt);
    // Sync ward views
    this._syncWardViews();
    // Sync blast zone views + transient explosion effects
    this._syncBlastViews();
    this._explosions.update(dt);
    this._impacts.update(dt);
    this._portalEffects.update(dt);
    this._levelUpEffect.update(dt);
    this._deathEffect.update(dt);
    // Sync creep views
    this._syncCreepViews(dt);
    // Sync rune views
    this._syncRuneViews(dt);
    // Sync fountain views
    this._syncFountainViews(dt);
  }

  // ── Blast zone view sync ───────────────────────────────────────────────────

  private _syncBlastViews(): void {
    syncKeyedViews(
      this._blastViews,
      new Set(this._state.blasts.map((b) => b.id)),
      (id) => {
        const bv = new BlastView(id);
        this._scene.add(bv.mesh);
        return bv;
      },
      (id, bv) => {
        const b = this._state.blasts.find((sb) => sb.id === id)!;
        bv.sync(b, this._heightAt.bind(this));
      },
      (_id, bv) => bv.dispose(),
    );
  }

  // ── Event handling ──────────────────────────────────────────────────

  /**
   * Which elemental arrow a hero shot fired, from the shooter's bow, or null
   * for a plain arrow / a non-hero source (creep melee & fireballs). Drives the
   * frost/flame impact burst on the struck enemy. `fire_bow` is wired ahead of
   * the item itself so the fire look lights up the moment that bow ships.
   */
  private _arrowElement(sourceId: string): ImpactElement | null {
    const src = this._state.heroes.find((h) => h.id === sourceId);
    if (!src) return null;
    if (src.inventory.includes('fire_bow')) return 'fire';
    if (src.inventory.includes('ice_bow')) return 'ice';
    return null;
  }

  /** Spawn an elemental impact burst on a struck enemy at its view position. */
  private _spawnArrowImpact(sourceId: string, targetPos: THREE.Vector3): void {
    const el = this._arrowElement(sourceId);
    if (el) this._impacts.spawn(targetPos.x, targetPos.y + 26, targetPos.z, el);
  }

  private _handleEvent(ev: SimEvent, _dt: number): void {
    switch (ev.type) {
      case 'hit': {
        // Floating damage number
        const targetView = this._heroViews.get(ev.targetId);
        if (targetView) {
          this._floatingText.spawn(targetView.mesh.position, ev.damage, undefined, ev.crit);
        }
        // Hit flash on the target's view
        targetView?.flashHit();
        // Elemental burst if the shooter carried an ice/fire bow.
        if (targetView) this._spawnArrowImpact(ev.sourceId, targetView.mesh.position);
        // A creep melee swing lands as a 'hit' from a creep source — play its
        // attack lunge (heroes never share ids with creeps).
        this._creepViews.get(ev.sourceId)?.playAttack();
        break;
      }
      case 'fire': {
        // Muzzle flash + bow-release gesture on the shooter's view
        const shooterView = this._heroViews.get(ev.heroId);
        shooterView?.flashFire();
        shooterView?.playShoot();
        // Creep fireballs carry the creep id as the owner — play its attack.
        this._creepViews.get(ev.heroId)?.playAttack();
        break;
      }
      case 'blastExplode': {
        // Detonation visual for everyone. Damage numbers arrive as separate
        // 'hit' / 'creepHit' events from the same tick.
        const y = this._heightAt(ev.x, ev.z);
        this._explosions.spawn(ev.x, y + 10, ev.z, BLAST.radius);
        // In network mode the zone also vanishes from the next snapshot —
        // dropping it now avoids a one-frame lingering circle.
        this._state.blasts = this._state.blasts.filter((b) => b.id !== ev.blastId);
        break;
      }
      case 'creepHit': {
        const creepView = this._creepViews.get(ev.creepId);
        if (creepView) {
          this._floatingText.spawn(creepView.mesh.position, ev.damage, undefined, ev.crit);
          creepView.flashHit();
          // Elemental burst if the shooter carried an ice/fire bow.
          this._spawnArrowImpact(ev.sourceId, creepView.mesh.position);
        }
        break;
      }
      case 'creepKill': {
        // Snapshots omit dead creeps rather than flagging them, so in
        // network mode the death itself is event-carried. (Offline the sim
        // already set this — idempotent.)
        const creep = this._state.creeps.find((c) => c.id === ev.creepId);
        if (creep) creep.alive = false;
        // Bounty text for the local killer: gold + XP above the corpse.
        if (ev.killerId === this._playerId) {
          const y = this._heightAt(ev.x, ev.z);
          this._floatingText.spawnGold(new THREE.Vector3(ev.x, y + 80, ev.z), ev.gold);
          this._floatingText.spawn(new THREE.Vector3(ev.x, y + 50, ev.z), ev.xp, '#88ff88');
        }
        break;
      }
      case 'creepRespawn': {
        // Event-carried respawn: the camp climbed a tier, so this slot may
        // return as a stronger monster type. Update type first so max-hp and
        // the view's model swap (in CreepView.sync) use the new type.
        const creep = this._state.creeps.find((c) => c.id === ev.creepId);
        if (creep) {
          creep.type = ev.creepType;
          creep.alive = true;
          creep.level = ev.level;
          creep.hp = creepMaxHp(creep.type, ev.level);
          creep.pos = { x: creep.spawnPos.x, z: creep.spawnPos.z };
        }
        break;
      }
      case 'kill': {
        // ── Kill feed announcements ──
        const victimName = this._names.get(ev.victimId) ?? ev.victimId;
        const victim = this._state.heroes.find((h) => h.id === ev.victimId);
        const vTeam = victim?.team ?? 0;
        const isCreepKill = !this._state.heroes.some((h) => h.id === ev.sourceId);

        if (isCreepKill) {
          if (ev.firstBlood) {
            this._killFeed.announce('First Blood!', '#ff4444');
          }
          this._killFeed.creepKill(victimName, vTeam);
        } else {
          const killerName = this._names.get(ev.sourceId) ?? ev.sourceId;
          const killer = this._state.heroes.find((h) => h.id === ev.sourceId);
          const kTeam = killer?.team ?? 0;

          if (ev.firstBlood) {
            this._killFeed.announce('First Blood!', '#ff4444');
          }
          this._killFeed.kill(killerName, kTeam, victimName, vTeam);
          if (ev.streak) {
            this._killFeed.streak(killerName, kTeam, ev.streak);
          }
          if (ev.multiKill) {
            this._killFeed.multiKill(killerName, kTeam, ev.multiKill);
          }
        }

        // ── Sound announcements (WC3-style global callouts) ──
        if (ev.firstBlood) {
          this._sound.play('firstBlood');
        }
        if (ev.streak) {
          const snd = STREAK_SOUNDS[ev.streak];
          if (snd) this._sound.play(snd);
        }
        if (ev.multiKill) {
          const snd = MULTI_KILL_SOUNDS[ev.multiKill];
          if (snd) this._sound.play(snd);
        }

        // Death burst: red particles + ring at the victim's position.
        const victimView = this._heroViews.get(ev.victimId);
        if (victimView) {
          const vpos = victimView.mesh.position;
          this._deathEffect.spawn(vpos.x, vpos.y + 8, vpos.z);
        }
        // Gold bounty indicator for the local killer, LoL-style coin + amount.
        if (ev.sourceId === this._playerId && ev.gold) {
          if (victimView) {
            const pos = victimView.mesh.position.clone();
            pos.y += 60;
            this._floatingText.spawnGold(pos, ev.gold);
          }
        }
        break;
      }
      case 'runeSpawn': {
        // Event-carried respawn with the freshly rolled type. (Offline the
        // sim already set this — idempotent.)
        const rune = this._state.runes.find((r) => r.id === ev.runeId);
        if (rune) {
          rune.active = true;
          rune.type = ev.runeType;
        }
        break;
      }
      case 'runePickup': {
        const rune = this._state.runes.find((r) => r.id === ev.runeId);
        if (rune) rune.active = false;
        // Pickup banner — for the local player always, otherwise only when
        // the pickup happened inside our vision.
        const mine = ev.heroId === this._playerId;
        if (mine || this._fog.isVisible(this._playerState.team, ev.x, ev.z)) {
          const def = RUNE_TYPES[ev.runeType];
          const y = this._heightAt(ev.x, ev.z);
          const color = `#${def.color.toString(16).padStart(6, '0')}`;
          this._floatingText.spawnText(new THREE.Vector3(ev.x, y + 80, ev.z), def.name.toUpperCase() + '!', color);
        }
        break;
      }
      case 'respawn':
        break;
      case 'levelUp': {
        // Golden swirl animation at the hero's position — WC3 tome-style.
        const heroView = this._heroViews.get(ev.heroId);
        if (heroView) {
          const pos = heroView.mesh.position;
          this._levelUpEffect.spawn(pos.x, pos.y + 10, pos.z);
        }
        // Float a "LEVEL UP!" banner above the hero.
        const heroState = this._state.heroes.find((h) => h.id === ev.heroId);
        if (heroState) {
          const y = this._heightAt(heroState.pos.x, heroState.pos.z);
          this._floatingText.spawnText(
            new THREE.Vector3(heroState.pos.x, y + 100, heroState.pos.z),
            `LEVEL ${ev.level}!`,
            '#ffd700',
          );
        }
        break;
      }
      case 'purchase': {
        // Tome purchase visual: float the stat gain above the hero.
        const def = SHOP_ITEMS_BY_ID[ev.itemId];
        if (def?.consumable) {
          const buyerView = this._heroViews.get(ev.heroId);
          if (buyerView) {
            const pos = buyerView.mesh.position.clone();
            pos.y += 60;
            const label = def.id === 'strength_tome' ? '+50 HP' : def.id === 'attack_tome' ? '+50 DMG' : '';
            if (label) this._floatingText.spawnText(pos, label, def.id === 'strength_tome' ? '#44cc44' : '#ff8844');
          }
          // Quick golden flash on the hero mesh.
          const buyer = this._state.heroes.find((h) => h.id === ev.heroId);
          if (buyer && buyerView) {
            buyerView.flashHeal(); // reuse green glow as a quick feedback flash
          }
        }
        break;
      }
    }
  }

  // ── Projectile view sync ────────────────────────────────────────────

  private _syncProjectileViews(): void {
    const activeIds = new Set(this._state.projectiles.map((p) => p.id));

    const getOrCreateView = (id: string): ProjectileView => {
      const pooled = this._projectilePool.pop();
      if (pooled) return pooled;
      const fresh = new ProjectileView(id);
      this._scene.add(fresh.mesh);
      return fresh;
    };

    syncKeyedViews(
      this._projectileViews,
      activeIds,
      (id) => {
        const p = this._state.projectiles.find((sp) => sp.id === id)!;
        const pv = getOrCreateView(id);
        // Scout (E) projectiles grant fog vision to their team while flying.
        if (p.kind === 'scout') {
          const team = p.team;
          const radius = p.sightRadius ?? SCOUT.sightRadiusByLevel[1];
          const vSrc: VisionSource = {
            get position() { return pv.mesh.position; },
            get sightRadius() { return radius; },
            get active() { return true; },
            get team() { return team; },
          };
          this._scoutVisionAdapters.set(id, vSrc);
          this._fog.addSource(vSrc);
        }
        return pv;
      },
      (id, pv) => {
        const p = this._state.projectiles.find((sp) => sp.id === id)!;
        const isIce = p.ownerKind !== 'creep' && this._state.heroes.some(
          (h) => h.id === p.ownerId && h.inventory.includes('ice_bow'),
        );
        pv.sync(p, this._heightAt.bind(this), isIce);
        if (p.kind === 'scout') this._dropScoutBreadcrumbs(p);
      },
      (id, pv) => {
        const vSrc = this._scoutVisionAdapters.get(id);
        if (vSrc) {
          this._fog.removeSource(vSrc);
          this._scoutVisionAdapters.delete(id);
          const track = this._scoutTrailDrop.get(id);
          if (track) {
            this._spawnScoutBubble(track.lastX, track.lastZ, track.team, track.radius);
            this._scoutTrailDrop.delete(id);
          }
        }
        pv.hide();
        this._projectilePool.push(pv);
      },
    );
  }

  /**
   * Leave lingering vision bubbles behind a flying scout so the revealed
   * corridor stays lit for a few seconds instead of snapping shut.
   */
  private _dropScoutBreadcrumbs(p: ProjectileState): void {
    let track = this._scoutTrailDrop.get(p.id);
    const radius = p.sightRadius ?? SCOUT.sightRadiusByLevel[1];
    if (!track) {
      // First sighting: light the launch point too.
      track = { dropX: p.pos.x, dropZ: p.pos.z, lastX: p.pos.x, lastZ: p.pos.z, team: p.team, radius };
      this._scoutTrailDrop.set(p.id, track);
      this._spawnScoutBubble(p.pos.x, p.pos.z, p.team, radius);
      return;
    }
    track.lastX = p.pos.x;
    track.lastZ = p.pos.z;
    const dx = p.pos.x - track.dropX;
    const dz = p.pos.z - track.dropZ;
    if (dx * dx + dz * dz >= SCOUT.trailSpacing * SCOUT.trailSpacing) {
      track.dropX = p.pos.x;
      track.dropZ = p.pos.z;
      this._spawnScoutBubble(p.pos.x, p.pos.z, p.team, radius);
    }
  }

  /** A stationary, self-expiring fog bubble (scout trail segment). */
  private _spawnScoutBubble(x: number, z: number, team: number, radius: number): void {
    const src: VisionSource = {
      position: new THREE.Vector3(x, 0, z),
      sightRadius: radius,
      active: true,
      team,
    };
    this._scoutTrail.push({ src, ttl: SCOUT.trailDuration });
    this._fog.addSource(src);
  }

  /** Expire scout trail bubbles. */
  private _updateScoutTrail(dt: number): void {
    for (let i = this._scoutTrail.length - 1; i >= 0; i--) {
      const b = this._scoutTrail[i];
      b.ttl -= dt;
      if (b.ttl <= 0) {
        this._fog.removeSource(b.src);
        this._scoutTrail.splice(i, 1);
      }
    }
  }

  // ── Ward view sync ──────────────────────────────────────────────────

  private _syncWardViews(): void {
    syncKeyedViews(
      this._wardViews,
      new Set(this._state.wards.map((w) => w.id)),
      (id) => {
        const w = this._state.wards.find((sw) => sw.id === id)!;
        const wv = new WardView(id);
        this._scene.add(wv.mesh);
        const vSrc = this._createWardVisionSource(w, wv);
        this._wardVisionAdapters.set(id, vSrc);
        this._fog.addSource(vSrc);
        return wv;
      },
      (id, wv) => {
        const w = this._state.wards.find((sw) => sw.id === id)!;
        wv.sync(w, this._heightAt.bind(this));
      },
      (id, wv) => {
        const vSrc = this._wardVisionAdapters.get(id);
        if (vSrc) {
          this._fog.removeSource(vSrc);
          this._wardVisionAdapters.delete(id);
        }
        wv.dispose();
      },
    );
  }

  // ── Creep view sync ─────────────────────────────────────────────────

  private _syncCreepViews(dt: number): void {
    for (const c of this._state.creeps) {
      let cv = this._creepViews.get(c.id);
      if (!cv) {
        // Don't build a view (which loads a GLB model) for a reserved pool slot
        // that has never been alive — it may activate later as a different
        // monster type, or never. Create lazily on first appearance.
        if (!c.alive) continue;
        cv = new CreepView(c.id, c.type, this._heightAt.bind(this));
        this._scene.add(cv.mesh);
        this._creepViews.set(c.id, cv);
      }
      cv.sync(c, dt);
    }
  }

  // ── Rune view sync ───────────────────────────────────────────────────

  private _syncRuneViews(dt: number): void {
    syncStableViews(
      this._runeViews,
      this._state.runes,
      (r) => r.id,
      (r) => {
        const rv = new RuneView(r.id);
        this._scene.add(rv.mesh);
        return rv;
      },
      (r, rv) => rv.sync(r, dt, this._heightAt.bind(this)),
    );
  }

  // ── Fountain view sync ──────────────────────────────────────────────

  private _syncFountainViews(dt: number): void {
    for (let i = 0; i < this._world.fountains.length; i++) {
      const fountain = this._world.fountains[i];
      let fv = this._fountainViews.get(i);
      if (!fv) {
        fv = new FountainView();
        this._scene.add(fv.mesh);
        this._fountainViews.set(i, fv);
        this._fogLayer.applyTo(fv.mesh);
      }
      fv.sync(fountain.pos, dt, this._heightAt.bind(this));
    }
  }

  // ── Death overlay ─────────────────────────────────────────────────

  /** Create the full-screen death overlay (hidden initial). */
  private _createDeathOverlay(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 500;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.35);
      backdrop-filter: grayscale(1) blur(0px);
      -webkit-backdrop-filter: grayscale(1) blur(0px);
      transition: opacity 0.4s;
    `;

    // Respawn label
    const label = document.createElement('div');
    label.textContent = 'Respawn in';
    label.style.cssText = `
      font-family: sans-serif;
      font-size: 18px;
      color: rgba(255,255,255,0.6);
      text-shadow: 0 2px 8px rgba(0,0,0,0.8);
      margin-bottom: 4px;
    `;
    overlay.appendChild(label);

    // Countdown number
    const countdown = document.createElement('span');
    countdown.style.cssText = `
      font-family: monospace;
      font-size: 64px;
      font-weight: bold;
      color: #ff4444;
      text-shadow: 0 4px 16px rgba(0,0,0,0.9);
    `;
    countdown.textContent = '0.0';
    this._deathCountdown = countdown;
    overlay.appendChild(countdown);

    document.body.appendChild(overlay);
    this._deathOverlay = overlay;
  }

  /** Tick the death overlay: show/hide, update countdown. */
  private _updateDeathOverlay(): void {
    if (!this._deathOverlay || !this._deathCountdown) return;
    const player = this._playerState;
    const nowDead = player && !player.alive;

    if (!this._wasPlayerAlive && nowDead) {
      // Still dead — update the countdown.
      const t = Math.max(0, player.respawnTimer);
      this._deathCountdown.textContent = t.toFixed(1);
      // Pulse red when < 1s
      if (t < 1) {
        this._deathCountdown.style.color = t % 0.3 < 0.15 ? '#ff4444' : '#ffffff';
      } else {
        this._deathCountdown.style.color = '#ff4444';
      }
    } else if (this._wasPlayerAlive && nowDead) {
      // Just died — show the overlay.
      this._deathOverlay.style.display = 'flex';
      this._deathOverlay.style.opacity = '1';
      this._deathCountdown.textContent = player.respawnTimer.toFixed(1);
      this._deathCountdown.style.color = '#ff4444';
    } else if (!this._wasPlayerAlive && !nowDead) {
      // Just respawned — hide the overlay and snap camera to hero.
      this._deathOverlay.style.display = 'none';
      this._deathOverlay.style.opacity = '0';
      this._camera.setTarget(new THREE.Vector3(
        player.pos.x,
        this._smoothHeightAt(player.pos.x, player.pos.z),
        player.pos.z,
      ));
    }

    this._wasPlayerAlive = !nowDead;
  }

  // ── Render ──────────────────────────────────────────────────────────

  private _render(_interpolation: number): void {
    this._renderer.render(this._scene, this._camera.camera);

    const ctx: HudContext = {
      state: this._state,
      world: this._world,
      playerState: this._playerState,
      fog: this._fog,
      minimap: this._minimap,
      spellBar: this._spellBar,
      statusBar: this._statusBar,
      itemBar: this._itemBar,
      kdDisplay: this._kdDisplay,
      shopWindow: this._shopWindow,
      shopOverlay: this._shopOverlay,
      scoreWindow: this._scoreWindow,
      camera: this._camera,
      isPlayerNearShop: this._isPlayerNearShop(),
      gameTime: this._state.tick / 60,
    };
    updateHud(ctx);
  }

  // ── Fog visibility ──────────────────────────────────────────────────

  private _applyFogVisibility(): void {
    const team = this._playerState.team;

    // Enemy heroes — hidden by fog, and outright while rune-invisible.
    for (const hero of this._state.heroes) {
      if (hero.team === team) continue;
      const view = this._heroViews.get(hero.id);
      if (view) {
        view.mesh.visible = hero.alive && hero.invisTimer <= 0 &&
          this._fog.isVisible(team, hero.pos.x, hero.pos.z);
      }
    }

    // Enemy projectiles — except scouts, which are always visible to everyone.
    for (const p of this._state.projectiles) {
      const pv = this._projectileViews.get(p.id);
      if (pv && p.team !== team) {
        pv.mesh.visible = p.kind === 'scout' || this._fog.isVisible(team, p.pos.x, p.pos.z);
      }
    }

    // Enemy wards
    for (const w of this._state.wards) {
      if (w.team === team) continue;
      const wv = this._wardViews.get(w.id);
      if (wv) {
        wv.mesh.visible = this._fog.isVisible(team, w.pos.x, w.pos.z);
      }
    }

    // Creeps are neutral: they reveal nothing themselves and are visible
    // only inside our own vision.
    for (const c of this._state.creeps) {
      const cv = this._creepViews.get(c.id);
      if (cv) {
        cv.mesh.visible = c.alive && this._fog.isVisible(team, c.pos.x, c.pos.z);
      }
    }

    // Runes: like DotA, only visible while the spot is inside our vision.
    for (const r of this._state.runes) {
      const rv = this._runeViews.get(r.id);
      if (rv && rv.mesh.visible) {
        rv.mesh.visible = this._fog.isVisible(team, r.pos.x, r.pos.z);
      }
    }

    // Fountains: visible when inside our vision.
    for (let i = 0; i < this._world.fountains.length; i++) {
      const fountain = this._world.fountains[i];
      const fv = this._fountainViews.get(i);
      if (fv) {
        fv.mesh.visible = this._fog.isVisible(team, fountain.pos.x, fountain.pos.z);
      }
    }
  }

  // ── Spawn helpers ───────────────────────────────────────────────────

  private _findRespawnPosition(): THREE.Vector3 {
    const arena = this._arena;
    const anchor = this._world.shops[0].pos;
    for (let attempt = 0; attempt < 500; attempt++) {
      const wx = arena.minX + Math.random() * arena.width;
      const wz = arena.minZ + Math.random() * arena.height;
      const { gx, gz } = this._navGrid.worldToGrid(wx, wz);
      if (this._navGrid.isWalkable(gx, gz) &&
          this._pathfinder.isReachable(wx, wz, anchor.x, anchor.z)) {
        const { wx: cx, wz: cz } = this._navGrid.gridToWorld(gx, gz);
        return new THREE.Vector3(cx, this._heightAt(cx, cz), cz);
      }
    }
    return new THREE.Vector3(
      arena.centerX,
      this._heightAt(arena.centerX, arena.centerZ),
      arena.centerZ,
    );
  }

  private _findWalkableNear(wx: number, wz: number): THREE.Vector3 {
    const { x, z } = findWalkableNearOnGrid(this._navGrid, wx, wz);
    return new THREE.Vector3(x, this._heightAt(x, z), z);
  }

  // ── Debug helpers ───────────────────────────────────────────────

  private _toggleFog(): void {
    this._fog.debugAllVisible = !this._fog.debugAllVisible;
    this._debugPanel?.setFogLabel(!this._fog.debugAllVisible);
    this._fog.recomputeNow();
    this._fogLayer.update(0);
  }

  private _debugLevelUp(): void {
    if (!this._playerState || !this._playerState.alive) return;
    if (this._playerState.level >= HERO.maxLevel) return;
    this._playerState.level++;
    this._playerState.skillPoints++;
  }

  private _debugAddGold(): void {
    if (this._playerState) {
      this._playerState.gold += 100;
    }
  }

  /** Reload the page on the other map (all world data derives from the map). */
  private _swapMap(): void {
    const url = new URL(window.location.href);
    url.searchParams.set('map', this._mapName === 'test' ? 'arena' : 'test');
    window.location.href = url.toString();
  }

  private _toggleAI(): void {
    if (this._networkMode) return;
    if (this._ai) {
      this._ai = null;
      this._debugPanel?.setAILabel(false);
    } else {
      this._ai = new AiController('dummy', AI_DIFFICULTY_PRESETS[this._aiDifficulty]);
      this._debugPanel?.setAILabel(true);
    }
  }

  /** Cycle the AI difficulty and, if the AI is active, rebuild it immediately. */
  private _cycleDifficulty(): void {
    if (this._networkMode) return;
    const order: AiDifficulty[] = ['easy', 'medium', 'hard'];
    const next = order[(order.indexOf(this._aiDifficulty) + 1) % order.length];
    this._aiDifficulty = next;
    this._debugPanel?.setDifficultyLabel(next);
    if (this._ai) this._ai = new AiController('dummy', AI_DIFFICULTY_PRESETS[next]);
  }
}

/**
 * Place two healing fountains at the arena's horizontal quarter-points,
 * snapped to walkable cells near the vertical center. Used by built-in
 * maps that don't author explicit fountain placements.
 */
function buildDefaultFountains(arena: ArenaRect, navGrid: NavGrid): FountainDef[] {
  const fountains: FountainDef[] = [];
  // Place at 25% and 75% of the arena width, on the horizontal midline.
  for (const fx of [0.25, 0.75]) {
    const wx = arena.minX + fx * arena.width;
    const pos = findWalkableCellNear(navGrid, wx, arena.centerZ);
    if (pos) {
      fountains.push({
        pos,
        healRadius: FOUNTAIN.healRadius,
        healPerSecond: FOUNTAIN.healPerSecond,
      });
    }
  }
  return fountains;
}

/** Lerp between two angles (radians) taking the shortest path. */