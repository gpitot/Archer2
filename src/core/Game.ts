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
import { isCellWalkable } from '../world/wc3/WpmParser';
import { NavGrid } from '../navigation/NavGrid';
import { Pathfinder } from '../navigation/Pathfinder';
import { Hero } from '../entities/Hero';
import { Ward } from '../entities/Ward';
import { FogOfWar } from '../vision/FogOfWar';
import { FogLayer } from '../vision/FogLayer';
import { InputManager } from '../input/InputManager';
import { ProjectilePool } from '../combat/ProjectilePool';
import { ArrowAbility } from '../combat/ArrowAbility';
import { ItemBar } from '../ui/ItemBar';
import { KDDisplay } from '../ui/KDDisplay';
import { ShopWindow } from '../ui/ShopWindow';
import { FloatingTextManager } from '../ui/FloatingText';
import { ShopOverlay } from '../ui/ShopOverlay';
import { GoldDisplay } from '../ui/GoldDisplay';
import { HeroPortrait } from '../ui/HeroPortrait';
import { SpellBar } from '../ui/SpellBar';

const FOG_CELL_SIZE = 40;

/** Ground surface abstraction; Phase 2 swaps the flat stand-in for Wc3Terrain. */
interface GroundProvider {
  mesh: THREE.Object3D;
  heightAt(x: number, z: number): number;
}

export class Game {
  private _loop: GameLoop;
  private _renderer!: Renderer;
  private _scene!: THREE.Scene;
  private _camera!: IsometricCamera;
  private _map!: MapData;
  /** Gameplay is confined to one arena of the map, like the original. */
  private _arena: ArenaRect = ARENA_TERRAIN1;
  private _terrain!: GroundProvider;
  private _hero!: Hero;
  private _heroes: Hero[] = [];
  private _input!: InputManager;
  private _navGrid!: NavGrid;
  private _pathfinder!: Pathfinder;
  private _projectiles!: ProjectilePool;
  private _floatingText = new FloatingTextManager();
  private _obstacleRegistry!: ObstacleRegistry;
  private _fog!: FogOfWar;
  private _fogLayer!: FogLayer;
  private _wards: Ward[] = [];
  private _minimap!: Minimap;
  // League-style camera lock: follow the hero only while locked. Edge-panning
  // or a minimap click unlocks; Space re-centers and re-locks.
  private _cameraLocked = true;
  private _spellBar!: SpellBar;
  private _portrait!: HeroPortrait;
  private _goldDisplay!: GoldDisplay;
  private _itemBar!: ItemBar;
  private _kdDisplay!: KDDisplay;
  private _incomeAccumulator = 0;
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

    // ── Ground (flat stand-in until the WC3 terrain mesher lands) ──
    this._terrain = this._createFlatGround();
    this._scene.add(this._terrain.mesh);
    const heightAt = (x: number, z: number) => this._terrain.heightAt(x, z);

    // ── Navigation (authoritative walkability from the original pathing map) ──
    this._navGrid = new NavGrid(
      this._map.pathing.width,
      this._map.pathing.height,
      PATH_CELL_SIZE,
      bounds.minX,
      bounds.minZ,
    );
    this._applyPathingToNav();
    const pathfinder = new Pathfinder(this._navGrid);
    this._pathfinder = pathfinder;

    // ── Obstacles (doodads register here in a later phase) ──
    this._obstacleRegistry = new ObstacleRegistry();

    // ── Fog of war over the active arena (WC3-style) ──
    this._fog = new FogOfWar(this._arena, FOG_CELL_SIZE, heightAt);
    this._fogLayer = new FogLayer(this._fog, 0); // player team's view
    this._fogLayer.applyTo(this._terrain.mesh);

    // ── Shop (near the arena center, snapped to walkable ground) ──
    const bootsItem: ShopItem = {
      id: 'boots',
      name: 'Boots of Speed',
      cost: 5,
      description: '+60 movement speed',
      apply: (hero) => hero.addSpeedBonus(60),
    };
    const wardsItem: ShopItem = {
      id: 'sentry_wards',
      name: 'Sentry Wards',
      cost: 10,
      description: '5 charges — press W to place a ward granting vision for 300s',
      stackable: true,
      apply: (hero) => hero.addWardCharges(5),
    };
    const shopPos = this._findWalkableNear(this._arena.centerX, this._arena.centerZ);
    this._shop = new Shop(shopPos, [bootsItem, wardsItem]);
    this._shop.mesh.position.y = heightAt(shopPos.x, shopPos.z);
    this._scene.add(this._shop.mesh);
    this._fogLayer.applyTo(this._shop.mesh);

    // ── Shop overlay ──
    this._shopOverlay = new ShopOverlay();

    this._shopWindow = new ShopWindow({
      onBuy: (idx) => this._shop.buy(this._hero, idx),
      onClose: () => {},
    });

    // ── Heroes (spawn on random walkable arena ground) ──
    const heroSpawn = this._findRespawnPosition();
    this._hero = this._createHero(pathfinder, heroSpawn.x, heroSpawn.z, 0);
    this._heroes.push(this._hero);

    const dummySpawn = this._findWalkableNear(heroSpawn.x + 400, heroSpawn.z + 200);
    const dummy = this._createHero(pathfinder, dummySpawn.x, dummySpawn.z, 1);
    const dummyBody = dummy.mesh.getObjectByName('heroBody') as THREE.Mesh;
    (dummyBody.material as THREE.MeshStandardMaterial).color.set(0xcc3333);
    this._heroes.push(dummy);

    // Every hero feeds vision to its own team's fog map (shared team sight).
    for (const hero of this._heroes) this._fog.addSource(hero);
    this._fog.recomputeNow();

    // ── Projectiles ──
    this._projectiles = new ProjectilePool(20, this._obstacleRegistry, () => this._heroes, this._floatingText, heightAt);
    this._scene.add(this._projectiles.group);

    // ── Ability ──
    this._hero.ability = new ArrowAbility(this._hero, this._projectiles);

    // ── Camera (bounds confined to the arena, like the original) ──
    this._camera = new IsometricCamera();
    this._camera.setBounds(this._arena.minX, this._arena.minZ, this._arena.maxX, this._arena.maxZ);
    this._camera.setTarget(this._hero.position);
    this._camera.setFocusY(this._hero.position.y);

    // ── Input ──
    this._input = new InputManager(this._renderer.domElement, this._camera.camera);
    this._input.setGround(this._terrain.mesh);
    this._input.onScroll((deltaY) => this._camera.zoom(deltaY * 0.6));
    this._input.onClick((pos) => {
      // If click near shop, open shop instead of moving
      if (this._shop.canInteract(this._hero.position)) {
        const dx = pos.x - this._shop.position.x;
        const dz = pos.z - this._shop.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < this._shop.interactRadius) {
          this._shopWindow.open(this._shop.items, this._hero.gold, this._hero.inventory);
          return;
        }
      }
      this._hero.setDestination(pos);
    });

    // Q — Shoot Arrow (Ctrl+Q to spend skill point)
    this._input.onKeyDown('KeyQ', () => {
      if (this._input.isKeyDown('ControlLeft') || this._input.isKeyDown('ControlRight')) {
        this._hero.spendSkillPoint();
      } else {
        this._hero.fireAbility(this._input.aimPosition ?? undefined);
      }
    });

    // W — Place a sentry ward (requires charges from the shop)
    this._input.onKeyDown('KeyW', () => this._placeWard());

    // B — Open shop when near
    this._input.onKeyDown('KeyB', () => {
      if (this._shopWindow.visible) {
        this._shopWindow.close();
      } else if (this._shop.canInteract(this._hero.position)) {
        this._shopWindow.open(this._shop.items, this._hero.gold, this._hero.inventory);
      }
    });

    // Escape — close shop
    this._input.onKeyDown('Escape', () => {
      if (this._shopWindow.visible) this._shopWindow.close();
    });

    // Space — re-center camera on hero and resume following
    this._input.onKeyDown('Space', () => {
      this._cameraLocked = true;
    });

    // Number keys 1–6 for quick buy
    for (let i = 1; i <= 6; i++) {
      this._input.onKeyDown(`Digit${i}`, () => {
        if (this._shopWindow.visible) {
          this._shop.buy(this._hero, i - 1);
          this._shopWindow.close();
        }
      });
    }

    // ── Spell bar ──
    this._spellBar = new SpellBar();

    // ── Hero portrait (XP ring + level) ──
    this._portrait = new HeroPortrait();

    // ── Gold display ──
    this._goldDisplay = new GoldDisplay();

    // ── Item bar (6 empty slots) ──
    this._itemBar = new ItemBar();

    // ── K/D display ──
    this._kdDisplay = new KDDisplay();

    // ── Minimap (active arena, baked from original tile data) ──
    this._minimap = new Minimap(this._map, this._arena, 200, 8);
    this._minimap.setFog(this._fog, this._hero.team);
    this._minimap.onClick = (wx, wz) => {
      this._cameraLocked = false;
      this._camera.setTarget(new THREE.Vector3(wx, this._terrain.heightAt(wx, wz), wz));
    };

    window.addEventListener('resize', this._onResize.bind(this));
    this._loop.start();
  }

  get hero(): Hero { return this._hero; }

  /** Flat stand-in ground over the full map bounds (replaced in Phase 2). */
  private _createFlatGround(): GroundProvider {
    const bounds = this._map.bounds;
    const geo = new THREE.PlaneGeometry(bounds.width, bounds.height, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a4a34, roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain';
    mesh.position.set(bounds.centerX, 0, bounds.centerZ);
    mesh.receiveShadow = true;
    return { mesh, heightAt: () => 0 };
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

  private _createHero(pathfinder: Pathfinder, x: number, z: number, team: number): Hero {
    const heightAt = (hx: number, hz: number) => this._terrain.heightAt(hx, hz);
    const hero = new Hero(pathfinder, this._navGrid, 60, heightAt, team);
    hero.mesh.position.set(x, heightAt(x, z) + Hero.GROUND_OFFSET, z);
    this._scene.add(hero.mesh);
    return hero;
  }

  private _onResize(): void {
    this._renderer.resize(window.innerWidth, window.innerHeight);
    this._camera.resize(window.innerWidth, window.innerHeight);
  }

  private update(delta: number): void {
    // Camera: edge-panning unlocks; the camera stays where the player left it
    // until Space re-locks it onto the hero (League-style).
    const pan = this._input.edgePan;
    if (pan.length() > 0) {
      this._cameraLocked = false;
      const speed = 900 * delta;
      this._camera.panScreen(pan.x * speed, pan.z * speed);
    } else if (this._cameraLocked) {
      this._camera.follow(this._hero.position);
    }
    // Keep the camera focus riding on the terrain surface.
    const focus = this._camera.focus;
    this._camera.setFocusY(this._terrain.heightAt(focus.x, focus.z));

    for (const hero of this._heroes) {
      hero.update(delta);
      if (hero.isRespawnReady()) {
        const pos = this._findRespawnPosition();
        hero.respawn(pos);
      }
    }
    this._projectiles.update(delta);
    this._floatingText.update(delta, this._camera.camera);

    // Wards: tick lifetime, remove expired ones
    for (let i = this._wards.length - 1; i >= 0; i--) {
      const ward = this._wards[i];
      ward.update(delta);
      if (ward.expired) {
        this._scene.remove(ward.mesh);
        this._fog.removeSource(ward);
        this._wards.splice(i, 1);
      }
    }

    // Fog of war: recompute team vision, ease the render layer, cull enemies
    this._fog.update(delta);
    this._fogLayer.update(delta);
    this._applyFogVisibility();

    // Passive gold income (1 tick per second per hero)
    this._incomeAccumulator += delta;
    while (this._incomeAccumulator >= 1.0) {
      this._incomeAccumulator -= 1.0;
      if (this._hero.isAlive) {
        this._hero.addGold(this._hero.passiveIncome);
      }
    }
  }

  private _render(_interpolation: number): void {
    this._renderer.render(this._scene, this._camera.camera);

    // Minimap — enemies only appear while inside our team's vision (WC3 rule)
    const playerTeam = this._hero.team;
    const markers = this._heroes
      .filter((h) =>
        h.isAlive &&
        (h.team === playerTeam || this._fog.isVisible(playerTeam, h.position.x, h.position.z)))
      .map((h) => ({
        x: h.position.x,
        z: h.position.z,
        color: h.team === playerTeam ? '#44aaff' : '#ff4444',
        radius: h === this._hero ? 4 : 3,
      }));

    // Own wards
    for (const ward of this._wards) {
      if (ward.team === playerTeam) {
        markers.push({ x: ward.position.x, z: ward.position.z, color: '#66ff88', radius: 2 });
      }
    }

    // Shop marker
    markers.push({
      x: this._shop.position.x, z: this._shop.position.z,
      color: '#ffcc44', radius: 4,
    });

    this._minimap.draw(markers, {
      cx: this._camera.target.x,
      cz: this._camera.target.z,
      halfW: this._camera.viewHalfWidth(),
    });

    // Spell bar cooldowns
    this._spellBar.update(
      this._hero.ability?.cooldownProgress ?? 1,
      this._hero.ability?.level ?? 1,
      this._hero.skillPoints,
    );

    // Hero portrait
    this._portrait.update(
      this._hero.xp,
      Hero.xpForLevel(this._hero.level + 1),
      Hero.xpForLevel(this._hero.level),
      this._hero.level,
      '#4488cc',
    );

    this._goldDisplay.update(this._hero.gold);
    this._itemBar.update(this._hero.inventory, { sentry_wards: this._hero.wardCharges });
    this._kdDisplay.update(this._hero.kills, this._hero.deaths);

    // Shop overlay — show when in range
    if (this._shop.canInteract(this._hero.position)) {
      this._shopOverlay.show(this._shop.items);
    } else {
      this._shopOverlay.hide();
    }
  }

  /** Place a sentry ward at the hero's feet if a charge is available. */
  private _placeWard(): void {
    if (!this._hero.isAlive) return;
    if (!this._hero.consumeWardCharge()) return;
    const pos = this._hero.position;
    const ward = new Ward(
      this._hero.team,
      new THREE.Vector3(pos.x, this._terrain.heightAt(pos.x, pos.z), pos.z),
    );
    this._wards.push(ward);
    this._scene.add(ward.mesh);
    this._fog.addSource(ward);
  }

  /**
   * Show/hide units by the player team's fog (WC3-style pop-in): teammates
   * are always drawn; enemy heroes, wards, and arrows only inside vision.
   */
  private _applyFogVisibility(): void {
    const team = this._hero.team;
    for (const h of this._heroes) {
      if (h.team === team) continue;
      h.mesh.visible = h.isAlive && this._fog.isVisible(team, h.position.x, h.position.z);
    }
    for (const p of this._projectiles.active) {
      p.mesh.visible =
        !p.owner || p.owner.team === team ||
        this._fog.isVisible(team, p.position.x, p.position.z);
    }
    for (const ward of this._wards) {
      ward.mesh.visible =
        ward.team === team ||
        this._fog.isVisible(team, ward.position.x, ward.position.z);
    }
  }

  /**
   * Random walkable position inside the active arena, restricted to the
   * arena's main walkable area (anchored at the shop) so heroes never spawn
   * on isolated pockets like cliff tops or islets.
   */
  private _findRespawnPosition(): THREE.Vector3 {
    const anchor = this._shop.position;
    for (let attempt = 0; attempt < 500; attempt++) {
      const wx = this._arena.minX + Math.random() * this._arena.width;
      const wz = this._arena.minZ + Math.random() * this._arena.height;
      const { gx, gz } = this._navGrid.worldToGrid(wx, wz);
      if (this._navGrid.isWalkable(gx, gz) &&
          this._pathfinder.isReachable(wx, wz, anchor.x, anchor.z)) {
        const { wx: cx, wz: cz } = this._navGrid.gridToWorld(gx, gz);
        return new THREE.Vector3(cx, this._terrain.heightAt(cx, cz) + Hero.GROUND_OFFSET, cz);
      }
    }
    return new THREE.Vector3(
      this._arena.centerX,
      this._terrain.heightAt(this._arena.centerX, this._arena.centerZ) + Hero.GROUND_OFFSET,
      this._arena.centerZ,
    );
  }

  /** Nearest walkable cell center to a world position (spiral search). */
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
            return new THREE.Vector3(cx, this._terrain.heightAt(cx, cz), cz);
          }
        }
      }
    }
    return new THREE.Vector3(wx, this._terrain.heightAt(wx, wz), wz);
  }
}
