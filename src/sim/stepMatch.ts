/**
 * The authoritative game step — pure, headless, deterministic given its
 * inputs. Runs on the server as the source of truth and on the client for
 * local prediction. All gameplay logic that used to live inside `Hero`,
 * `Projectile`, `ArrowAbility`, and `Shop` lives here, operating on plain
 * `MatchState`.
 *
 * Behaviour was ported to match the original single-player game exactly,
 * including a couple of quirks in the kill-reward ordering (noted inline).
 *
 * ── Adding a new unit type ───────────────────────────────────────────
 * 1. Define its state interface in `state.ts`, extending `UnitCore`.
 * 2. Add a per-type array to `MatchState` (heroes[], creeps[], …).
 *    Never merge into one generic list — iteration order must be
 *    deterministic on every peer.
 * 3. Write `create` / `step` / `respawn` helpers (patterns in stepCreeps.ts).
 * 4. Call step helpers from `stepMatch()`; handle death via the unified
 *    `dealDamageToHero` / `dealDamageToCreep` in `damage.ts`.
 * 5. If the unit type needs client views, add per-type diff loops in
 *    `Game.ts` (Phase 6 will extract a generic ViewSync for this).
 */
import * as V from './math';
import {
  ARROW,
  basicRankCap,
  BLAST,
  HERO,
  heroMaxHp,
  PASSIVE_INCOME,
  ultimateRankCap,
  XP_TABLE,
} from './rules';
import {
  ABILITIES,
  ABILITY_ORDER,
  AbilityId,
  cancelArrowWindup,
  stepArrowWindup,
  stopMovement,
} from './abilities';
import {
  Command,
  HeroInput,
  HeroState,
  MatchState,
  ProjectileState,
  SimEvent,
} from './state';
import {
  applyCreepDamage,
  applyCreepDamageToHero,
  stepCreeps,
} from './stepCreeps';
import { CREEP_TYPES } from './creepRules';
import { findRespawnPosition, SimWorld } from './world';
import { ICE_BOW_SLOW_FACTOR, SHOP_ITEMS_BY_ID, addItem, removeItem } from './shopItems';
import { stepRuneBuffs, stepRunes } from './stepRunes';
import { RUNE } from './runeRules';
import { rollAbilityDamage, dealDamageToHero, killHero, addXp } from './damage';
import { advanceProjectile, findHitHero } from './projectiles';
import { turnToward, followPath, computePath } from './movement';

/**
 * Advance the match by `dt` seconds, applying `inputs` queued since the last
 * step. Mutates `state` in place and returns the discrete events that fired
 * this tick (hits, kills, respawns, …) for the render/network layers.
 */
export function stepMatch(
  state: MatchState,
  inputs: HeroInput[],
  dt: number,
  world: SimWorld,
  rng: () => number = Math.random,
): SimEvent[] {
  const events: SimEvent[] = [];

  for (const input of inputs) {
    const hero = state.heroes.find((h) => h.id === input.heroId);
    if (hero) applyCommand(state, hero, input.cmd, world, events);
  }

  for (const hero of state.heroes) {
    stepHero(hero, dt);
    // Resolve any in-progress arrow cast point (spawns the arrow when the
    // wind-up elapses). Runs before stepProjectiles so a just-loosed arrow
    // advances this same tick, like a fireball spawned in stepCreeps.
    stepArrowWindup(state, hero, events, dt);
    if (!hero.alive && hero.respawnTimer <= 0) {
      respawn(hero, findRespawnPosition(world, rng));
      events.push({ type: 'respawn', heroId: hero.id });
    }
  }

  // Creeps step before projectiles so a fireball spawned this tick advances
  // this tick, exactly like a hero arrow fired via command.
  stepCreeps(state, dt, world, events);
  stepProjectiles(state, dt, world, events, rng);
  stepBlasts(state, dt, events, rng);
  stepRunes(state, dt, events, rng);
  stepWards(state, dt);
  stepFountains(state, dt, world);
  stepIncome(state, dt);

  state.tick++;
  return events;
}

// ── Commands ──────────────────────────────────────────────────────────

function applyCommand(
  state: MatchState,
  hero: HeroState,
  cmd: Command,
  world: SimWorld,
  events: SimEvent[],
): void {
  // Any fresh order interrupts an in-progress arrow cast point (the shot is
  // aborted, no charge spent) — except re-issuing the arrow itself, which its
  // own guard already rejects while a draw is pending.
  if (!(cmd.type === 'cast' && cmd.ability === 'arrow') && cmd.type !== 'levelAbility') {
    cancelArrowWindup(hero);
  }

  switch (cmd.type) {
    case 'moveTo':
      setDestination(hero, cmd.x, cmd.z, world);
      break;
    case 'cast':
      ABILITIES[cmd.ability]?.cast({ state, hero, world, events, x: cmd.x, z: cmd.z });
      break;
    case 'buy':
      buy(hero, cmd.itemIndex, world, events);
      break;
    case 'useItem':
      useItem(hero, cmd.slot, state, world, events, cmd.x, cmd.z);
      break;
    case 'levelAbility':
      spendSkillPoint(hero, cmd.ability);
      break;
  }
}

function setDestination(hero: HeroState, x: number, z: number, world: SimWorld): void {
  if (!hero.alive) return;
  // Unwalkable/unreachable targets snap to the nearest reachable cell inside
  // computePath (cliff, tree, fogged terrain) — same helper the creeps use, so
  // server sim and client prediction stay in step.
  hero.path = computePath(world, hero.pos, { x, z });
  hero.moving = hero.path.length > 0;
}

function buy(hero: HeroState, index: number, world: SimWorld, events: SimEvent[]): void {
  const shop = world.shop;
  if (index < 0 || index >= shop.items.length) return;
  if (V.distance(shop.pos, hero.pos) > shop.interactRadius) return;

  // Buying an item interrupts movement (WC3: issuing any order stops the current one).
  stopMovement(hero);
  const item = shop.items[index];
  if (hero.gold < item.cost) return;

  // Consumables (tomes): apply stats immediately, no inventory slot.
  if (item.consumable) {
    hero.gold -= item.cost;
    item.apply(hero);
    events.push({ type: 'purchase', heroId: hero.id, itemId: item.id });
    return;
  }

  const owned = hero.inventory.includes(item.id);
  if (owned && !item.stackable) return;
  if (!owned && addItem(hero, item.id) === -1) return; // inventory full
  hero.gold -= item.cost;
  item.apply(hero);
  events.push({ type: 'purchase', heroId: hero.id, itemId: item.id });
}

/** Use the item in a specific inventory slot (hotkey 1–6). */
function useItem(
  hero: HeroState,
  slot: number,
  state: MatchState,
  world: SimWorld,
  events: SimEvent[],
  x?: number,
  z?: number,
): void {
  if (!hero.alive) return;
  if (slot < 0 || slot >= hero.inventory.length) return;
  const itemId = hero.inventory[slot];
  if (!itemId) return;

  // Using any item interrupts movement (matches old behaviour).
  stopMovement(hero);

  const def = SHOP_ITEMS_BY_ID[itemId];
  if (!def?.use) return;

  // Check readiness generically: cooldown, then any extra gate (ward charges).
  const cd = def.use.cooldown;
  if (cd && (hero.itemCooldowns[itemId] ?? 0) > 0) return;
  if (def.use.canUse && !def.use.canUse(hero)) return;

  // Dispatch through the registry — the execute callback handles everything.
  def.use.execute({ state, hero, world, events, x, z });
}

function spendSkillPoint(hero: HeroState, ability: AbilityId): void {
  if (hero.skillPoints <= 0) return;
  const def = ABILITIES[ability];
  if (!def) return;

  // MOBA-style gates: basics (Q/W/E) capped at ceil(level/2), the ultimate
  // (R) unlocks ranks at hero levels 6/11/16. Points bank until spendable.
  const cap = def.kind === 'ultimate'
    ? ultimateRankCap(hero.level)
    : Math.min(basicRankCap(hero.level), 5);
  const runtime = hero.abilities[ability];
  if (runtime.level >= def.maxLevel || runtime.level >= cap) return;
  runtime.level++;
  hero.skillPoints--;
}

// ── Hero step ─────────────────────────────────────────────────────────

function stepHero(hero: HeroState, dt: number): void {
  if (!hero.alive) {
    hero.respawnTimer -= dt;
    return;
  }

  if (hero.multiKillTimer > 0) {
    hero.multiKillTimer -= dt;
    if (hero.multiKillTimer <= 0) hero.multiKillCount = 0;
  }

  // Ability timers (cooldowns, charge recharge, active windows) tick through
  // the registry — one loop, fixed ABILITY_ORDER on every peer.
  for (const id of ABILITY_ORDER) {
    ABILITIES[id].tick(hero, dt);
  }

  // Item cooldowns (blink dagger, future active items). Plain string keys
  // iterate in insertion order — identical on every peer.
  for (const itemId in hero.itemCooldowns) {
    if (hero.itemCooldowns[itemId] > 0) {
      hero.itemCooldowns[itemId] = Math.max(0, hero.itemCooldowns[itemId] - dt);
    }
  }

  if (hero.invulnerable) {
    hero.invulnerableTimer -= dt;
    if (hero.invulnerableTimer <= 0) hero.invulnerable = false;
  }

  stepRuneBuffs(hero, dt);

  if (hero.slowTimer > 0) {
    hero.slowTimer = Math.max(0, hero.slowTimer - dt);
  }

  if (hero.moving && hero.path.length > 0) {
    followPath(hero, dt, {
      speed: heroSpeed(hero),
      arriveEpsilon: HERO.arriveEpsilon,
      facingMode: 'smooth',
    });
  }
  // followPath doesn't touch `moving`; clear it once the path is exhausted
  // (covers both the just-emptied and already-empty cases).
  if (hero.path.length === 0) hero.moving = false;

  updateFacing(hero, dt);
}

function updateFacing(hero: HeroState, dt: number): void {
  hero.facing = turnToward(hero.facing, hero.targetFacing, HERO.turnSpeed, dt);
}

function respawn(hero: HeroState, pos: V.Vec2): void {
  hero.pos = { x: pos.x, z: pos.z };
  hero.hp = heroMaxHp(hero.level, hero.bonusHp);
  hero.alive = true;
  hero.invulnerable = true;
  hero.invulnerableTimer = HERO.respawnInvuln;
  hero.respawnTimer = 0;
  hero.path = [];
  hero.moving = false;
  // Rune buffs and debuffs don't survive death.
  hero.ddTimer = 0;
  hero.hasteTimer = 0;
  hero.invisTimer = 0;
  hero.slowTimer = 0;
}

// ── Projectiles ───────────────────────────────────────────────────────

function stepProjectiles(
  state: MatchState,
  dt: number,
  world: SimWorld,
  events: SimEvent[],
  rng: () => number,
): void {
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const p = state.projectiles[i];
    // Scout projectiles are vision-only: they fly over obstacles (null world
    // skips collision) and pass through every unit, expiring only at range.
    const flight = advanceProjectile(p, dt, p.kind === 'scout' ? null : world, ARROW.collisionRadius);
    if (flight !== 'flying') {
      state.projectiles.splice(i, 1);
      continue;
    }
    if (p.kind === 'scout') continue;

    if (p.ownerKind === 'creep') {
      // Creep fireball: hits any hero (no owner-skip), never hits creeps.
      const target = findHitHero(state, p);
      if (target) {
        const creep = state.creeps.find((c) => c.id === p.ownerId);
        state.projectiles.splice(i, 1);
        if (creep) applyCreepDamageToHero(state, target, p.damage, creep, p.id, events);
      }
      continue;
    }

    // Hero arrow: pierces. It keeps flying (retiring only at range or on an
    // obstacle, handled above) and damages every enemy it overlaps once —
    // tracked in `hitIds` — matching the original's thick, non-terminating
    // arrow. Heroes are damaged before creeps so a shot through a dodging
    // hero can still reach the creep behind them.
    const source = state.heroes.find((h) => h.id === p.ownerId);
    if (!source) continue;
    const hitIds = (p.hitIds ??= []);

    for (const hero of state.heroes) {
      if (hero.id === p.ownerId) continue;
      if (!hero.alive || hero.invulnerable) continue;
      if (hero.abilities.dodge.active) continue; // dodge evades — don't mark as hit
      if (hitIds.includes(hero.id)) continue;
      const r = HERO.bodyRadius + ARROW.collisionRadius;
      if (V.distanceSq(p.pos, hero.pos) >= r * r) continue;
      hitIds.push(hero.id);
      // On-hit item hooks (ice bow slow, …) in inventory slot order.
      for (const slotItemId of source.inventory) {
        if (!slotItemId) continue;
        SHOP_ITEMS_BY_ID[slotItemId]?.onProjectileHitHero?.(source, hero);
      }
      const { damage, crit } = rollAbilityDamage(source, p.damage, rng);
      applyDamage(state, hero, source, damage, p.id, events, crit);
    }

    for (const creep of state.creeps) {
      if (!creep.alive) continue;
      if (hitIds.includes(creep.id)) continue;
      const r = CREEP_TYPES[creep.type].bodyRadius + ARROW.collisionRadius;
      if (V.distanceSq(p.pos, creep.pos) >= r * r) continue;
      hitIds.push(creep.id);
      for (const slotItemId of source.inventory) {
        if (!slotItemId) continue;
        SHOP_ITEMS_BY_ID[slotItemId]?.onProjectileHitHero?.(source, creep);
      }
      const { damage, crit } = rollAbilityDamage(source, p.damage, rng);
      applyCreepDamage(state, creep, source, damage, events, crit);
    }
  }
}

// ── Damage, kills, rewards ────────────────────────────────────────────

function applyDamage(
  state: MatchState,
  target: HeroState,
  source: HeroState,
  damage: number,
  projectileId: string,
  events: SimEvent[],
  crit = false,
): void {
  dealDamageToHero(state, target, { kind: 'hero', hero: source }, damage, projectileId, events, crit);
}

/**
 * The victim half of a hero death — shared by hero-vs-hero kills and creep
 * kills (which carry no killer rewards). Moved to damage.ts; re-exported
 * for stepCreeps compat.
 */

export { killHero, addXp } from './damage';

// ── Blasts ──────────────────────────────────────────────────────────────

/** Tick pending blast zones; detonate when the fuse runs out. */
function stepBlasts(state: MatchState, dt: number, events: SimEvent[], rng: () => number): void {
  for (let i = state.blasts.length - 1; i >= 0; i--) {
    const blast = state.blasts[i];
    blast.timer -= dt;
    if (blast.timer > 0) continue;

    state.blasts.splice(i, 1);
    events.push({
      type: 'blastExplode',
      blastId: blast.id,
      ownerId: blast.ownerId,
      x: blast.pos.x,
      z: blast.pos.z,
    });

    const source = state.heroes.find((h) => h.id === blast.ownerId);
    if (!source) continue;
    const r2 = (BLAST.radius + HERO.bodyRadius) ** 2;

    // Enemy heroes in the circle. The 1.5s fuse is the counterplay — the
    // blast ignores dodge, only invulnerability (respawn) protects.
    for (const hero of state.heroes) {
      if (hero.team === blast.team) continue;
      if (!hero.alive || hero.invulnerable) continue;
      if (V.distanceSq(blast.pos, hero.pos) > r2) continue;
      const { damage, crit } = rollAbilityDamage(source, blast.damage, rng);
      applyDamage(state, hero, source, damage, blast.id, events, crit);
    }

    // Creeps in the circle.
    for (const creep of state.creeps) {
      if (!creep.alive) continue;
      if (V.distanceSq(blast.pos, creep.pos) > r2) continue;
      const { damage, crit } = rollAbilityDamage(source, blast.damage, rng);
      applyCreepDamage(state, creep, source, damage, events, crit);
    }
  }
}

// ── Fountains ───────────────────────────────────────────────────────

/** Heal heroes standing within any fountain's radius. */
function stepFountains(state: MatchState, dt: number, world: SimWorld): void {
  if (world.fountains.length === 0) return;
  for (const hero of state.heroes) {
    const maxHp = heroMaxHp(hero.level, hero.bonusHp);
    if (!hero.alive || hero.hp >= maxHp) continue;
    for (const fountain of world.fountains) {
      if (V.distanceSq(hero.pos, fountain.pos) <= fountain.healRadius * fountain.healRadius) {
        hero.hp = Math.min(maxHp, hero.hp + fountain.healPerSecond * dt);
        break; // one fountain at a time is sufficient
      }
    }
  }
}

// ── Wards & income ────────────────────────────────────────────────────

function stepWards(state: MatchState, dt: number): void {
  for (let i = state.wards.length - 1; i >= 0; i--) {
    const ward = state.wards[i];
    ward.life -= dt;
    if (ward.life <= 0) state.wards.splice(i, 1);
  }
}

function stepIncome(state: MatchState, dt: number): void {
  state.incomeAccumulator += dt;
  while (state.incomeAccumulator >= 1.0) {
    state.incomeAccumulator -= 1.0;
    for (const hero of state.heroes) {
      if (hero.alive) hero.gold += passiveIncome(hero);
    }
  }
}

// ── Derived helpers (shared with the view layer) ──────────────────────

export function heroSpeed(hero: HeroState): number {
  const speed = HERO.baseSpeed + hero.speedBonus + (hero.hasteTimer > 0 ? RUNE.hasteSpeedBonus : 0);
  return hero.slowTimer > 0 ? speed * ICE_BOW_SLOW_FACTOR : speed;
}

export function passiveIncome(hero: HeroState): number {
  // ~1 gold/sec baseline. Heroes far behind (many deaths, few kills) get a
  // modest catch-up boost, capped at PASSIVE_INCOME.max.
  const raw = (hero.deaths * 2) / Math.max(1, hero.kills);
  return Math.max(PASSIVE_INCOME.min, Math.min(PASSIVE_INCOME.max, Math.round(raw)));
}

export function xpForLevel(level: number): number {
  return XP_TABLE[Math.min(level, HERO.maxLevel)] ?? XP_TABLE[XP_TABLE.length - 1];
}

// ── Inventory helpers ─────────────────────────────────────────────────
// (Live in the item registry now — re-exported for existing importers.)
export { addItem, removeItem };
