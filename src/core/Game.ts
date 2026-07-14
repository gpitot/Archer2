import * as THREE from 'three';
import { GameLoop } from './GameLoop';
import { Renderer } from '../rendering/Renderer';
import { createScene } from '../rendering/Scene';
import { createLighting } from '../rendering/Lighting';
import { TopDownCamera } from '../rendering/Camera';
import { Minimap } from '../rendering/Minimap';
import { createObstacles, DEFAULT_OBSTACLES } from '../world/Obstacles';
import { Shop, ShopItem } from '../world/Shop';
import { ObstacleRegistry } from '../world/ObstacleRegistry';
import { NavGrid } from '../navigation/NavGrid';
import { Pathfinder } from '../navigation/Pathfinder';
import { Hero } from '../entities/Hero';
import { InputManager } from '../input/InputManager';
import { ProjectilePool } from '../combat/ProjectilePool';
import { ArrowAbility } from '../combat/ArrowAbility';
import { ItemBar } from '../ui/ItemBar';
import { KDDisplay } from '../ui/KDDisplay';
import { ShopWindow } from '../ui/ShopWindow';
import { ShopOverlay } from '../ui/ShopOverlay';
import { GoldDisplay } from '../ui/GoldDisplay';
import { HeroPortrait } from '../ui/HeroPortrait';
import { SpellBar } from '../ui/SpellBar';

const ARENA_SIZE = 4000;
const HALF = ARENA_SIZE / 2;
const CELL_SIZE = 20;

export class Game {
  private _loop: GameLoop;
  private _renderer!: Renderer;
  private _scene!: THREE.Scene;
  private _camera!: TopDownCamera;
  private _hero!: Hero;
  private _heroes: Hero[] = [];
  private _input!: InputManager;
  private _navGrid!: NavGrid;
  private _projectiles!: ProjectilePool;
  private _obstacleRegistry!: ObstacleRegistry;
  private _minimap!: Minimap;
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

  init(): void {
    (window as any).__game = this;

    // ── Renderer ──
    this._renderer = new Renderer();
    this._renderer.resize(window.innerWidth, window.innerHeight);
    document.body.appendChild(this._renderer.domElement);

    // ── Scene ──
    this._scene = createScene();
    createLighting(this._scene);

    // ── Flat ground plane ──
    const groundGeo = new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x3a6b2a,
      roughness: 0.9,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2; // lay flat on XZ
    ground.receiveShadow = true;
    this._scene.add(ground);

    // ── Navigation (flat) ──
    this._navGrid = new NavGrid(ARENA_SIZE / CELL_SIZE, ARENA_SIZE / CELL_SIZE, CELL_SIZE, -HALF, -HALF);
    const pathfinder = new Pathfinder(this._navGrid);

    // ── Obstacles ──
    this._obstacleRegistry = new ObstacleRegistry();
    this._scene.add(createObstacles(DEFAULT_OBSTACLES, this._navGrid, this._obstacleRegistry));

    // ── Shop (bottom-right of arena) ──
    const bootsItem: ShopItem = {
      id: 'boots',
      name: 'Boots of Speed',
      cost: 5,
      description: '+60 movement speed',
      apply: (hero) => hero.addSpeedBonus(60),
    };
    this._shop = new Shop(new THREE.Vector3(400, 0, -900), [bootsItem]);
    this._scene.add(this._shop.mesh);

    // ── Shop overlay ──
    this._shopOverlay = new ShopOverlay();

    this._shopWindow = new ShopWindow({
      onBuy: (idx) => this._shop.buy(this._hero, idx),
      onClose: () => {},
    });

    // ── Heroes ──
    this._hero = this._createHero(pathfinder, 0, -300);
    this._heroes.push(this._hero);

    const dummy = this._createHero(pathfinder, 200, -100);
    const dummyBody = dummy.mesh.getObjectByName('heroBody') as THREE.Mesh;
    (dummyBody.material as THREE.MeshStandardMaterial).color.set(0xcc3333);
    this._heroes.push(dummy);

    // ── Projectiles ──
    this._projectiles = new ProjectilePool(20, this._obstacleRegistry, () => this._heroes);
    this._scene.add(this._projectiles.group);

    // ── Ability ──
    this._hero.ability = new ArrowAbility(this._hero, this._projectiles);

    // ── Camera ──
    this._camera = new TopDownCamera();
    this._camera.setTarget(this._hero.position);

    // ── Input ──
    this._input = new InputManager(this._renderer.domElement, this._camera.camera);
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

    // ── Minimap ──
    this._minimap = new Minimap(ARENA_SIZE, this._navGrid);
    this._minimap.onClick = (wx, wz) => {
      this._camera.setTarget(new THREE.Vector3(wx, 0, wz));
    };

    window.addEventListener('resize', this._onResize.bind(this));
    this._loop.start();
  }

  get hero(): Hero { return this._hero; }

  private _createHero(pathfinder: Pathfinder, x: number, z: number): Hero {
    const hero = new Hero(pathfinder, this._navGrid, 60);
    hero.mesh.position.set(x, 0.5, z);
    this._scene.add(hero.mesh);
    return hero;
  }

  private _onResize(): void {
    this._renderer.resize(window.innerWidth, window.innerHeight);
    this._camera.resize(window.innerWidth, window.innerHeight);
  }

  private update(delta: number): void {
    // Edge panning
    const pan = this._input.edgePan;
    if (pan.length() > 0) {
      this._camera.pan(pan.multiplyScalar(500 * delta));
    }

    for (const hero of this._heroes) {
      hero.update(delta);
      if (hero.isRespawnReady()) {
        const pos = this._findRespawnPosition();
        hero.respawn(pos);
      }
    }
    this._projectiles.update(delta);

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

    // Minimap
    const markers = this._heroes
      .filter((h) => h.isAlive)
      .map((h, i) => ({
        x: h.position.x,
        z: h.position.z,
        color: i === 0 ? '#44aaff' : '#ff4444',
        radius: i === 0 ? 4 : 3,
      }));

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
    this._itemBar.update(this._hero.inventory);
    this._kdDisplay.update(this._hero.kills, this._hero.deaths);

    // Shop overlay — show when in range
    if (this._shop.canInteract(this._hero.position)) {
      this._shopOverlay.show(this._shop.items);
    } else {
      this._shopOverlay.hide();
    }
  }

  private _findRespawnPosition(): THREE.Vector3 {
    const gw = ARENA_SIZE / CELL_SIZE;
    for (let attempt = 0; attempt < 200; attempt++) {
      const gx = Math.floor(Math.random() * gw);
      const gz = Math.floor(Math.random() * gw);
      if (this._navGrid.isWalkable(gx, gz)) {
        const { wx, wz } = this._navGrid.gridToWorld(gx, gz);
        return new THREE.Vector3(wx, 0.5, wz);
      }
    }
    return new THREE.Vector3(0, 0.5, 0);
  }
}
