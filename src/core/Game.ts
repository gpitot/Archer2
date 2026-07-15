import * as THREE from 'three';
import { GameLoop } from './GameLoop';
import { Renderer } from '../rendering/Renderer';
import { createScene } from '../rendering/Scene';
import { createLighting } from '../rendering/Lighting';
import { IsometricCamera } from '../rendering/Camera';
import { Minimap } from '../rendering/Minimap';
import { Shop, ShopItem } from '../world/Shop';
import { ObstacleRegistry } from '../world/ObstacleRegistry';
import { MapData, loadMapData, ArenaRect, ARENA_TERRAIN1, PATH_CELL_SIZE } from '../world/wc3/MapData';
import { Wc3Terrain } from '../world/Wc3Terrain';
import { Water } from '../world/Water';
import { Doodads } from '../world/Doodads';
import { isCellWalkable } from '../world/wc3/WpmParser';
import { NavGrid } from '../navigation/NavGrid';
import { Pathfinder } from '../navigation/Pathfinder';
import { FogOfWar, VisionSource } from '../vision/FogOfWar';
import { FogLayer } from '../vision/FogLayer';
import { InputManager } from '../input/InputManager';
import { ItemBar } from '../ui/ItemBar';
import { KDDisplay } from '../ui/KDDisplay';
import { ShopWindow } from '../ui/ShopWindow';
import { FloatingTextManager } from '../ui/FloatingText';
import { ShopOverlay } from '../ui/ShopOverlay';
import { GoldDisplay } from '../ui/GoldDisplay';
import { HeroPortrait } from '../ui/HeroPortrait';
import { SpellBar } from '../ui/SpellBar';

// ── Sim layer ──
import { HeroState, MatchState, Command, HeroInput, SimEvent, createHeroState, createMatchState } from '../sim/state';
import { stepMatch, xpForLevel, heroSpeed } from '../sim/stepMatch';
import { SimWorld } from '../sim/world';
import { buildSimWorld, buildObstaclesFromSolids } from '../sim/buildWorld';
import { HERO, ARROW, WARD } from '../sim/rules';
import { SHOP_ITEMS } from '../sim/shopItems';
import { SnapshotMessage, WelcomeMessage, EventMessage, PeerJoinedMessage, PeerLeftMessage, Snapshot } from '../sim/protocol';

// ── Networking ──
import { NetworkClient } from '../net/NetworkClient';

// ── View layer ──
import { HeroView } from '../entities/HeroView';
import { ProjectileView } from '../combat/ProjectileView';
import { WardView } from '../entities/WardView';

const FOG_CELL_SIZE = 40;

/** Ground surface abstraction. */
interface GroundProvider {
  mesh: THREE.Object3D;
  heightAt(x: number, z: number): number;
}

export class Game {
  // ── Rendering ──
  private _loop: GameLoop;
  private _renderer!: Renderer;
  private _scene!: THREE.Scene;
  private _camera!: IsometricCamera;
  private _map!: MapData;
  private _arena: ArenaRect = ARENA_TERRAIN1;
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
    if (this._roomCode) {
      this._networkMode = true;
      this._network = new NetworkClient();
    }

    // ── Original map data (terrain, pathing, doodads) ──
    this._map = await loadMapData();
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

    // ── Navigation ──
    this._navGrid = new NavGrid(
      this._map.pathing.width,
      this._map.pathing.height,
      PATH_CELL_SIZE,
      bounds.minX,
      bounds.minZ,
    );
    this._applyPathingToNav();
    this._pathfinder = new Pathfinder(this._navGrid);

    // ── Doodads ──
    this._obstacleRegistry = new ObstacleRegistry();
    const doodads = new Doodads(this._map, heightAt, this._obstacleRegistry);
    this._scene.add(doodads.group);

    // ── Fog of war ──
    this._fog = new FogOfWar(this._arena, FOG_CELL_SIZE, heightAt);
    for (const s of doodads.solids) {
      if (s.x >= this._arena.minX && s.x <= this._arena.maxX &&
          s.z >= this._arena.minZ && s.z <= this._arena.maxZ) {
        this._fog.addSightBlocker(s.x, s.z, s.halfW, s.halfD, s.height);
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
    );
    this._world.obstacles = buildObstaclesFromSolids(doodads.solids);

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
      await this._initNetwork(heightAt, doodads.solids);
    } else {
      // ── Offline mode: create local heroes ──
      const heroSpawn = this._findRespawnPosition();
      const playerState = createHeroState('player', 0, { x: heroSpawn.x, z: heroSpawn.z });
      this._state.heroes.push(playerState);
      this._playerId = 'player';
      this._playerState = playerState;

      const dummySpawn = this._findWalkableNear(heroSpawn.x + 400, heroSpawn.z + 200);
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
      heightAt(this._playerState.pos.x, this._playerState.pos.z),
      this._playerState.pos.z,
    ));
    this._camera.setFocusY(heightAt(this._playerState.pos.x, this._playerState.pos.z));

    // ── Input ──
    this._input = new InputManager(this._renderer.domElement, this._camera.camera);
    this._input.setGround(this._terrain.mesh);
    this._input.onScroll((deltaY) => this._camera.zoom(deltaY * 0.6));

    this._input.onClick((pos) => {
      // If click near shop, open shop instead of moving
      const shopWPt = this._world.shop.pos;
      const dx = pos.x - shopWPt.x;
      const dz = pos.z - shopWPt.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < this._world.shop.interactRadius) {
        this._shopWindow.open(SHOP_ITEMS as ShopItem[], this._playerState.gold, this._playerState.inventory);
        return;
      }
      this._enqueueCommand({ type: 'moveTo', x: pos.x, z: pos.z });
    });

    // Q — Shoot Arrow (Ctrl+Q to spend skill point)
    this._input.onKeyDown('KeyQ', () => {
      if (this._input.isKeyDown('ControlLeft') || this._input.isKeyDown('ControlRight')) {
        this._enqueueCommand({ type: 'levelAbility' });
      } else {
        const aim = this._input.aimPosition;
        this._enqueueCommand({
          type: 'fire',
          aimX: aim ? aim.x : this._playerState.pos.x + Math.sin(this._playerState.facing) * 100,
          aimZ: aim ? aim.z : this._playerState.pos.z + Math.cos(this._playerState.facing) * 100,
        });
      }
    });

    // W — Place a sentry ward
    this._input.onKeyDown('KeyW', () => this._enqueueCommand({ type: 'ward' }));

    // B — Open shop when near
    this._input.onKeyDown('KeyB', () => {
      if (this._shopWindow.visible) {
        this._shopWindow.close();
      } else if (this._isPlayerNearShop()) {
        this._shopWindow.open(SHOP_ITEMS as ShopItem[], this._playerState.gold, this._playerState.inventory);
      }
    });

    // Escape — close shop
    this._input.onKeyDown('Escape', () => {
      if (this._shopWindow.visible) this._shopWindow.close();
    });

    // Space — re-center camera
    this._input.onKeyDown('Space', () => { this._cameraLocked = true; });

    // Number keys 1–6 for quick buy
    for (let i = 1; i <= 6; i++) {
      this._input.onKeyDown(`Digit${i}`, () => {
        if (this._shopWindow.visible) {
          this._enqueueCommand({ type: 'buy', itemIndex: i - 1 });
          this._shopWindow.close();
        }
      });
    }

    // ── UI ──
    this._spellBar = new SpellBar();
    this._portrait = new HeroPortrait();
    this._goldDisplay = new GoldDisplay();
    this._itemBar = new ItemBar();
    this._kdDisplay = new KDDisplay();

    this._minimap = new Minimap(this._map, this._arena, 200, 8);
    this._minimap.setFog(this._fog, this._playerState.team);
    this._minimap.onClick = (wx, wz) => {
      this._cameraLocked = false;
      this._camera.setTarget(new THREE.Vector3(wx, heightAt(wx, wz), wz));
    };

    window.addEventListener('resize', this._onResize.bind(this));
    this._loop.start();
  }

  get heroState(): HeroState { return this._playerState; }

  // ── Input queue ─────────────────────────────────────────────────────

  private _enqueueCommand(cmd: Command): void {
    this._pendingCommands.push(cmd);
  }

  // ── Network init ────────────────────────────────────────────────────

  private async _initNetwork(
    heightAt: (x: number, z: number) => number,
    _solids: { x: number; z: number; halfW: number; halfD: number }[],
  ): Promise<void> {
    const welcome = await this._network!.connect(this._roomCode!, 'Player');

    // Apply the welcome snapshot to initialise our state and views.
    this._applySnapshot(welcome.snapshot);

    // Find our hero in the snapshot.
    const ourHero = this._state.heroes.find((h) => h.id === welcome.playerId);
    if (!ourHero) throw new Error('welcome did not include our hero');
    this._playerState = ourHero;

    // Create hero views for all heroes in the initial snapshot.
    for (const hs of this._state.heroes) {
      const color = hs.id === welcome.playerId ? 0x4488cc : 0xcc3333;
      const view = new HeroView(hs.id, color, heightAt);
      view.sync(hs, 0);
      this._heroViews.set(hs.id, view);
      this._scene.add(view.mesh);
      const vSrc = this._createHeroVisionSource(hs, view);
      this._heroVisionAdapters.set(hs.id, vSrc);
      this._fog.addSource(vSrc);
    }
    this._playerView = this._heroViews.get(welcome.playerId)!;
    this._fog.recomputeNow();

    console.log(`[Game] network mode ready, playerId=${welcome.playerId}, ${this._state.heroes.length} heroes`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Apply a server snapshot to the local state and view layer. */
  private _applySnapshot(snap: Snapshot | MatchState): void {
    // ── Heroes: add new, remove gone ──
    const newIds = new Set(snap.heroes.map((h: HeroState) => h.id));

    // Remove views for heroes that left.
    for (const [id, view] of this._heroViews) {
      if (!newIds.has(id)) {
        const vSrc = this._heroVisionAdapters.get(id);
        if (vSrc) this._fog.removeSource(vSrc);
        this._heroVisionAdapters.delete(id);
        view.dispose();
        this._heroViews.delete(id);
      }
    }

    // Add views for new heroes.
    const heightAt = this._heightAt.bind(this);
    for (const hs of snap.heroes) {
      if (!this._heroViews.has(hs.id)) {
        const isOurs = hs.id === this._playerId;
        const color = isOurs ? 0x4488cc : 0xcc3333;
        const view = new HeroView(hs.id, color, heightAt);
        view.sync(hs, 0);
        this._heroViews.set(hs.id, view);
        this._scene.add(view.mesh);
        const vSrc = this._createHeroVisionSource(hs, view);
        this._heroVisionAdapters.set(hs.id, vSrc);
        this._fog.addSource(vSrc);
      }
    }

    // Update state.
    this._state.heroes = snap.heroes;
    this._state.projectiles = snap.projectiles;
    this._state.wards = snap.wards;
    if ('tick' in snap) this._state.tick = snap.tick;

    // Keep player state reference in sync.
    const ourHero = snap.heroes.find((h: HeroState) => h.id === this._playerId);
    if (ourHero) this._playerState = ourHero;
  }

  private _isPlayerNearShop(): boolean {
    const s = this._world.shop.pos;
    const p = this._playerState.pos;
    return Math.hypot(s.x - p.x, s.z - p.z) <= this._world.shop.interactRadius;
  }

  private _heightAt(x: number, z: number): number {
    return this._terrain.heightAt(x, z);
  }

  /** Copy the original pathing map into the nav grid (rows flip: wpm row 0 = south). */
  private _applyPathingToNav(): void {
    const pathing = this._map.pathing;
    for (let gz = 0; gz < pathing.height; gz++) {
      const row = pathing.height - 1 - gz;
      for (let gx = 0; gx < pathing.width; gx++) {
        this._navGrid.setWalkable(gx, gz, isCellWalkable(pathing, gx, row));
      }
    }
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
  }

  private _updateNetwork(dt: number): void {
    // ── Camera ──
    this._updateCamera(dt);

    // ── Send pending inputs to server ──
    for (const cmd of this._pendingCommands) {
      this._network?.sendInput(cmd);
    }
    this._pendingCommands = [];

    // ── Drain snapshots and apply the latest ──
    const snaps = this._network?.drainSnapshots() ?? [];
    for (const snap of snaps) {
      this._applySnapshot(snap);
    }

    // ── Drain events ──
    const evts = this._network?.drainEvents() ?? [];
    for (const evMsg of evts) {
      this._handleEvent(evMsg.event, dt);
    }

    // ── Sync views ──
    this._syncAllViews(dt);

    // ── Fog ──
    this._fog.update(dt);
    this._fogLayer.update(dt);
    this._applyFogVisibility();

    // ── Misc ──
    this._floatingText.update(dt, this._camera.camera);
    this._water.update(dt);
  }

  private _updateCamera(dt: number): void {
    const pan = this._input.edgePan;
    if (pan.length() > 0) {
      this._cameraLocked = false;
      const speed = 900 * dt;
      this._camera.panScreen(pan.x * speed, pan.z * speed);
    } else if (this._cameraLocked && this._playerState) {
      this._camera.follow(new THREE.Vector3(
        this._playerState.pos.x,
        this._heightAt(this._playerState.pos.x, this._playerState.pos.z),
        this._playerState.pos.z,
      ));
    }
    const focus = this._camera.focus;
    this._camera.setFocusY(this._heightAt(focus.x, focus.z));
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
        // Muzzle flash on the shooter's view
        const shooterView = this._heroViews.get(ev.heroId);
        shooterView?.flashFire();
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
    const cdProgress = p.abilityCooldown <= 0 ? 1
      : 1 - p.abilityCooldown / ARROW.cooldownByLevel[Math.min(p.abilityLevel, 4)];
    this._spellBar.update(cdProgress, p.abilityLevel, p.skillPoints);

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
}
