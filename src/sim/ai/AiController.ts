/**
 * Per-hero AI orchestrator for offline mode.
 *
 * The controller is a *pure command producer*: `think(state, world, dt)`
 * reads the authoritative `MatchState` (perfect information — it ignores fog)
 * and returns the `HeroInput[]` its hero would issue this frame, which the
 * caller appends to the same `inputs` array `stepMatch` already drains. No sim
 * changes, no new state, no protocol — see `docs/ai-opponent-plan.md`.
 *
 * Two cadences run inside `think`:
 *   • Threat responses (dodge / sidestep / blast evacuation) every frame —
 *     timing is frame-critical and the checks are cheap (no pathfinding).
 *   • The macro FSM + micro combat at ~10 Hz — `moveTo` triggers pathfinding
 *     and line-of-fire sampling, so we throttle it.
 *
 * All decisions are pure functions of `(state, world, throttle timers)`; the
 * only randomness (jink direction) comes from an injected `rng`, so headless
 * harness runs are reproducible.
 */
import * as V from '../math';
import { ARROW, BLAST, HERO, maxHpForLevel } from '../rules';
import type { Command, CreepState, HeroInput, HeroState, MatchState, RuneState } from '../state';
import { type SimWorld, findWalkableNear } from '../world';
import { ABILITIES, canCast } from '../abilities';
import { CREEP_TYPES } from '../creepRules';
import { BLINK_RANGE } from '../shopItems';
import { hasLineOfFire, heroVelocity, solveIntercept } from './aim';
import { blastDangerFor, fightWinMargin, incomingArrowThreat } from './threat';
import { nextAbilityToLevel, nextShopItem } from './build';

type Mode = 'FIGHT' | 'CHASE' | 'FLEE' | 'RUNE' | 'SHOP' | 'FARM';

/** Difficulty knobs — all default to maximum strength (see plan §5). */
export interface AiOptions {
  /** Seconds between macro/micro decisions (threat response is always per-frame). */
  thinkInterval?: number;
  /** Injected RNG for jink direction; defaults to `Math.random`. */
  rng?: () => number;
}

// ── Tuning constants ──────────────────────────────────────────────────
/** Fraction of hp below which the bot disengages to heal. */
const LOW_HP_FRAC = 0.35;
/** Re-path only when the destination moved more than this (world units). */
const REPATH_DIST = 64;
/** Range safety margin subtracted from max arrow range when gating shots. */
const FIRE_MARGIN = 120;
/** Fraction of max arrow range the kite band tries to hold. */
const KITE_BAND = 0.7;
/** Dodge when the soonest arrow will connect within this many seconds. */
const DODGE_LEAD = 0.15;

/** Commands are filtered through these flags after the threat pass runs. */
interface ThreatOutcome {
  /** A defensive relocation owns movement this frame — macro must not move. */
  skipMove: boolean;
  /** Survival takes priority — macro must not fire (casting roots movement). */
  skipCast: boolean;
}

export class AiController {
  private readonly _heroId: string;
  private readonly _thinkInterval: number;
  private readonly _rng: () => number;

  private _accum = 0;
  private _mode: Mode = 'FARM';
  /** Last destination handed to a `moveTo` — dedupes re-pathing. */
  private _lastDest: V.Vec2 | null = null;
  /** Jink side for kiting, flipped occasionally so shots are hard to lead. */
  private _jinkSign = 1;
  private _jinkTimer = 0;

  constructor(heroId: string, opts: AiOptions = {}) {
    this._heroId = heroId;
    this._thinkInterval = opts.thinkInterval ?? 0.1;
    this._rng = opts.rng ?? Math.random;
  }

  get mode(): Mode {
    return this._mode;
  }

  /**
   * Produce this hero's commands for the frame. Safe to call every frame; the
   * macro layer self-throttles to `thinkInterval`.
   */
  think(state: MatchState, world: SimWorld, dt: number): HeroInput[] {
    const hero = state.heroes.find((h) => h.id === this._heroId);
    if (!hero || !hero.alive) {
      this._lastDest = null;
      this._accum = 0;
      return [];
    }

    const out: Command[] = [];

    // ── Frame-critical threat responses ──
    const threat = this._respondToThreats(state, world, hero, out);

    // ── Throttled macro + micro ──
    this._accum += dt;
    this._jinkTimer += dt;
    if (this._accum >= this._thinkInterval) {
      this._accum = 0;
      this._decide(state, world, hero, threat, out);
    }

    return out.map((cmd) => ({ heroId: this._heroId, cmd }));
  }

  // ── Threat layer (every frame) ──────────────────────────────────────

  private _respondToThreats(
    state: MatchState,
    world: SimWorld,
    hero: HeroState,
    out: Command[],
  ): ThreatOutcome {
    // Standing in an enemy blast: walk straight out. Nothing else matters.
    const blast = blastDangerFor(state, hero);
    if (blast) {
      const exit = V.normalize(V.sub(hero.pos, blast.pos));
      const dir = V.length(exit) < 0.01 ? { x: 1, z: 0 } : exit;
      const target = V.add(blast.pos, V.scale(dir, BLAST.radius + HERO.bodyRadius + 80));
      this._moveTo(world, hero, target, out, true);
      return { skipMove: true, skipCast: true };
    }

    // Incoming arrow: dodge if we can time it, else sidestep out of the line.
    const dodgeRank = hero.abilities.dodge.level;
    if (dodgeRank >= 1 && canCast(ABILITIES.dodge, hero)) {
      const threat = incomingArrowThreat(state, hero);
      if (threat && threat.timeToImpact <= DODGE_LEAD) {
        out.push({ type: 'cast', ability: 'dodge' });
        // Dodge stops movement; let the macro re-issue a fresh kite step.
        this._lastDest = null;
        return { skipMove: false, skipCast: false };
      }
    } else {
      // Dodge unavailable: sidestep works only with enough lead time to clear
      // the corridor (arrows are fast). Widen the corridor so we react early.
      const threat = incomingArrowThreat(state, hero, HERO.bodyRadius);
      if (threat && threat.timeToImpact > 0.2 && threat.timeToImpact < 1.0) {
        const p = threat.projectile;
        const rel = V.sub(hero.pos, p.pos);
        const along = rel.x * p.dir.x + rel.z * p.dir.z;
        const lateral = V.sub(rel, V.scale(p.dir, along));
        const escape = V.length(lateral) > 1
          ? V.normalize(lateral)
          : { x: p.dir.z, z: -p.dir.x }; // exactly on the line → either side
        const target = V.add(hero.pos, V.scale(escape, 300));
        this._moveTo(world, hero, target, out, true);
        return { skipMove: true, skipCast: true };
      }
    }

    return { skipMove: false, skipCast: false };
  }

  // ── Decision layer (throttled) ──────────────────────────────────────

  private _decide(
    state: MatchState,
    world: SimWorld,
    hero: HeroState,
    threat: ThreatOutcome,
    out: Command[],
  ): void {
    // Spend a skill point if one is banked and spendable.
    const ability = nextAbilityToLevel(hero);
    if (ability) out.push({ type: 'levelAbility', ability });

    const enemy = this._nearestEnemy(state, hero);
    this._mode = this._pickMode(state, world, hero, enemy);

    switch (this._mode) {
      case 'FIGHT':
        this._doFight(state, world, hero, enemy!, threat, out);
        break;
      case 'CHASE':
        this._doChase(state, world, hero, enemy!, threat, out);
        break;
      case 'FLEE':
        this._doFlee(state, world, hero, enemy, threat, out);
        break;
      case 'RUNE':
        this._doRune(state, world, hero, threat, out);
        break;
      case 'SHOP':
        this._doShop(world, hero, threat, out);
        break;
      case 'FARM':
        this._doFarm(state, world, hero, threat, out);
        break;
    }
  }

  // ── Macro scoring ───────────────────────────────────────────────────

  private _pickMode(
    state: MatchState,
    world: SimWorld,
    hero: HeroState,
    enemy: HeroState | null,
  ): Mode {
    const arrowRange = this._arrowRange(hero);
    const hpFrac = hero.hp / maxHpForLevel(hero.level);
    const enemyDist = enemy ? V.distance(hero.pos, enemy.pos) : Infinity;
    const enemyEngageable = !!enemy && !enemy.invulnerable;
    const margin = enemy ? fightWinMargin(hero, enemy) : 0;
    const safe = !enemy || !enemy.alive || (enemyDist > arrowRange * 1.3 && hpFrac >= LOW_HP_FRAC);

    const scores: Record<Mode, number> = {
      FIGHT: -1,
      CHASE: -1,
      FLEE: -1,
      RUNE: -1,
      SHOP: -1,
      FARM: 1, // always-available fallback
    };

    // FLEE / HEAL — losing the fight, or simply too low to stay out.
    if (hpFrac < LOW_HP_FRAC) scores.FLEE = 4.5 + (LOW_HP_FRAC - hpFrac);
    if (enemyEngageable && enemyDist < arrowRange * 1.2 && margin < 0) {
      scores.FLEE = Math.max(scores.FLEE, 4);
    }

    // FIGHT — winnable and in range.
    if (enemyEngageable && hpFrac >= LOW_HP_FRAC && enemyDist <= arrowRange * 1.1 && margin >= 0) {
      scores.FIGHT = 4;
    }

    // CHASE — winnable but out of range (and worth the run).
    if (
      enemyEngageable && hpFrac >= LOW_HP_FRAC &&
      margin >= 0.5 && enemyDist > arrowRange * 0.9 && enemyDist < arrowRange * 2.2
    ) {
      scores.CHASE = 3;
    }

    // RUNE — grab a worthwhile power-up when it's safe to detour.
    if (safe && this._bestRune(state, hero)) scores.RUNE = 3.2;

    // SHOP — buy the next item when affordable and safe.
    const pick = nextShopItem(hero);
    if (safe && pick && hero.gold >= pick.cost) scores.SHOP = 2;

    // Hysteresis: bias toward the current mode to stop it flapping.
    scores[this._mode] += 0.75;

    let best: Mode = 'FARM';
    for (const m of Object.keys(scores) as Mode[]) {
      if (scores[m] > scores[best]) best = m;
    }
    // Guard modes that need an enemy but lost theirs mid-frame.
    if ((best === 'FIGHT' || best === 'CHASE') && !enemyEngageable) best = 'FARM';
    return best;
  }

  // ── Behaviours ──────────────────────────────────────────────────────

  private _doFight(
    state: MatchState,
    world: SimWorld,
    hero: HeroState,
    enemy: HeroState,
    threat: ThreatOutcome,
    out: Command[],
  ): void {
    // Blast the enemy when it can't reasonably escape the 1.5s fuse.
    this._maybeBlast(state, hero, enemy, out);

    if (!threat.skipCast) this._tryShootHero(world, hero, enemy, out);
    if (!threat.skipMove) this._kite(world, hero, enemy, out);
  }

  private _doChase(
    _state: MatchState,
    world: SimWorld,
    hero: HeroState,
    enemy: HeroState,
    threat: ThreatOutcome,
    out: Command[],
  ): void {
    const dist = V.distance(hero.pos, enemy.pos);
    const arrowRange = this._arrowRange(hero);

    // Fire opportunistically — the enemy may already be at the range edge.
    if (!threat.skipCast) this._tryShootHero(world, hero, enemy, out);

    if (!threat.skipMove) {
      // Blink to close the gap and lock in the kill when the dagger is up.
      if (dist > arrowRange && this._blinkReady(hero)) {
        const dir = V.normalize(V.sub(enemy.pos, hero.pos));
        const hop = Math.min(BLINK_RANGE, dist - arrowRange * KITE_BAND);
        if (hop > 100) {
          this._blink(hero, V.add(hero.pos, V.scale(dir, hop)), out);
          return;
        }
      }
      // Otherwise path to where the enemy will be, a short lead ahead.
      const lead = V.add(enemy.pos, V.scale(heroVelocity(enemy), 0.3));
      this._moveTo(world, hero, lead, out, false);
    }
  }

  private _doFlee(
    state: MatchState,
    world: SimWorld,
    hero: HeroState,
    enemy: HeroState | null,
    threat: ThreatOutcome,
    out: Command[],
  ): void {
    if (threat.skipMove) return; // a sidestep/evac already owns movement

    // Defensive blink to break away when an enemy is on top of us.
    if (enemy && this._blinkReady(hero) && V.distance(hero.pos, enemy.pos) < BLINK_RANGE * 1.2) {
      const away = V.normalize(V.sub(hero.pos, enemy.pos));
      const dir = V.length(away) < 0.01 ? { x: 1, z: 0 } : away;
      this._blink(hero, V.add(hero.pos, V.scale(dir, BLINK_RANGE)), out);
      return;
    }

    const fountain = this._nearestFountain(world, hero);
    if (fountain) {
      this._moveTo(world, hero, fountain, out, false);
    } else if (enemy) {
      const away = V.normalize(V.sub(hero.pos, enemy.pos));
      const dir = V.length(away) < 0.01 ? { x: 1, z: 0 } : away;
      this._moveTo(world, hero, V.add(hero.pos, V.scale(dir, 500)), out, false);
    }
  }

  private _doRune(
    state: MatchState,
    world: SimWorld,
    hero: HeroState,
    threat: ThreatOutcome,
    out: Command[],
  ): void {
    const rune = this._bestRune(state, hero);
    if (rune && !threat.skipMove) this._moveTo(world, hero, rune.pos, out, false);
  }

  private _doShop(
    world: SimWorld,
    hero: HeroState,
    threat: ThreatOutcome,
    out: Command[],
  ): void {
    const pick = nextShopItem(hero);
    if (!pick || hero.gold < pick.cost) return;
    // Find nearest shop
    let bestShopIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < world.shops.length; i++) {
      const d = V.distance(hero.pos, world.shops[i].pos);
      if (d < bestDist) { bestDist = d; bestShopIdx = i; }
    }
    if (bestShopIdx < 0) return;
    const shop = world.shops[bestShopIdx];
    if (bestDist <= shop.buyRadius) {
      out.push({ type: 'buy', shopIndex: bestShopIdx, itemIndex: pick.index });
    } else if (!threat.skipMove) {
      const near = findWalkableNear(world, shop.pos.x, shop.pos.z);
      this._moveTo(world, hero, near, out, false);
    }
  }

  private _doFarm(
    state: MatchState,
    world: SimWorld,
    hero: HeroState,
    threat: ThreatOutcome,
    out: Command[],
  ): void {
    const creep = this._nearestCreep(state, hero);
    if (!creep) return;

    const type = CREEP_TYPES[creep.type];
    const arrowRange = this._arrowRange(hero);
    // Stand outside the creep's reach but inside our own range.
    const standoff = Math.min(arrowRange - FIRE_MARGIN, Math.max(type.attackRange + 100, 200));

    if (!threat.skipCast) this._tryShootCreep(world, hero, creep, out);

    if (!threat.skipMove) {
      const dist = V.distance(hero.pos, creep.pos);
      if (!hasLineOfFire(world, hero.pos, creep.pos)) {
        // No shot from here (an obstacle sits between us) — close in and let
        // the pathfinder route around the blocker until the lane clears,
        // instead of freezing at a range band we can't shoot through.
        this._moveTo(world, hero, creep.pos, out, false);
      } else if (Math.abs(dist - standoff) > 60) {
        const away = V.normalize(V.sub(hero.pos, creep.pos));
        const dir = V.length(away) < 0.01 ? { x: 1, z: 0 } : away;
        this._moveTo(world, hero, V.add(creep.pos, V.scale(dir, standoff)), out, false);
      }
    }
  }

  // ── Combat helpers ──────────────────────────────────────────────────

  /** Fire at a hero target with a lead shot, honouring every fire gate. */
  private _tryShootHero(world: SimWorld, hero: HeroState, target: HeroState, out: Command[]): void {
    if (!canCast(ABILITIES.arrow, hero)) return;
    if (target.invulnerable) return; // never shoot respawn-invuln heroes
    if (target.abilities.dodge.active) return; // wait out the dodge window
    this._fireIntercept(world, hero, target.pos, heroVelocity(target), out);
  }

  /** Fire at a (slow, non-dodging) creep. */
  private _tryShootCreep(world: SimWorld, hero: HeroState, creep: CreepState, out: Command[]): void {
    if (!canCast(ABILITIES.arrow, hero)) return;
    this._fireIntercept(world, hero, creep.pos, { x: 0, z: 0 }, out);
  }

  /** Shared intercept-solve + range/LoF gate + cast emission. */
  private _fireIntercept(
    world: SimWorld,
    hero: HeroState,
    targetPos: V.Vec2,
    targetVel: V.Vec2,
    out: Command[],
  ): void {
    const shot = solveIntercept(hero.pos, targetPos, targetVel, ARROW.speed);
    if (!shot) return; // target outruns the arrow → hold fire

    const flightDist = ARROW.speed * shot.time;
    if (flightDist > this._arrowRange(hero) - FIRE_MARGIN) return;
    if (!hasLineOfFire(world, hero.pos, shot.point)) return;

    out.push({ type: 'cast', ability: 'arrow', x: shot.point.x, z: shot.point.z });
    this._lastDest = null; // the cast stopped movement — force a fresh step
  }

  /** Stutter-step kite: hold the range band on our current bearing, with jink. */
  private _kite(world: SimWorld, hero: HeroState, enemy: HeroState, out: Command[]): void {
    const arrowRange = this._arrowRange(hero);
    const desired = V.clamp(arrowRange * KITE_BAND, 300, arrowRange - FIRE_MARGIN);

    // Flip the jink side periodically so the enemy can't pre-aim our lateral drift.
    if (this._jinkTimer > 0.5) {
      this._jinkTimer = 0;
      if (this._rng() < 0.5) this._jinkSign = -this._jinkSign;
    }

    let bearing = V.normalize(V.sub(hero.pos, enemy.pos));
    if (V.length(bearing) < 0.01) bearing = { x: 1, z: 0 };
    const perp = { x: bearing.z * this._jinkSign, z: -bearing.x * this._jinkSign };
    const dir = V.normalize(V.add(bearing, V.scale(perp, 0.5)));
    const target = V.add(enemy.pos, V.scale(dir, desired));
    this._moveTo(world, hero, target, out, false);
  }

  /**
   * Cast R on the enemy when the fuse can realistically land: the target is
   * stationary (shopping / at a fountain / attacking creeps) or slowed. Moving
   * targets can juke the 1.5s delay, so we don't waste the ultimate on them.
   */
  private _maybeBlast(state: MatchState, hero: HeroState, enemy: HeroState, out: Command[]): void {
    if (!canCast(ABILITIES.blast, hero)) return;
    const stationary = !enemy.moving || enemy.slowTimer > 0;
    if (!stationary) return;
    const predicted = V.add(enemy.pos, V.scale(heroVelocity(enemy), BLAST.delay));
    if (V.distance(hero.pos, predicted) > BLAST.castRange) return;
    out.push({ type: 'cast', ability: 'blast', x: predicted.x, z: predicted.z });
    this._lastDest = null;
  }

  // ── Item / movement primitives ──────────────────────────────────────

  private _blinkReady(hero: HeroState): boolean {
    return hero.inventory.includes('blink_dagger') && (hero.itemCooldowns['blink_dagger'] ?? 0) <= 0;
  }

  private _blink(hero: HeroState, target: V.Vec2, out: Command[]): void {
    const slot = hero.inventory.indexOf('blink_dagger');
    if (slot < 0) return;
    out.push({ type: 'useItem', slot, x: target.x, z: target.z });
    this._lastDest = null;
  }

  /**
   * Emit a `moveTo` only when it actually changes the plan: the destination
   * moved more than REPATH_DIST, we were forced (after a cast cleared the
   * path), or the hero has stopped short of the goal. Keeps pathfinding cheap.
   */
  private _moveTo(
    world: SimWorld,
    hero: HeroState,
    dest: V.Vec2,
    out: Command[],
    force: boolean,
  ): void {
    const need =
      force ||
      !this._lastDest ||
      V.distance(dest, this._lastDest) > REPATH_DIST ||
      (!hero.moving && V.distance(hero.pos, dest) > 40);
    if (!need) return;
    out.push({ type: 'moveTo', x: dest.x, z: dest.z });
    this._lastDest = { x: dest.x, z: dest.z };
  }

  // ── Queries ─────────────────────────────────────────────────────────

  private _arrowRange(hero: HeroState): number {
    return ARROW.rangeByLevel[Math.max(1, hero.abilities.arrow.level)];
  }

  private _nearestEnemy(state: MatchState, hero: HeroState): HeroState | null {
    let best: HeroState | null = null;
    let bestD = Infinity;
    for (const h of state.heroes) {
      if (h.team === hero.team || !h.alive) continue;
      const d = V.distanceSq(hero.pos, h.pos);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  private _nearestCreep(state: MatchState, hero: HeroState): CreepState | null {
    let best: CreepState | null = null;
    let bestD = Infinity;
    for (const c of state.creeps) {
      if (!c.alive) continue;
      const d = V.distanceSq(hero.pos, c.pos);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  private _nearestFountain(world: SimWorld, hero: HeroState): V.Vec2 | null {
    let best: V.Vec2 | null = null;
    let bestD = Infinity;
    for (const f of world.fountains) {
      const d = V.distanceSq(hero.pos, f.pos);
      if (d < bestD) {
        bestD = d;
        best = f.pos;
      }
    }
    return best;
  }

  /** Nearest active DD/haste rune worth a detour (ignores invisibility). */
  private _bestRune(state: MatchState, hero: HeroState): RuneState | null {
    let best: RuneState | null = null;
    let bestD = Infinity;
    for (const r of state.runes) {
      if (!r.active) continue;
      if (r.type !== 'doubleDamage' && r.type !== 'haste') continue;
      const d = V.distanceSq(hero.pos, r.pos);
      if (d < bestD && d < 1500 * 1500) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }
}
