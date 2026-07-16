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
import { GoldDisplay } from '../ui/GoldDisplay';
import { MoveIndicatorManager } from '../ui/MoveIndicator';
import { DebugPanel } from '../ui/DebugPanel';
import { HeroPortrait } from '../ui/HeroPortrait';
import { SpellBar } from '../ui/SpellBar';

// ── Sim layer ──
import { HeroState, ProjectileState, WardState, MatchState, Command, HeroInput, SimEvent, createHeroState, createMatchState } from '../sim/state';
import { stepMatch, xpForLevel, heroSpeed } from '../sim/stepMatch';
import { SimWorld, sphereHitsObstacle } from '../sim/world';
import { buildSimWorld, buildNavGridFromWpm, buildObstaclesFromSolids } from '../sim/buildWorld';
import { HERO, ARROW, DODGE, WARD } from '../sim/rules';
import { SHOP_ITEMS } from '../sim/shopItems';
import { SnapshotMessage, WelcomeMessage, PeerJoinedMessage, PeerLeftMessage, Snapshot, SnapshotHero, HeroMeta } from '../sim/protocol';
import { Vec2, distance, clamp } from '../sim/math';

// ── Networking ──
import { NetworkClient } from '../net/NetworkClient';

// ── View layer ──
import { HeroView } from '../entities/HeroView';
import { ProjectileView } from '../combat/ProjectileView';
import { WardView } from '../entities/WardView';

// ── Debug tooling ──
import { ClientTrace } from '../testing/ClientTrace';

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
  private _terrain!: GroundProvider;
  private _water!: Water;

  // ── Shared world data ──
  private _navGrid!: NavGrid;
  private _pathfinder!: Pathfinder;
  private _obstacleRegistry!: ObstacleRegistry;

  // ── Simulation ──
  private _world!: SimWorld;
  private _state!: MatchState;
  private _playerId!: string;
  private _pendingCommands: Command[] = [];

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
  private _snapshots: Snapshot[] = [];
  /** Server tick duration in seconds; overwritten from the welcome message. */
  private _tickDt = 1 / 60;
  /**
   * How far behind the server tick timeline remote entities render. Sized
   * from the welcome tick rate: snapshots arrive every tick, so ~3 intervals
   * absorbs one dropped/late snapshot plus jitter (50 ms at 60 Hz).
   */
  private _interpDelay = 0.05;

  // ── Render clock ──
  // Remote entities are rendered _interpDelay behind the server tick
  // timeline. The clock must advance with *local* time every frame — deriving
  // it from the newest snapshot's tick freezes it between snapshot arrivals,
  // which renders remote motion as freeze-then-teleport steps.
  /** Accumulated local update time (seconds). */
  private _localTime = 0;
  /** Smoothed (serverTime − localTime); null until the first snapshot. */
  private _serverTimeOffset: number | null = null;

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
   * so `_renderProjectiles` never shows the server's duplicate. An entry
   * lives until the *render* timeline passes the projectile's last appearance
   * (`seenTick`) — pruning on the arrival timeline would unhide it while the
   * interp-delayed timeline still has it in flight.
   */
  private _ownArrowIds = new Map<string, { seenTick: number | null; missedBatches: number }>();

  // ── Views ──
  private _heroViews = new Map<string, HeroView>();
  private _projectileViews = new Map<string, ProjectileView>();
  private _wardViews = new Map<string, WardView>();
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

  // ── Input ──
  private _input!: InputManager;
  private _targeting!: TargetingSystem;

  // ── Debug trace (?debug=1) ──
  private _trace: ClientTrace | null = null;
  private _debugReady = false;

  // ── UI ──
  private _floatingText = new FloatingTextManager();
  private _cameraLocked = true;
  private _minimap!: Minimap;
  private _spellBar!: SpellBar;
  private _portrait!: HeroPortrait;
  private _goldDisplay!: GoldDisplay;
  private _itemBar!: ItemBar;
  private _kdDisplay!: KDDisplay;
  private _shop!: Shop;
  private _shopOverlay!: ShopOverlay;
  private _shopWindow!: ShopWindow;
  private _moveIndicators!: MoveIndicatorManager;
  private _debugPanel: DebugPanel | null = null;

  constructor() {
    this._loop = new GameLoop(60);
    this._loop.updateCb = this.update.bind(this);
    this._loop.renderCb = this._render.bind(this);
  }

  async init(): Promise<void> {
    (window as any).__game = this;

    // ── Detect network mode from URL (?room=XXXX) ──
    const urlParams = new URLSearchParams(window.location.search);
    this._roomCode = urlParams.get('room');
    if (urlParams.get('debug')) this._trace = new ClientTrace();
    if (this._roomCode) {
      this._networkMode = true;
      this._network = new NetworkClient();
    }

    // ── Map data (terrain, pathing, doodads) — ?map= selects the map ──
    this._mapName = resolveMapName(urlParams.get('map'));
    const loaded = await loadMap(this._mapName);
    this._map = loaded.data;
    this._arena = loaded.arena;
    this._mapSpawns = loaded.spawns;
    const bounds = this._map.bounds;

    // ── Renderer ──
    this._renderer = new Renderer();
    this._renderer.resize(window.innerWidth, window.innerHeight);
    document.body.appendChild(this._renderer.domElement);

    // ── Scene ──
    this._scene = createScene();
    createLighting(this._scene);

    // ── Terrain ──
    this._terrain = new Wc3Terrain(this._map);
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
    this._obstacleRegistry = new ObstacleRegistry();
    const doodads = new Doodads(this._map, heightAt, this._obstacleRegistry);
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

    // Override the shop position with the actual placed shop location
    // (buildSimWorld picks a walkable spot, but we already found one below).
    const shopPos3 = this._findWalkableNear(this._arena.centerX, this._arena.centerZ);
    this._world.shop.pos = { x: shopPos3.x, z: shopPos3.z };

    // ── Shop (3D mesh only; buy logic is in the sim) ──
    this._shop = new Shop(
      new THREE.Vector3(shopPos3.x, heightAt(shopPos3.x, shopPos3.z), shopPos3.z),
      SHOP_ITEMS as ShopItem[],
    );
    this._scene.add(this._shop.mesh);

    this._shopOverlay = new ShopOverlay();
    this._shopWindow = new ShopWindow({
      onBuy: (idx) => this._enqueueCommand({ type: 'buy', itemIndex: idx }),
      onClose: () => {},
    });

    // ── Match state ──
    this._state = createMatchState();

    if (this._networkMode && this._network) {
      // ── Network mode: connect to server, wait for welcome ──
      await this._initNetwork();
    } else {
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

      // Create hero views
      for (const hs of this._state.heroes) {
        const color = hs.team === 0 ? 0x4488cc : 0xcc3333;
        const view = new HeroView(hs.id, color, heightAt);
        view.sync(hs, 0);
        this._heroViews.set(hs.id, view);
        this._scene.add(view.mesh);
        const vSrc = this._createHeroVisionSource(hs, view);
        this._heroVisionAdapters.set(hs.id, vSrc);
        this._fog.addSource(vSrc);
      }
      this._playerView = this._heroViews.get('player')!;
      this._fog.recomputeNow();
    }

    // ── Fog render layer (needs the player's team, set above) ──
    this._fogLayer = new FogLayer(this._fog, this._playerState.team);
    this._fogLayer.applyTo(this._terrain.mesh);
    this._fogLayer.applyTo(this._water.group);
    this._fogLayer.applyTo(doodads.group);
    this._fogLayer.applyTo(this._shop.mesh);

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

    // ── Targeting system (wards, blink, AoE) ──
    this._targeting = new TargetingSystem();
    // Always intercept clicks — handleClick returns false when idle so
    // regular click handlers still fire.
    this._input.setClickInterceptor((pos) => this._targeting.handleClick(pos.x, pos.z));
    this._input.onRightClick(() => this._targeting.cancel());

    this._input.onClick((pos) => {
      // If click near shop and hero is also near shop, open the shop window.
      // If click near shop but hero is far, move hero near the shop first.
      const shopWPt = this._world.shop.pos;
      const heroDist = Math.hypot(this._playerState.pos.x - shopWPt.x, this._playerState.pos.z - shopWPt.z);
      const clickDist = Math.hypot(pos.x - shopWPt.x, pos.z - shopWPt.z);
      if (clickDist < this._world.shop.interactRadius) {
        if (heroDist <= this._world.shop.interactRadius) {
          this._shopWindow.open(SHOP_ITEMS as ShopItem[], this._playerState.gold, this._playerState.inventory);
          return;
        }
        // Hero is far — walk to a walkable spot near the shop, then open.
        const nearShop = this._findWalkableNear(shopWPt.x, shopWPt.z);
        this._enqueueCommand({ type: 'moveTo', x: nearShop.x, z: nearShop.z });
        this._moveIndicators.spawn(new THREE.Vector3(nearShop.x, this._heightAt(nearShop.x, nearShop.z), nearShop.z));
        return;
      }
      this._enqueueCommand({ type: 'moveTo', x: pos.x, z: pos.z });
      this._moveIndicators.spawn(pos);
    });

    // Q — Shoot Arrow (Shift+Q to spend skill point)
    this._input.onKeyDown('KeyQ', () => {
      this._targeting.cancel();
      if (this._input.isKeyDown('ShiftLeft') || this._input.isKeyDown('ShiftRight')) {
        this._enqueueCommand({ type: 'levelAbility', ability: 'arrow' });
      } else {
        const aim = this._input.aimPosition;
        this._enqueueCommand({
          type: 'fire',
          aimX: aim ? aim.x : this._playerState.pos.x + Math.sin(this._playerState.facing) * 100,
          aimZ: aim ? aim.z : this._playerState.pos.z + Math.cos(this._playerState.facing) * 100,
        });
      }
    });

    // W — Dodge (Shift+W to level up)
    this._input.onKeyDown('KeyW', () => {
      this._targeting.cancel();
      if (this._input.isKeyDown('ShiftLeft') || this._input.isKeyDown('ShiftRight')) {
        this._enqueueCommand({ type: 'levelAbility', ability: 'dodge' });
      } else {
        this._enqueueCommand({ type: 'dodge' });
      }
    });

    // B — Open shop when near
    this._input.onKeyDown('KeyB', () => {
      if (this._shopWindow.visible) {
        this._shopWindow.close();
      } else if (this._isPlayerNearShop()) {
        this._shopWindow.open(SHOP_ITEMS as ShopItem[], this._playerState.gold, this._playerState.inventory);
      }
    });

    // Escape — cancel targeting or close shop
    this._input.onKeyDown('Escape', () => {
      if (this._targeting.isActive) {
        this._targeting.cancel();
        return;
      }
      if (this._shopWindow.visible) this._shopWindow.close();
    });

    // Space — re-center camera
    this._input.onKeyDown('Space', () => { this._cameraLocked = true; });

    // Number keys 1–6: buy from shop when open, or use item / activate targeting
    for (let i = 1; i <= 6; i++) {
      this._input.onKeyDown(`Digit${i}`, () => {
        if (this._shopWindow.visible) {
          this._enqueueCommand({ type: 'buy', itemIndex: i - 1 });
          this._shopWindow.close();
          return;
        }
        const itemId = this._playerState.inventory[i - 1];
        // Toggle: if same ward item targeting is already active, cancel.
        if (this._targeting.isActive && itemId === 'sentry_wards' && this._targeting.sourceItemId === 'sentry_wards') {
          this._targeting.cancel();
          return;
        }
        // Toggle: if blink dagger targeting is already active, cancel.
        if (this._targeting.isActive && itemId === 'blink_dagger' && this._targeting.sourceItemId === 'blink_dagger') {
          this._targeting.cancel();
          return;
        }
        this._targeting.cancel();
        if (itemId === 'sentry_wards') {
          this._activateWardTargeting();
          return;
        }
        if (itemId === 'blink_dagger') {
          this._activateBlinkTargeting();
          return;
        }
        this._enqueueCommand({ type: 'useItem', slot: i - 1 });
      });
    }

    // ── UI ──
    this._spellBar = new SpellBar();
    this._portrait = new HeroPortrait();
    this._goldDisplay = new GoldDisplay();
    this._itemBar = new ItemBar();
    this._kdDisplay = new KDDisplay();
    this._moveIndicators = new MoveIndicatorManager(this._scene);

    // ── Debug panel (local dev only) ──
    if (!this._networkMode) {
      this._debugPanel = new DebugPanel(
        () => this._toggleFog(),
        () => this._debugLevelUp(),
        () => this._debugAddGold(),
        this._mapName === 'test' ? 'arena' : 'test',
        () => this._swapMap(),
      );
    }

    this._minimap = new Minimap(this._map, this._arena, 200, 8);
    this._minimap.setFog(this._fog, this._playerState.team);
    this._minimap.onClick = (wx, wz) => {
      this._cameraLocked = false;
      this._camera.setTarget(new THREE.Vector3(wx, this._smoothHeightAt(wx, wz), wz));
    };

    window.addEventListener('resize', this._onResize.bind(this));
    this._loop.start();
    this._debugReady = true;
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

  // ── Network init ────────────────────────────────────────────────────

  private async _initNetwork(): Promise<void> {
    const welcome = await this._network!.connect(this._roomCode!, 'Player', this._mapName);
    if (welcome.map && welcome.map !== this._mapName) {
      throw new Error(`room is on map '${welcome.map}' — reload with ?map=${welcome.map}`);
    }

    // All snapshot-timeline math derives from the server's tick rate.
    this._tickDt = 1 / welcome.tickRate;
    this._interpDelay = Math.max(0.05, 3 * this._tickDt);

    // Apply the welcome snapshot to initialise our state and views.
    this._playerId = welcome.playerId;
    this._applySnapshot(welcome.snapshot, welcome.meta);

    // Confirm our hero made it into the snapshot (`_applySnapshot` set
    // `_playerState` from it).
    const ourHero = this._state.heroes.find((h) => h.id === welcome.playerId);
    if (!ourHero) throw new Error('welcome did not include our hero');

    this._playerView = this._heroViews.get(welcome.playerId)!;
    this._fog.recomputeNow();

    console.log(`[Game] network mode ready, playerId=${welcome.playerId}, team=${this._playerState.team}, heroes=${this._state.heroes.length}, pos=${this._playerState.pos.x.toFixed(0)},${this._playerState.pos.z.toFixed(0)}`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

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
      const color = hs.id === this._playerId ? 0x4488cc : 0xcc3333;
      const view = new HeroView(hs.id, color, heightAt);
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

  /**
   * Adopt a full snapshot as the initial local state (welcome handshake).
   * Hydrates full HeroStates from the wire hot fields + cold meta, then
   * builds views. Nothing aliases the snapshot.
   */
  private _applySnapshot(snap: Snapshot, meta: HeroMeta[]): void {
    const metaById = new Map(meta.map((m) => [m.id, m]));
    this._state.heroes = snap.heroes.map((h) => this._heroFromWire(h, metaById.get(h.id)));
    this._state.projectiles = this._cloneProjectiles(snap.projectiles);
    this._state.wards = this._cloneWards(snap.wards);
    this._state.tick = snap.tick;

    const ourHero = this._state.heroes.find((h) => h.id === this._playerId);
    if (ourHero) this._playerState = ourHero;

    this._syncHeroViews(this._state.heroes);
  }

  // ── Network prediction helpers ──────────────────────────────────────

  /**
   * Apply server-authoritative state from the latest snapshot. Remote heroes
   * adopt the server's non-position state (position is set by interpolation);
   * the local player's hero is left to prediction + snap reconciliation.
   */
  private _applyServerState(snap: Snapshot): void {
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
    this._state.tick = snap.tick;
  }

  /**
   * Reconcile the player's predicted hero with the server snapshot. Non-
   * position state (HP, gold, …) is always taken from the server; position is
   * left to local prediction and only snapped on large desync (see
   * SNAP_THRESHOLD).
   */
  private _reconcileFromSnapshot(snap: Snapshot): void {
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
    dst.inventory = [...src.inventory];
    dst.wardCharges = src.wardCharges;
    dst.abilityLevel = src.abilityLevel;
    // Don't reconcile the local player's charge / cooldown / recoil timers —
    // prediction ticks them correctly and the server's value could be stale
    // (not yet processed our fire command).
    if (dst.id !== this._playerId) {
      dst.abilityCharges = src.abilityCharges;
      dst.abilityRecoilTimer = src.abilityRecoilTimer;
      dst.abilityCooldown = src.abilityCooldown;
    }
    dst.dodgeActive = src.dodgeActive;
    dst.dodgeTimer = src.dodgeTimer;
    dst.dodgeCooldown = src.dodgeCooldown;
    dst.dodgeLevel = src.dodgeLevel;
    dst.blinkCooldown = src.blinkCooldown;
  }

  /** Run local stepMatch for the player's hero only (instant movement feel). */
  private _predictMovement(inputs: HeroInput[], dt: number): void {
    if (inputs.length === 0 && !this._playerState?.moving) {
      // Prediction isn't stepping this frame, but predicted timers must still
      // run — otherwise a stationary hero's cooldown stays stuck until the
      // next move and the fire guard wrongly rejects follow-up shots.
      const idle = this._state.heroes.find((h) => h.id === this._playerId);
      if (idle) {
        if (idle.abilityRecoilTimer > 0) {
          idle.abilityRecoilTimer = Math.max(0, idle.abilityRecoilTimer - dt);
        }
        if (idle.abilityCooldown > 0) {
          idle.abilityCooldown = Math.max(0, idle.abilityCooldown - dt);
          if (idle.abilityCooldown <= 0 && idle.abilityCharges < ARROW.maxCharges) {
            idle.abilityCharges++;
            if (idle.abilityCharges < ARROW.maxCharges) {
              idle.abilityCooldown = ARROW.cooldownByLevel[Math.max(idle.abilityLevel, 1)];
            }
          }
        }
        if (idle.blinkCooldown > 0) {
          idle.blinkCooldown = Math.max(0, idle.blinkCooldown - dt);
        }
      }
      return;
    }

    const player = this._state.heroes.find((h) => h.id === this._playerId);
    if (!player || !player.alive) return;

    const temp = createMatchState();
    temp.heroes = [player];
    temp.projectiles = [];
    temp.wards = [];
    const tempInputs = inputs.filter((i) => i.heroId === this._playerId);

    stepMatch(temp, tempInputs, dt, this._world);

    player.pos = { ...temp.heroes[0].pos };
    player.facing = temp.heroes[0].facing;
    player.targetFacing = temp.heroes[0].targetFacing;
    player.path = temp.heroes[0].path.map((p) => ({ ...p }));
    player.moving = temp.heroes[0].moving;
    // Also sync predicted charge / cooldown / recoil so the cosmetic guard
    // and UI stay in lockstep with what the sim accepted or rejected.
    player.abilityCharges = temp.heroes[0].abilityCharges;
    player.abilityCooldown = temp.heroes[0].abilityCooldown;
    player.abilityRecoilTimer = temp.heroes[0].abilityRecoilTimer;
  }

  /**
   * Interpolate remote hero positions between the pair of snapshots that
   * straddles `renderTime`, so tick-rate snapshots render as smooth motion
   * at any display refresh rate.
   */
  private _interpolateHeroes(renderTime: number): void {
    if (this._snapshots.length < 2) return;

    // Default to the oldest adjacent pair; overwrite if a straddling pair is
    // found. Clamped `t` handles renderTime outside the buffered range.
    let prev = this._snapshots[0];
    let next = this._snapshots[1];
    for (let i = 0; i < this._snapshots.length - 1; i++) {
      const a = this._snapshots[i];
      const b = this._snapshots[i + 1];
      if (a.tick * this._tickDt <= renderTime && renderTime <= b.tick * this._tickDt) {
        prev = a;
        next = b;
        break;
      }
      // renderTime is newer than everything buffered — use the newest pair.
      if (i === this._snapshots.length - 2) {
        prev = a;
        next = b;
      }
    }

    const prevTime = prev.tick * this._tickDt;
    const nextTime = next.tick * this._tickDt;
    const span = nextTime - prevTime;
    const t = span > 0 ? clamp((renderTime - prevTime) / span, 0, 1) : 0;

    for (const hero of this._state.heroes) {
      if (hero.id === this._playerId) continue;
      const prevH = prev.heroes.find((h) => h.id === hero.id);
      const nextH = next.heroes.find((h) => h.id === hero.id);
      if (!prevH || !nextH) continue;
      hero.pos.x = prevH.pos.x + (nextH.pos.x - prevH.pos.x) * t;
      hero.pos.z = prevH.pos.z + (nextH.pos.z - prevH.pos.z) * t;
      // lerp angle
      hero.facing = _lerpAngle(prevH.facing, nextH.facing, t);
    }
  }

  /**
   * Rebuild `_state.projectiles` for this frame from the snapshot just ahead
   * of `renderTime`. Projectiles fly in straight lines at constant speed, so
   * their position at renderTime is exact: walk back along `dir` from the
   * snapshot position (clamped by `traveled`, i.e. never before the spawn
   * point). This renders every projectile that reaches *any* snapshot for its
   * full lifetime — including ones that would be missed when several
   * snapshots arrive in one frame — with per-frame motion, not tick steps.
   */
  private _renderProjectiles(renderTime: number): void {
    if (this._snapshots.length === 0) return;

    let next = this._snapshots[this._snapshots.length - 1];
    for (const s of this._snapshots) {
      if (s.tick * this._tickDt >= renderTime) {
        next = s;
        break;
      }
    }
    // If renderTime has outrun the buffer (network stall), `behind` is 0 and
    // projectiles hold at their last known position rather than extrapolating.
    const behind = Math.max(0, next.tick * this._tickDt - renderTime);

    // Release own-arrow ids the render timeline has fully passed.
    for (const [id, rec] of this._ownArrowIds) {
      if (rec.seenTick !== null && next.tick > rec.seenTick) this._ownArrowIds.delete(id);
    }

    this._state.projectiles = next.projectiles
      .filter((sp) => !this._ownArrowIds.has(sp.id)) // own arrows render locally
      .map((sp) => {
        const back = Math.min(sp.speed * behind, sp.traveled);
        return {
          ...sp,
          pos: { x: sp.pos.x - sp.dir.x * back, z: sp.pos.z - sp.dir.z * back },
          dir: { x: sp.dir.x, z: sp.dir.z },
          traveled: sp.traveled - back,
        };
      });
  }

  /**
   * Note the last snapshot tick each own arrow was seen at (its release from
   * `_ownArrowIds` happens in `_renderProjectiles`, on the render timeline).
   * Ids never seen within a few batches died between broadcasts — they can't
   * leak a duplicate, so drop them.
   */
  private _trackOwnArrowIds(snaps: Snapshot[]): void {
    for (const [id, rec] of this._ownArrowIds) {
      let seen = false;
      for (const snap of snaps) {
        if (snap.projectiles.some((p) => p.id === id)) {
          rec.seenTick = snap.tick;
          seen = true;
        }
      }
      if (!seen && rec.seenTick === null && ++rec.missedBatches >= 6) {
        this._ownArrowIds.delete(id);
      }
    }
  }

  /** Track our fire/hit events to link cosmetic arrows to server projectiles. */
  private _handleOwnArrowEvent(ev: SimEvent): void {
    if (ev.type === 'fire' && ev.heroId === this._playerId) {
      const cosmetic = this._cosmeticProjectiles.find((c) => c.serverId === null);
      // Only hide the server projectile when a local arrow actually claimed
      // it — if the cosmetic guard suppressed the spawn, the interp-timeline
      // projectile is the only visible copy and must stay rendered.
      if (cosmetic) {
        cosmetic.serverId = ev.projectileId;
        this._ownArrowIds.set(ev.projectileId, { seenTick: null, missedBatches: 0 });
      }
      return;
    }
    // Our arrow hit someone: retire the local arrow closest to the impact.
    // (Obstacle and max-range deaths are computed locally and need no event.)
    if (ev.type === 'hit' && ev.sourceId === this._playerId) {
      let best: (typeof this._cosmeticProjectiles)[number] | null = null;
      let bestDist = 400; // ignore implausible matches (≈ max prediction lead)
      for (const c of this._cosmeticProjectiles) {
        const d = Math.hypot(c.pos.x - ev.x, c.pos.z - ev.z);
        if (d < bestDist) {
          best = c;
          bestDist = d;
        }
      }
      if (best) this._retireCosmetic(best);
    }
  }

  private _retireCosmetic(c: (typeof this._cosmeticProjectiles)[number]): void {
    const i = this._cosmeticProjectiles.indexOf(c);
    if (i >= 0) this._cosmeticProjectiles.splice(i, 1);
    c.view.hide();
    this._projectilePool.push(c.view);
  }

  // ── Cosmetic projectiles ────────────────────────────────────────────

  /** Spawn a local arrow instantly when the player fires. */
  private _spawnCosmeticProjectile(cmd: Command & { type: 'fire' }): void {
    const player = this._playerState;
    if (!player || !player.alive) return;
    // Mirror the server's fire guard (stepMatch.fireArrow) so we don't show a
    // ghost arrow for a shot the server will reject.
    if (player.abilityLevel < 1) return;
    if (player.abilityCharges <= 0) return;
    if (player.abilityRecoilTimer > 0) return;

    const dirX = cmd.aimX - player.pos.x;
    const dirZ = cmd.aimZ - player.pos.z;
    const len = Math.hypot(dirX, dirZ);
    const dir = len < 0.01
      ? { x: Math.sin(player.facing), z: Math.cos(player.facing) }
      : { x: dirX / len, z: dirZ / len };

    const pv = this._projectilePool.pop();
    if (!pv) return;

    const spawnPos = {
      x: player.pos.x + dir.x * ARROW.spawnOffset,
      z: player.pos.z + dir.z * ARROW.spawnOffset,
    };
    pv.mesh.position.set(
      spawnPos.x,
      this._heightAt(spawnPos.x, spawnPos.z) + ARROW.flyHeight,
      spawnPos.z,
    );
    pv.mesh.rotation.y = Math.atan2(dir.x, dir.z);
    pv.mesh.visible = true;

    this._cosmeticProjectiles.push({
      view: pv,
      pos: spawnPos,
      dir,
      speed: ARROW.speed,
      traveled: 0,
      maxRange: ARROW.rangeByLevel[Math.min(player.abilityLevel, 4)],
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
      c.traveled += c.speed * dt;
      if (c.traveled >= c.maxRange) {
        this._retireCosmetic(c);
        continue;
      }
      c.pos = {
        x: c.pos.x + c.dir.x * c.speed * dt,
        z: c.pos.z + c.dir.z * c.speed * dt,
      };
      if (sphereHitsObstacle(this._world, c.pos, ARROW.collisionRadius)) {
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

  private _isPlayerNearShop(): boolean {
    const s = this._world.shop.pos;
    const p = this._playerState.pos;
    return Math.hypot(s.x - p.x, s.z - p.z) <= this._world.shop.interactRadius;
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

    // ── Step the simulation ──
    const events = stepMatch(this._state, inputs, dt, this._world);

    // ── Process events ──
    for (const ev of events) this._handleEvent(ev, dt);

    // ── Sync views ──
    this._syncAllViews(dt);

    // ── Fog ──
    this._fog.update(dt);
    this._fogLayer.update(dt);
    this._applyFogVisibility();

    // ── Misc ──
    this._floatingText.update(dt, this._camera.camera);
    this._water.update(dt);
    this._moveIndicators.update(dt);

    this._recordTraceFrame([], events);
  }

  private _updateNetwork(dt: number): void {
    // ── Targeting ──
    this._updateTargeting();

    // ── Camera ──
    this._updateCamera(dt);
    this._localTime += dt;

    // ── Drain pending commands for prediction & cosmetics ──
    // (Commands already went on the wire in `_enqueueCommand`.)
    const localInputs: HeroInput[] = [];
    for (const cmd of this._pendingCommands) {
      localInputs.push({ heroId: this._playerId, cmd });
      if (cmd.type === 'fire') {
        this._spawnCosmeticProjectile(cmd);
      }
    }
    this._pendingCommands = [];

    // ── Drain snapshots into buffer, sync the render clock ──
    const snaps = this._network?.drainSnapshots() ?? [];
    for (const snap of snaps) {
      this._snapshots.push(snap);
      this._reconcileFromSnapshot(snap);
      // Track (serverTime − localTime) with a light EMA: smooths arrival
      // jitter, hard-resets on gross desync (join, tab suspend).
      const sample = snap.tick * this._tickDt - this._localTime;
      if (this._serverTimeOffset === null || Math.abs(sample - this._serverTimeOffset) > 0.5) {
        this._serverTimeOffset = sample;
      } else {
        this._serverTimeOffset += (sample - this._serverTimeOffset) * 0.1;
      }
    }

    // ── Apply server state for remote entities ──
    if (snaps.length > 0) {
      this._applyServerState(snaps[snaps.length - 1]);
      this._trackOwnArrowIds(snaps);
    }

    // ── Cold hero fields (low rate + event-triggered flushes) ──
    const meta = this._network?.takeMeta();
    if (meta) {
      for (const m of meta) {
        const hero = this._state.heroes.find((h) => h.id === m.id);
        if (hero) this._applyMetaFields(hero, m);
      }
    }

    // Render clock: advances every frame with local time (never frozen
    // between snapshot arrivals), offset onto the server tick timeline.
    const renderTime = this._serverTimeOffset === null
      ? null
      : this._localTime + this._serverTimeOffset - this._interpDelay;

    // Prune snapshots that fell behind the straddling pair.
    if (renderTime !== null) {
      while (this._snapshots.length > 2 && this._snapshots[1].tick * this._tickDt <= renderTime) {
        this._snapshots.shift();
      }
    }

    // ── Drain events (own-arrow bookkeeping first: it may retire arrows) ──
    const frameEvents = this._network?.drainEvents() ?? [];
    for (const ev of frameEvents) {
      this._handleOwnArrowEvent(ev);
      this._handleEvent(ev, dt);
    }

    // ── Interpolate remote heroes ──
    if (renderTime !== null) this._interpolateHeroes(renderTime);

    // ── Local prediction: move own hero with pending inputs ──
    // (Snap-based reconciliation already happened per-snapshot above.)
    this._predictMovement(localInputs, dt);

    // ── Own arrows fly locally; remote projectiles come off the interp timeline ──
    this._tickCosmeticProjectiles(dt);
    if (renderTime !== null) this._renderProjectiles(renderTime);

    // ── Sync views ──
    this._syncAllViews(dt);

    // ── Fog ──
    this._fog.update(dt);
    this._fogLayer.update(dt);
    this._applyFogVisibility();

    // ── Misc ──
    this._floatingText.update(dt, this._camera.camera);
    this._water.update(dt);
    this._moveIndicators.update(dt);

    this._recordTraceFrame(snaps.map((s) => s.tick), frameEvents);
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
      shop: { ...this._world.shop.pos },
      heroes: this._state.heroes.map((h) => ({
        id: h.id, x: h.pos.x, z: h.pos.z, hp: h.hp, alive: h.alive,
        abilityLevel: h.abilityLevel, abilityCooldown: h.abilityCooldown,
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

  /** Activate ground-targeting for sentry wards. */
  private _activateWardTargeting(): void {
    const p = this._playerState;
    if (!p || !p.alive || p.wardCharges <= 0) return;
    this._targeting.activate(
      {
        range: WARD.placeRange,
        indicatorColor: 0x66ff88,
        validateTarget: walkableValidator(this._navGrid, this._world.obstacles),
        onTarget: (x, z) => {
          this._enqueueCommand({ type: 'ward', x, z });
          // Stop the hero after placing (harmless if already stationary).
          const p = this._playerState;
          this._enqueueCommand({ type: 'moveTo', x: p.pos.x, z: p.pos.z });
        },
        onCancel: () => {},
        onMove: (x, z) => {
          this._enqueueCommand({ type: 'moveTo', x, z });
          this._moveIndicators.spawn(
            new THREE.Vector3(x, this._heightAt(x, z), z),
          );
        },
      },
      'sentry_wards',
      p.pos.x, p.pos.z,
      this._heightAt(p.pos.x, p.pos.z),
      this._scene,
    );
  }

  /** Activate ground-targeting for the blink dagger. */
  private _activateBlinkTargeting(): void {
    const p = this._playerState;
    if (!p || !p.alive) return;
    if (p.blinkCooldown > 0) return;
    const BLINK_RANGE = 450;
    this._targeting.activate(
      {
        range: BLINK_RANGE,
        indicatorColor: 0x9966ff,
        validateTarget: walkableValidator(this._navGrid, this._world.obstacles),
        onTarget: (x, z) => {
          this._enqueueCommand({ type: 'blink', x, z });
        },
        onCancel: () => {},
        onMove: (x, z) => {
          this._enqueueCommand({ type: 'moveTo', x, z });
          this._moveIndicators.spawn(
            new THREE.Vector3(x, this._heightAt(x, z), z),
          );
        },
      },
      'blink_dagger',
      p.pos.x, p.pos.z,
      this._heightAt(p.pos.x, p.pos.z),
      this._scene,
    );
  }

  private _updateCamera(dt: number): void {
    const pan = this._input.edgePan;
    if (pan.length() > 0) {
      this._cameraLocked = false;
      const speed = 1200 * dt;
      this._camera.panScreen(pan.x * speed, pan.z * speed);
    } else if (this._cameraLocked && this._playerState) {
      this._camera.follow(new THREE.Vector3(
        this._playerState.pos.x,
        this._smoothHeightAt(this._playerState.pos.x, this._playerState.pos.z),
        this._playerState.pos.z,
      ));
    }
    const focus = this._camera.focus;
    this._camera.setFocusY(this._smoothHeightAt(focus.x, focus.z));
  }

  private _syncAllViews(dt: number): void {
    // Sync hero views
    for (const hero of this._state.heroes) {
      const view = this._heroViews.get(hero.id);
      if (view) view.sync(hero, dt);
    }
    // Sync projectile views
    this._syncProjectileViews();
    // Sync ward views
    this._syncWardViews();
  }

  // ── Event handling ──────────────────────────────────────────────────

  private _handleEvent(ev: SimEvent, _dt: number): void {
    switch (ev.type) {
      case 'hit': {
        // Floating damage number
        const targetView = this._heroViews.get(ev.targetId);
        if (targetView) {
          this._floatingText.spawn(targetView.mesh.position, ev.damage);
        }
        // Hit flash on the target's view
        targetView?.flashHit();
        break;
      }
      case 'fire': {
        // Muzzle flash + bow-release gesture on the shooter's view
        const shooterView = this._heroViews.get(ev.heroId);
        shooterView?.flashFire();
        shooterView?.playShoot();
        break;
      }
      case 'kill':
      case 'respawn':
      case 'purchase':
      case 'levelUp':
        // UI is driven by state inspection each render frame; events are
        // informational for future network/audio hooks.
        break;
    }
  }

  // ── Projectile view sync ────────────────────────────────────────────

  private _syncProjectileViews(): void {
    const activeIds = new Set(this._state.projectiles.map((p) => p.id));

    // Create views for new projectiles
    for (const p of this._state.projectiles) {
      if (!this._projectileViews.has(p.id)) {
        const pv = this._projectilePool.pop();
        if (pv) {
          this._projectileViews.set(p.id, pv);
        } else {
          // Pool exhausted — create a new one on the fly
          const fresh = new ProjectileView(p.id);
          this._scene.add(fresh.mesh);
          this._projectileViews.set(p.id, fresh);
        }
      }
    }

    // Sync or hide each projectile view
    for (const [id, pv] of this._projectileViews) {
      if (activeIds.has(id)) {
        const p = this._state.projectiles.find((sp) => sp.id === id)!;
        pv.sync(p, this._heightAt.bind(this));
      } else {
        pv.hide();
        this._projectileViews.delete(id);
        this._projectilePool.push(pv);
      }
    }
  }

  // ── Ward view sync ──────────────────────────────────────────────────

  private _syncWardViews(): void {
    const activeIds = new Set(this._state.wards.map((w) => w.id));

    // Create views for new wards
    for (const w of this._state.wards) {
      if (!this._wardViews.has(w.id)) {
        const wv = new WardView(w.id);
        this._scene.add(wv.mesh);
        this._wardViews.set(w.id, wv);
        // Add vision source
        const vSrc = this._createWardVisionSource(w, wv);
        this._wardVisionAdapters.set(w.id, vSrc);
        this._fog.addSource(vSrc);
      }
    }

    // Sync or remove each ward view
    for (const [id, wv] of this._wardViews) {
      if (activeIds.has(id)) {
        const w = this._state.wards.find((sw) => sw.id === id)!;
        wv.sync(w, this._heightAt.bind(this));
      } else {
        // Remove vision source
        const vSrc = this._wardVisionAdapters.get(id);
        if (vSrc) {
          this._fog.removeSource(vSrc);
          this._wardVisionAdapters.delete(id);
        }
        wv.dispose();
        this._wardViews.delete(id);
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  private _render(_interpolation: number): void {
    this._renderer.render(this._scene, this._camera.camera);

    const p = this._playerState;
    const playerTeam = p.team;

    // Minimap markers
    const markers = this._state.heroes
      .filter((h) =>
        h.alive &&
        (h.team === playerTeam || this._fog.isVisible(playerTeam, h.pos.x, h.pos.z)))
      .map((h) => ({
        x: h.pos.x,
        z: h.pos.z,
        color: h.team === playerTeam ? '#44aaff' : '#ff4444',
        radius: h.id === this._playerId ? 4 : 3,
      }));

    // Own wards
    for (const w of this._state.wards) {
      if (w.team === playerTeam) {
        markers.push({ x: w.pos.x, z: w.pos.z, color: '#66ff88', radius: 2 });
      }
    }

    // Shop marker
    const sp = this._world.shop.pos;
    markers.push({ x: sp.x, z: sp.z, color: '#ffcc44', radius: 4 });

    this._minimap.draw(markers, {
      cx: this._camera.target.x,
      cz: this._camera.target.z,
      halfW: this._camera.viewHalfWidth(),
    });

    // Spell bar cooldowns
    const arrowCd = ARROW.cooldownByLevel[Math.max(p.abilityLevel, 1)];
    const cdProgress = p.abilityCooldown <= 0 ? 1
      : 1 - p.abilityCooldown / arrowCd;
    const dodgeCdProgress = p.dodgeCooldown <= 0 ? 1
      : 1 - p.dodgeCooldown / DODGE.cooldownByLevel[Math.min(p.dodgeLevel, 4)];
    this._spellBar.update(
      cdProgress, p.abilityLevel, p.skillPoints,
      dodgeCdProgress, p.dodgeLevel,
      p.abilityCharges, ARROW.maxCharges,
    );

    // Hero portrait
    this._portrait.update(
      p.xp,
      xpForLevel(p.level + 1),
      xpForLevel(p.level),
      p.level,
      '#4488cc',
    );

    this._goldDisplay.update(p.gold);
    this._itemBar.update(p.inventory, { sentry_wards: p.wardCharges });
    this._kdDisplay.update(p.kills, p.deaths);

    // Shop overlay — show when in range
    if (this._isPlayerNearShop()) {
      this._shopOverlay.show(SHOP_ITEMS as ShopItem[]);
    } else {
      this._shopOverlay.hide();
      // Auto-close shop window if hero walks away from shop
      if (this._shopWindow.visible) this._shopWindow.close();
    }
    // Refresh shop window while it's open so gold/inventory changes are reflected
    if (this._shopWindow.visible) {
      this._shopWindow.refresh(this._playerState.gold, this._playerState.inventory);
    }
  }

  // ── Fog visibility ──────────────────────────────────────────────────

  private _applyFogVisibility(): void {
    const team = this._playerState.team;

    // Enemy heroes
    for (const hero of this._state.heroes) {
      if (hero.team === team) continue;
      const view = this._heroViews.get(hero.id);
      if (view) {
        view.mesh.visible = hero.alive && this._fog.isVisible(team, hero.pos.x, hero.pos.z);
      }
    }

    // Enemy projectiles
    for (const p of this._state.projectiles) {
      const pv = this._projectileViews.get(p.id);
      if (pv && p.team !== team) {
        pv.mesh.visible = this._fog.isVisible(team, p.pos.x, p.pos.z);
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
  }

  // ── Spawn helpers ───────────────────────────────────────────────────

  private _findRespawnPosition(): THREE.Vector3 {
    const arena = this._arena;
    const anchor = this._world.shop.pos;
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
    const start = this._navGrid.worldToGrid(wx, wz);
    for (let radius = 0; radius < 64; radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const gx = start.gx + dx;
          const gz = start.gz + dz;
          if (this._navGrid.isWalkable(gx, gz)) {
            const { wx: cx, wz: cz } = this._navGrid.gridToWorld(gx, gz);
            return new THREE.Vector3(cx, this._heightAt(cx, cz), cz);
          }
        }
      }
    }
    return new THREE.Vector3(wx, this._heightAt(wx, wz), wz);
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
      this._playerState.gold += 10;
    }
  }

  /** Reload the page on the other map (all world data derives from the map). */
  private _swapMap(): void {
    const url = new URL(window.location.href);
    url.searchParams.set('map', this._mapName === 'test' ? 'arena' : 'test');
    window.location.href = url.toString();
  }
}

/** Lerp between two angles (radians) taking the shortest path. */
function _lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
