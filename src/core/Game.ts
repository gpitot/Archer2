import * as THREE from 'three';
import { GameLoop } from './GameLoop';
import { Renderer } from '../rendering/Renderer';
import { createScene } from '../rendering/Scene';
import { createLighting } from '../rendering/Lighting';
import { TopDownCamera } from '../rendering/Camera';
import { Minimap } from '../rendering/Minimap';
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
  private _camera!: TopDownCamera;
  private _hero!: Hero;
  private _heroes: Hero[] = [];
  private _input!: InputManager;
  private _navGrid!: NavGrid;
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
    this._navGrid = new NavGrid(ARENA_SIZE, ARENA_SIZE, CELL_SIZE, -HALF, -HALF);
    const pathfinder = new Pathfinder(this._navGrid);

    // ── Obstacles ──
    this._obstacleRegistry = new ObstacleRegistry();
    this._scene.add(createObstacles(DEFAULT_OBSTACLES, this._navGrid, this._obstacleRegistry));

    // ── Heroes ──
    this._hero = this._createHero(pathfinder, 0, -15);
    this._heroes.push(this._hero);

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
    this._camera = new TopDownCamera();
    this._camera.setTarget(this._hero.position);

    // ── Input ──
    this._input = new InputManager(this._renderer.domElement, this._camera.camera);
    this._input.onClick((pos) => this._hero.setDestination(pos));
    this._input.onKeyDown('Space', () => this._hero.beginCharge());
    this._input.onKeyUp('Space', () =>
      this._hero.releaseCharge(this._input.aimPosition ?? undefined),
    );

    // ── Minimap ──
    this._minimap = new Minimap(ARENA_SIZE, this._navGrid);

    window.addEventListener('resize', this._onResize.bind(this));
    this._loop.start();
  }

  get hero(): Hero { return this._hero; }

  private _createHero(pathfinder: Pathfinder, x: number, z: number): Hero {
    const hero = new Hero(pathfinder, this._navGrid);
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

    // Minimap
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
      halfW: this._camera.viewHalfWidth(),
    });
  }

  private _findRespawnPosition(): THREE.Vector3 {
    for (let attempt = 0; attempt < 200; attempt++) {
      const gx = Math.floor(Math.random() * ARENA_SIZE);
      const gz = Math.floor(Math.random() * ARENA_SIZE);
      if (this._navGrid.isWalkable(gx, gz)) {
        const { wx, wz } = this._navGrid.gridToWorld(gx, gz);
        return new THREE.Vector3(wx, 0.5, wz);
      }
    }
    return new THREE.Vector3(0, 0.5, 0);
  }
}
