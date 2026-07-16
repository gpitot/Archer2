/**
 * Headless simulation harness for scenarios and debugging.
 *
 * Wraps the boilerplate of loading navdata, building a SimWorld, and stepping
 * `stepMatch` at 30 Hz — and records a per-tick JSONL trace (positions, hp,
 * gold, projectiles, events) so failures can be inspected with
 * `pnpm trace <file>` instead of screenshots.
 *
 * Node-only (uses fs); lives under scripts/ so the browser build never sees it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  createMatchState,
  createHeroState,
  Command,
  HeroInput,
  HeroState,
  MatchState,
  SimEvent,
} from '../../src/sim/state';
import { stepMatch } from '../../src/sim/stepMatch';
import { buildSimWorldFromNavdata } from '../../src/sim/buildWorld';
import { SimWorld, sphereHitsObstacle, findWalkableNear } from '../../src/sim/world';
import { buildTestSimWorld } from '../../src/world/testMap';
import { Vec2 } from '../../src/sim/math';
import { ARROW } from '../../src/sim/rules';
import { CreepState } from '../../src/sim/state';
import { CREEP, CreepTypeId } from '../../src/sim/creepRules';
import { createCreep } from '../../src/sim/stepCreeps';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
export const TRACES_DIR = path.resolve(ROOT, 'traces');

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

/** One JSONL line per tick. The client trace uses a compatible shape. */
export interface TraceLine {
  tick: number;
  /** Sim time in seconds. */
  t: number;
  heroes: {
    id: string;
    x: number;
    z: number;
    hp: number;
    alive: boolean;
    gold: number;
    level: number;
    abilityLevel: number;
    abilityCooldown: number;
    abilityCharges: number;
    abilityRecoilTimer: number;
    moving: boolean;
  }[];
  projectiles: { id: string; x: number; z: number; traveled: number }[];
  creeps: {
    id: string;
    x: number;
    z: number;
    hp: number;
    level: number;
    alive: boolean;
    aggro: string | null;
  }[];
  events: SimEvent[];
}

export class SimHarness {
  readonly world: SimWorld;
  readonly state: MatchState;
  readonly trace: TraceLine[] = [];

  private _pendingInputs: HeroInput[] = [];
  private _seed: number;
  private _ticks = 0;

  constructor(opts: { seed?: number; map?: 'arena' | 'test' } = {}) {
    this._seed = opts.seed ?? 42;
    if (opts.map === 'test') {
      // The tiny generated debug map — built in-process, no navdata needed.
      this.world = buildTestSimWorld();
    } else {
      const navdataPath = path.resolve(ROOT, 'assets', 'navdata.json');
      const navdata = JSON.parse(fs.readFileSync(navdataPath, 'utf-8'));
      this.world = buildSimWorldFromNavdata(navdata);
    }
    this.state = createMatchState();
  }

  /** Deterministic RNG passed to stepMatch (LCG, same as smoke-sim). */
  readonly rng = (): number => {
    this._seed = (this._seed * 16807) % 2147483647;
    return (this._seed - 1) / 2147483646;
  };

  get shopPos(): Vec2 {
    return this.world.shop.pos;
  }

  get ticks(): number {
    return this._ticks;
  }

  spawnHero(id: string, team: number, pos: Vec2): HeroState {
    const hero = createHeroState(id, team, pos);
    this.state.heroes.push(hero);
    return hero;
  }

  /** Nearest walkable cell center to a world position. */
  findWalkableNear(x: number, z: number): Vec2 {
    return findWalkableNear(this.world, x, z);
  }

  /** True if an arrow can fly from `a` to `b` without hitting an obstacle. */
  hasLineOfSight(a: Vec2, b: Vec2): boolean {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.ceil(dist / (ARROW.collisionRadius * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      if (sphereHitsObstacle(this.world, p, ARROW.collisionRadius)) return false;
    }
    return true;
  }

  /**
   * Place two heroes ~`dist` apart on walkable ground with a clear arrow line
   * between them — the standard combat-scenario setup.
   */
  spawnDuelists(dist: number): { a: import('../../src/sim/state').HeroState; b: import('../../src/sim/state').HeroState } {
    const shop = this.shopPos;
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const aPos = this.findWalkableNear(shop.x, shop.z);
      const bPos = this.findWalkableNear(
        shop.x + Math.cos(angle) * dist,
        shop.z + Math.sin(angle) * dist,
      );
      const actual = Math.hypot(bPos.x - aPos.x, bPos.z - aPos.z);
      if (actual < dist * 0.5 || actual > dist * 1.5) continue;
      if (!this.hasLineOfSight(aPos, bPos)) continue;
      return { a: this.spawnHero('p1', 0, aPos), b: this.spawnHero('p2', 1, bPos) };
    }
    throw new Error(`spawnDuelists: no clear line of sight at distance ${dist} around the shop`);
  }

  hero(id: string): HeroState {
    const h = this.state.heroes.find((h) => h.id === id);
    if (!h) throw new Error(`no hero '${id}'`);
    return h;
  }

  /**
   * Spawn a creep camp at an explicit position (units spread like
   * `spawnCamps`, snapped to walkable ground). Ids continue `c1, c2, …`
   * across camps. Scenarios that never call this keep a creep-free state.
   */
  spawnCamp(campId: string, pos: Vec2, units: CreepTypeId[]): CreepState[] {
    const created: CreepState[] = [];
    for (let i = 0; i < units.length; i++) {
      const offsetX = (i - (units.length - 1) / 2) * CREEP.spawnSpread;
      const p = findWalkableNear(this.world, pos.x + offsetX, pos.z);
      const creep = createCreep(`c${this.state.creeps.length + 1}`, campId, units[i], p);
      this.state.creeps.push(creep);
      created.push(creep);
    }
    return created;
  }

  creep(id: string): CreepState {
    const c = this.state.creeps.find((c) => c.id === id);
    if (!c) throw new Error(`no creep '${id}'`);
    return c;
  }

  /** Queue a command to be applied on the next tick. */
  issue(heroId: string, cmd: Command): void {
    this._pendingInputs.push({ heroId, cmd });
  }

  /** Advance the sim by `n` ticks, recording a trace line per tick. */
  tick(n = 1): SimEvent[] {
    const all: SimEvent[] = [];
    for (let i = 0; i < n; i++) {
      const inputs = this._pendingInputs;
      this._pendingInputs = [];
      const events = stepMatch(this.state, inputs, DT, this.world, this.rng);
      all.push(...events);
      this._ticks++;
      this.trace.push(this._snapshotLine(events));
    }
    return all;
  }

  /**
   * Tick until `pred` returns true or `maxTicks` elapse. Returns the events
   * accumulated; throws (with the tick range) if the predicate never held.
   */
  runUntil(pred: (state: MatchState, events: SimEvent[]) => boolean, maxTicks: number, what = 'condition'): SimEvent[] {
    const start = this._ticks;
    const all: SimEvent[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const events = this.tick();
      all.push(...events);
      if (pred(this.state, events)) return all;
    }
    throw new Error(`runUntil: ${what} not met within ${maxTicks} ticks (ticks ${start}..${this._ticks})`);
  }

  /** Seconds → ticks helper. */
  seconds(s: number): number {
    return Math.round(s * TICK_RATE);
  }

  /** Write the trace as JSONL and return the file path. */
  writeTrace(name: string): string {
    fs.mkdirSync(TRACES_DIR, { recursive: true });
    const file = path.resolve(TRACES_DIR, `${name}.jsonl`);
    fs.writeFileSync(file, this.trace.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  private _snapshotLine(events: SimEvent[]): TraceLine {
    return {
      tick: this.state.tick,
      t: +(this._ticks * DT).toFixed(4),
      heroes: this.state.heroes.map((h) => ({
        id: h.id,
        x: +h.pos.x.toFixed(2),
        z: +h.pos.z.toFixed(2),
        hp: h.hp,
        alive: h.alive,
        gold: h.gold,
        level: h.level,
        abilityLevel: h.abilityLevel,
        abilityCooldown: +h.abilityCooldown.toFixed(3),
        abilityCharges: h.abilityCharges,
        abilityRecoilTimer: +h.abilityRecoilTimer.toFixed(3),
        moving: h.moving,
      })),
      projectiles: this.state.projectiles.map((p) => ({
        id: p.id,
        x: +p.pos.x.toFixed(2),
        z: +p.pos.z.toFixed(2),
        traveled: +p.traveled.toFixed(2),
      })),
      creeps: this.state.creeps.map((c) => ({
        id: c.id,
        x: +c.pos.x.toFixed(2),
        z: +c.pos.z.toFixed(2),
        hp: c.hp,
        level: c.level,
        alive: c.alive,
        aggro: c.aggroTargetId,
      })),
      events,
    };
  }
}

// ── Assertion helpers ──────────────────────────────────────────────────

export function expectTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`expect: ${msg}`);
}

export function expectNear(actual: number, expected: number, tolerance: number, msg: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`expect: ${msg} — got ${actual}, wanted ${expected} ±${tolerance}`);
  }
}

export function expectEvent(events: SimEvent[], type: SimEvent['type'], msg?: string): SimEvent {
  const ev = events.find((e) => e.type === type);
  if (!ev) throw new Error(`expect: ${msg ?? `event '${type}' fired`} — events seen: [${events.map((e) => e.type).join(', ') || 'none'}]`);
  return ev;
}
