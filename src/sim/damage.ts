/**
 * Shared damage math for hero-sourced ability hits (arrows and blasts):
 * one crit roll + rune double-damage multiplier, applied identically at
 * every damage site.
 *
 * Also contains the unified damage-application functions that replaced
 * the triplicated hero→hero, creep→hero, and hero→creep codepaths, plus
 * kill, XP, and reward helpers that were scattered across stepMatch and
 * stepCreeps.
 */
import { CRIT_MULTIPLIER } from './shopItems';
import { CreepState, HeroState, MatchState, SimEvent } from './state';
import { runeDamageMultiplier } from './stepRunes';
import { creepGold, creepXp, CREEP } from './creepRules';
import {
  HERO,
  KILL_GOLD,
  KILL_XP_TABLE,
  MULTI_KILL_WINDOW,
  XP_TABLE,
  BOUNTY_TABLE,
  SPREE_BONUS,
} from './rules';

/**
 * Roll the final damage of a hero-sourced hit: crit chance (doubling on
 * success) and the source's rune damage multiplier. Consumes at most one
 * `rng()` call, and only when the source has any crit chance.
 */
export function rollAbilityDamage(
  source: HeroState,
  base: number,
  rng: () => number,
): { damage: number; crit: boolean } {
  const crit = source.critChance > 0 && rng() < source.critChance;
  const damage = (crit ? base * CRIT_MULTIPLIER : base) * runeDamageMultiplier(source);
  return { damage, crit };
}

// ── Burn damage-over-time (Fire Bow) ─────────────────────────────────

/** Seconds between discrete burn damage applications (keeps events sparse). */
export const BURN_TICK_INTERVAL = 0.5;

/**
 * A unit carrying a Fire Bow burn. Both `HeroState` and `CreepState` satisfy
 * this shape. The burn is a *pool*: `burnRemaining` is total damage still owed,
 * drained at `burnDps`. Fresh hits add to the pool and stack (see the Fire Bow
 * `onProjectileHitHero`), so total burn always equals the sum of every hit's
 * contribution — nothing is lost or double-counted no matter the timing.
 */
export interface Burnable {
  alive: boolean;
  burnRemaining: number;
  burnDps: number;
  burnTickAccum: number;
}

/**
 * Advance a unit's burn by `dt`, draining the damage pool in fixed
 * `BURN_TICK_INTERVAL` chunks via the `deal` callback — which routes through
 * the caller's damage function so kills, gold, and hit events fire exactly as a
 * direct hit would. No-op when not burning. Each chunk is clamped to what's
 * left, so the pool always drains to exactly zero.
 */
export function stepBurn(target: Burnable, dt: number, deal: (damage: number) => void): void {
  if (target.burnRemaining <= 0) return;
  target.burnTickAccum += dt;

  while (target.burnTickAccum >= BURN_TICK_INTERVAL && target.burnRemaining > 0) {
    target.burnTickAccum -= BURN_TICK_INTERVAL;
    const chunk = Math.min(target.burnDps * BURN_TICK_INTERVAL, target.burnRemaining);
    target.burnRemaining -= chunk;
    if (target.alive) deal(chunk);
  }
  // Pool emptied — reset the cadence so the next stack starts clean.
  if (target.burnRemaining <= 0) {
    target.burnRemaining = 0;
    target.burnTickAccum = 0;
  }
}

// ── Unified damage application ───────────────────────────────────────

type DamageSource =
  | { kind: 'hero'; hero: HeroState }
  | { kind: 'creep'; creep: CreepState };

/**
 * Apply `damage` to `target` from any source kind. Shared guard, clamp,
 * hit event, and killHero call. The kill-reward block is gated on
 * `source.kind === 'hero'` (creep kills carry no credit).
 *
 * Event order is identical to the pre-unified codepaths:
 *   1. hit event
 *   2. killHero(target)
 *   3. (hero only) kills/gold/xp/multi-kill update
 *   4. kill event
 */
export function dealDamageToHero(
  state: MatchState,
  target: HeroState,
  source: DamageSource,
  damage: number,
  projectileId: string,
  events: SimEvent[],
  crit?: boolean,
): void {
  if (!target.alive || target.invulnerable) return;

  target.hp = Math.max(0, target.hp - damage);
  const sourceId = source.kind === 'hero' ? source.hero.id : source.creep.id;
  const hitEvent: SimEvent = {
    type: 'hit',
    targetId: target.id,
    sourceId,
    projectileId,
    damage,
    x: target.pos.x,
    z: target.pos.z,
  };
  if (crit !== undefined) (hitEvent as any).crit = crit;
  events.push(hitEvent);

  if (target.hp > 0) return;

  // Victim half of death — shared by every path.
  killHero(target);

  // Kill credit: heroes only.
  if (source.kind === 'hero') {
    const hero = source.hero;
    hero.kills++;
    hero.killStreak++;
    const wasFirstBlood = state.firstBlood;
    const gold = awardKillGold(state, hero, target);
    addXp(hero, killXpReward(target, hero), events);
    hero.multiKillTimer = MULTI_KILL_WINDOW;
    hero.multiKillCount++;
    events.push({
      type: 'kill',
      sourceId: hero.id,
      victimId: target.id,
      gold,
      firstBlood: wasFirstBlood || undefined,
      streak: Math.min(hero.killStreak, 9),
      multiKill: Math.min(hero.multiKillCount, 3),
    });
  } else {
    events.push({ type: 'kill', sourceId: source.creep.id, victimId: target.id });
  }
}

/**
 * Apply hero-sourced damage to a creep. Only hero→creep exists (creeps
 * don't fight each other), but the interface takes a source union so a
 * future creep→creep path slots in without changing call sites.
 */
export function dealDamageToCreep(
  state: MatchState,
  creep: CreepState,
  source: { kind: 'hero'; hero: HeroState },
  damage: number,
  events: SimEvent[],
  crit?: boolean,
): void {
  if (!creep.alive) return;

  creep.hp = Math.max(0, creep.hp - damage);
  creep.lastActiveTick = state.tick;
  // Retaliate camp-wide: attacking any creep pulls every idle campmate onto
  // the attacker (leash still bounds the chase), so you can't peel a camp one
  // creep at a time or snipe it risk-free. A leashing creep re-engages too.
  for (const c of state.creeps) {
    if (c.campId !== creep.campId || !c.alive) continue;
    if (c.aggroTargetId === null) {
      c.aggroTargetId = source.hero.id;
      c.leashing = false;
      c.lastActiveTick = state.tick;
    }
  }
  const hitEvent: SimEvent = {
    type: 'creepHit',
    creepId: creep.id,
    sourceId: source.hero.id,
    damage,
    x: creep.pos.x,
    z: creep.pos.z,
  };
  if (crit !== undefined) (hitEvent as any).crit = crit;
  events.push(hitEvent);

  if (creep.hp > 0) return;

  creep.alive = false;
  creep.respawnTimer = CREEP.respawnInterval;
  creep.aggroTargetId = null;
  creep.attackCooldown = 0;

  const gold = creepGold(creep.type, creep.level);
  const xp = creepXp(creep.type, creep.level);
  source.hero.gold += gold;
  addXp(source.hero, xp, events);
  events.push({
    type: 'creepKill',
    creepId: creep.id,
    campId: creep.campId,
    killerId: source.hero.id,
    gold,
    xp,
    x: creep.pos.x,
    z: creep.pos.z,
  });
}

// ── Death & rewards (moved here from stepMatch) ──────────────────────

/**
 * The victim half of a hero death — shared by hero-vs-hero kills and creep
 * kills (which carry no killer rewards).
 */
export function killHero(target: HeroState): void {
  target.alive = false;
  target.respawnTimer = HERO.respawnDelay;
  target.path = [];
  target.moving = false;
  target.deaths++;
  target.killStreak = 0;
  // Cancel any in-progress blink cast.
  target.blinkCastTimer = 0;
  target.blinkTarget = undefined;
}

function awardKillGold(state: MatchState, killer: HeroState, victim: HeroState): number {
  let total = KILL_GOLD.base;

  if (state.firstBlood) {
    state.firstBlood = false;
    total += KILL_GOLD.firstBlood;
  }
  if (killer.killStreak >= 3) {
    total += SPREE_BONUS[Math.min(killer.killStreak, 10)] ?? 7;
  }
  if (victim.killStreak >= 4) {
    total += BOUNTY_TABLE[Math.min(victim.killStreak, 10)] ?? 28;
  }
  if (killer.multiKillCount === 2) total += KILL_GOLD.doubleKill;
  else if (killer.multiKillCount >= 3) total += KILL_GOLD.tripleKill;

  killer.gold += total;
  return total;
}

function killXpReward(victim: HeroState, killer: HeroState): number {
  let xp = KILL_XP_TABLE[Math.min(victim.level, KILL_XP_TABLE.length - 1)];
  if (victim.level > killer.level) xp += (victim.level - killer.level) * 50;
  return xp;
}

export function addXp(hero: HeroState, amount: number, events: SimEvent[]): void {
  hero.xp += amount;
  while (hero.level < HERO.maxLevel && hero.xp >= XP_TABLE[hero.level + 1]) {
    hero.level++;
    hero.hp += HERO.hpPerLevel;
    hero.skillPoints++;
    events.push({ type: 'levelUp', heroId: hero.id, level: hero.level });
  }
}
