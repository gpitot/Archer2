import * as THREE from 'three';
import { GameLoop } from './GameLoop';
import { Renderer } from '../rendering/Renderer';
import { createScene } from '../rendering/Scene';
import { createLighting } from '../rendering/Lighting';
import { IsometricCamera } from '../rendering/Camera';
import { Minimap } from '../rendering/Minimap';
import { createTerrain } from '../world/Terrain';
import { HeightMap } from '../world/HeightMap';
import { createObstacles, DEFAULT_OBSTACLES } from '../world/Obstacles';
import { ObstacleRegistry } from '../world/ObstacleRegistry';
import { NavGrid } from '../navigation/NavGrid';
import { Pathfinder } from '../navigation/Pathfinder';
import { Hero } from '../entities/Hero';
import { InputManager } from '../input/InputManager';
import { ProjectilePool } from '../combat/ProjectilePool';
import { ArrowAbility } from '../combat/ArrowAbility';

const ARENA_SIZE = 200;
const HALF = ARENA_SIZE / 2;
const CELL_SIZE = 1;

export class Game {
  private _loop: GameLoop;
  private _renderer!: Renderer;
  private _scene!: THREE.Scene;
  private _camera!: IsometricCamera;
  private _hero!: Hero;
  private _heroes: Hero[] = [];
  private _input!: InputManager;
  private _navGrid!: NavGrid;
  private _heightMap!: HeightMap;
  private _projectiles!: ProjectilePool;
  private _obstacleRegistry!: ObstacleRegistry;
  private _minimap!: Minimap;

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

    // ── Height map ──
    this._heightMap = new HeightMap(ARENA_SIZE, ARENA_SIZE, CELL_SIZE, -HALF, -HALF);

    // ── Terrain ──
    this._scene.add(createTerrain(this._heightMap));

    // ── Navigation (elevation-aware) ──
    this._navGrid = new NavGrid(ARENA_SIZE, ARENA_SIZE, CELL_SIZE, -HALF, -HALF);
    this._navGrid.setHeightMap(this._heightMap);
    const pathfinder = new Pathfinder(this._navGrid);

    // ── Obstacles ──
    this._obstacleRegistry = new ObstacleRegistry();
    this._scene.add(
      createObstacles(DEFAULT_OBSTACLES, this._navGrid, this._obstacleRegistry, this._heightMap),
    );

    // ── Heroes ──
    this._hero = this._createHero(pathfinder, 0, -15);
    this._heroes.push(this._hero);

    // Target dummy
    const dummy = this._createHero(pathfinder, 10, -5);
    const dummyBody = dummy.mesh.getObjectByName('heroBody') as THREE.Mesh;
    (dummyBody.material as THREE.MeshStandardMaterial).color.set(0xcc3333);
    this._heroes.push(dummy);

    // ── Projectiles ──
    this._projectiles = new ProjectilePool(20, this._obstacleRegistry, () => this._heroes);
    this._scene.add(this._projectiles.group);

    // ── Ability ──
    this._hero.ability = new ArrowAbility(this._hero, this._projectiles);

    // ── Camera ──
    this._camera = new IsometricCamera();
    this._camera.setTarget(this._hero.position);

    // ── Input ──
    this._input = new InputManager(this._renderer.domElement, this._camera.camera);
    this._input.onClick((pos) => this._hero.setDestination(pos));
    this._input.onKeyDown('Space', () => this._hero.beginCharge());
    this._input.onKeyUp('Space', () =>
      this._hero.releaseCharge(this._input.aimPosition ?? undefined),
    );

    // ── Minimap ──
    this._minimap = new Minimap(ARENA_SIZE, this._heightMap, this._navGrid);

    window.addEventListener('resize', this._onResize.bind(this));
    this._loop.start();
  }

  get hero(): Hero { return this._hero; }

  private _createHero(pathfinder: Pathfinder, x: number, z: number): Hero {
    const hero = new Hero(pathfinder, this._navGrid);
    const y = this._heightMap.getHeightAt(x, z) + 0.5;
    hero.mesh.position.set(x, y, z);
    this._scene.add(hero.mesh);
    return hero;
  }

  private _onResize(): void {
    this._renderer.resize(window.innerWidth, window.innerHeight);
    this._camera.resize(window.innerWidth, window.innerHeight);
  }

  private update(delta: number): void {
    // ── Edge panning ──
    const pan = this._input.edgePan;
    if (pan.length() > 0) {
      // Pan opposite direction in isometric space:
      // screen-right → camera target moves +X, screen-up → moves +Z
      this._camera.pan(pan.multiplyScalar(25 * delta));
    }

    for (const hero of this._heroes) {
      hero.update(delta);
      if (hero.isRespawnReady()) {
        const pos = this._findRespawnPosition();
        hero.respawn(pos);
      }
    }
    this._projectiles.update(delta);
  }

  private _render(_interpolation: number): void {
    this._renderer.render(this._scene, this._camera.camera);

    // ── Minimap ──
    const markers = this._heroes
      .filter((h) => h.isAlive)
      .map((h, i) => ({
        x: h.position.x,
        z: h.position.z,
        color: i === 0 ? '#44aaff' : '#ff4444',
        radius: i === 0 ? 4 : 3,
      }));

    this._minimap.draw(markers, {
      cx: this._camera.target.x,
      cz: this._camera.target.z,
      halfW: 15, // approximate view half-width
    });
  }

  private _findRespawnPosition(): THREE.Vector3 {
    for (let attempt = 0; attempt < 200; attempt++) {
      const gx = Math.floor(Math.random() * ARENA_SIZE);
      const gz = Math.floor(Math.random() * ARENA_SIZE);
      if (this._navGrid.isWalkable(gx, gz)) {
        const { wx, wz } = this._navGrid.gridToWorld(gx, gz);
        const wy = this._heightMap.getHeightAt(wx, wz) + 0.5;
        return new THREE.Vector3(wx, wy, wz);
      }
    }
    return new THREE.Vector3(0, 0.5, 0);
  }
}
