/**
 * The authoritative game step — pure, headless, deterministic given its
 * inputs. Runs on the server as the source of truth and on the client for
 * local prediction. All gameplay logic that used to live inside `Hero`,
 * `Projectile`, `ArrowAbility`, and `Shop` lives here, operating on plain
 * `MatchState`.
 *
 * Behaviour was ported to match the original single-player game exactly,
 * including a couple of quirks in the kill-reward ordering (noted inline).
 */
import * as V from './math';
import {
  ARROW,
  basicRankCap,
  BLAST,
  BOUNTY_TABLE,
  DODGE,
  HERO,
  KILL_GOLD,
  KILL_XP_TABLE,
  MULTI_KILL_WINDOW,
  PASSIVE_INCOME,
  SCOUT,
  SPREE_BONUS,
  ultimateRankCap,
  WARD,
  XP_TABLE,
} from './rules';
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
  hitCreep,
  stepCreeps,
} from './stepCreeps';
import { findReachableNear, findRespawnPosition, SimWorld, sphereHitsObstacle } from './world';
import { BLINK_COOLDOWN, ICE_BOW_SLOW_DURATION, ICE_BOW_SLOW_FACTOR } from './shopItems';
import { breakInvisibility, stepRuneBuffs, stepRunes } from './stepRunes';
import { RUNE } from './runeRules';
import { rollAbilityDamage } from './damage';
import { advanceProjectile, findHitHero, spawnProjectile } from './projectiles';

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
  switch (cmd.type) {
    case 'moveTo':
      setDestination(hero, cmd.x, cmd.z, world);
      break;
    case 'fire':
      fireArrow(state, hero, cmd.aimX, cmd.aimZ, events);
      break;
    case 'ward':
      placeWard(state, hero, world, cmd.x, cmd.z);
      break;
    case 'blink':
      blink(hero, cmd.x, cmd.z, world);
      break;
    case 'buy':
      buy(hero, cmd.itemIndex, world, events);
      break;
    case 'useItem':
      useItem(hero, cmd.slot, state, world, events);
      break;
    case 'levelAbility':
      spendSkillPoint(hero, cmd.ability);
      break;
    case 'dodge':
      activateDodge(hero);
      break;
    case 'reveal':
      fireScout(state, hero, cmd.aimX, cmd.aimZ, events);
      break;
    case 'blast':
      castBlast(state, hero, cmd.x, cmd.z);
      break;
  }
}

/** Clear movement state so the hero stops wherever they are. */
function stopMovement(hero: HeroState): void {
  hero.path = [];
  hero.moving = false;
}

/**
 * Shared cast preamble: casting interrupts movement, and most casts break
 * invisibility (the scout deliberately doesn't — it's a recon tool).
 */
function beginCast(hero: HeroState, breakInvis: boolean): void {
  stopMovement(hero);
  if (breakInvis) breakInvisibility(hero);
}

/**
 * Normalized aim direction from the hero toward (aimX, aimZ), falling back
 * to the current facing when the aim point sits on the hero.
 */
function aimDir(hero: HeroState, aimX: number, aimZ: number): V.Vec2 {
  const dir = V.sub({ x: aimX, z: aimZ }, hero.pos);
  if (V.length(dir) < 0.01) {
    return { x: Math.sin(hero.facing), z: Math.cos(hero.facing) };
  }
  return V.normalize(dir);
}

function setDestination(hero: HeroState, x: number, z: number, world: SimWorld): void {
  if (!hero.alive) return;
  let path = world.pathfinder.findSmoothedPath(hero.pos.x, hero.pos.z, x, z);
  if (!path || path.length <= 1) {
    // Unwalkable or unreachable target (cliff, tree, fogged terrain): walk
    // to the nearest cell the hero can actually reach instead of ignoring
    // the click. Runs identically in server sim and client prediction.
    const snapped = findReachableNear(world, x, z, hero.pos.x, hero.pos.z);
    if (snapped) {
      path = world.pathfinder.findSmoothedPath(hero.pos.x, hero.pos.z, snapped.x, snapped.z);
    }
  }
  if (path && path.length > 1) {
    // path[0] is the hero's current position — walk the rest.
    hero.path = path.slice(1).map((p) => ({ x: p.wx, z: p.wz }));
    hero.moving = true;
  } else {
    hero.path = [];
    hero.moving = false;
  }
}

function fireArrow(
  state: MatchState,
  hero: HeroState,
  aimX: number,
  aimZ: number,
  events: SimEvent[],
): void {
  if (!hero.alive) return;
  if (hero.abilityLevel < 1) return;
  if (hero.abilityCharges <= 0) return;
  if (hero.abilityRecoilTimer > 0) return;

  // Casting interrupts movement; attacking breaks invisibility.
  beginCast(hero, true);

  // Turn toward the shot (same smoothed turn as movement).
  const dir = aimDir(hero, aimX, aimZ);
  hero.targetFacing = V.heading(dir);

  spawnProjectile(state, events, {
    ownerId: hero.id,
    team: hero.team,
    pos: V.add(hero.pos, V.scale(dir, ARROW.spawnOffset)),
    dir,
    speed: ARROW.speed,
    maxRange: ARROW.rangeByLevel[hero.abilityLevel],
    traveled: 0,
    damage: ARROW.damageByLevel[hero.abilityLevel],
  });
  hero.abilityCharges--;
  hero.abilityRecoilTimer = ARROW.recoilTime;
  // Start recharge if not already ticking; never reset a running recharge.
  if (hero.abilityCharges < ARROW.maxCharges && hero.abilityCooldown <= 0) {
    hero.abilityCooldown = ARROW.cooldownByLevel[hero.abilityLevel];
  }
}

/**
 * E — Scout: fire a damage-free vision projectile toward the aim point. It
 * flies over everything (no obstacle or unit collision) and expires at max
 * range; the client grants fog vision around it while it's in flight.
 */
function fireScout(
  state: MatchState,
  hero: HeroState,
  aimX: number,
  aimZ: number,
  events: SimEvent[],
): void {
  if (!hero.alive) return;
  if (hero.revealLevel < 1) return;
  if (hero.revealCooldown > 0) return;

  // Casting interrupts movement and turns the hero toward the shot. Note:
  // unlike other casts the scout does NOT break invisibility (possible bug,
  // preserved as-is — review separately).
  beginCast(hero, false);
  const dir = aimDir(hero, aimX, aimZ);
  hero.targetFacing = V.heading(dir);

  // Reuses the 'fire' event: it carries the full spawn state, so networked
  // clients (including enemies — the scout is never fog-hidden) simulate the
  // flight deterministically without per-tick re-sends.
  spawnProjectile(state, events, {
    ownerId: hero.id,
    kind: 'scout',
    team: hero.team,
    pos: V.add(hero.pos, V.scale(dir, ARROW.spawnOffset)),
    dir,
    speed: SCOUT.speed,
    maxRange: SCOUT.rangeByLevel[hero.revealLevel],
    traveled: 0,
    damage: 0,
  });
  hero.revealCooldown = SCOUT.cooldownByLevel[hero.revealLevel];
}

function placeWard(
  state: MatchState,
  hero: HeroState,
  world: SimWorld,
  targetX?: number,
  targetZ?: number,
): void {
  if (!hero.alive) return;
  if (hero.wardCharges <= 0) return;

  // Placing a ward interrupts movement.
  stopMovement(hero);

  let pos: V.Vec2;
  if (targetX !== undefined && targetZ !== undefined) {
    // Validate range — reject if the target is too far.
    if (V.distance(hero.pos, { x: targetX, z: targetZ }) > WARD.placeRange + 1) return;
    // Reject placement inside solid obstacles (trees, rocks).
    if (sphereHitsObstacle(world, { x: targetX, z: targetZ }, WARD.placementRadius)) return;
    pos = { x: targetX, z: targetZ };
  } else {
    pos = { x: hero.pos.x, z: hero.pos.z };
  }

  hero.wardCharges--;
  if (hero.wardCharges === 0) removeItem(hero, 'sentry_wards');
  // Placing a ward breaks invisibility.
  breakInvisibility(hero);
  state.wards.push({
    id: `w${state.nextWardId++}`,
    team: hero.team,
    pos,
    life: WARD.duration,
  });
}

function blink(hero: HeroState, tx: number, tz: number, world: SimWorld): void {
  if (!hero.alive) return;
  if (hero.blinkCooldown > 0) return;
  // Snap to nearest walkable, reachable cell.
  const snapped = findReachableNear(world, tx, tz, hero.pos.x, hero.pos.z);
  if (!snapped) return;

  // Teleport instantly — clear movement state.
  stopMovement(hero);
  hero.pos = { x: snapped.x, z: snapped.z };
  hero.blinkCooldown = BLINK_COOLDOWN;
}

function buy(hero: HeroState, index: number, world: SimWorld, events: SimEvent[]): void {
  const shop = world.shop;
  if (index < 0 || index >= shop.items.length) return;
  if (V.distance(shop.pos, hero.pos) > shop.interactRadius) return;

  // Buying an item interrupts movement (WC3: issuing any order stops the current one).
  stopMovement(hero);
  const item = shop.items[index];
  if (hero.gold < item.cost) return;
  const owned = hero.inventory.includes(item.id);
  if (owned && !item.stackable) return;
  if (!owned && addItem(hero, item.id) === -1) return; // inventory full
  hero.gold -= item.cost;
  item.apply(hero);
  events.push({ type: 'purchase', heroId: hero.id, itemId: item.id });
}

/** Use the item in a specific inventory slot (hotkey 1–6). */
function useItem(hero: HeroState, slot: number, state: MatchState, world: SimWorld, events: SimEvent[]): void {
  if (!hero.alive) return;
  if (slot < 0 || slot >= hero.inventory.length) return;
  const itemId = hero.inventory[slot];
  if (!itemId) return;

  // Using an item interrupts movement.
  stopMovement(hero);

  switch (itemId) {
    case 'sentry_wards':
      placeWard(state, hero, world);
      break;
    default:
      // Passive items (e.g. boots) — nothing to do.
      break;
  }
}

function spendSkillPoint(hero: HeroState, ability: 'arrow' | 'dodge' | 'reveal' | 'blast'): void {
  if (hero.skillPoints <= 0) return;

  // MOBA-style gates: basics (Q/W/E) capped at ceil(level/2), the ultimate
  // (R) unlocks ranks at hero levels 6/11/16. Points bank until spendable.
  const basicCap = Math.min(basicRankCap(hero.level), 5);
  switch (ability) {
    case 'arrow':
      if (hero.abilityLevel >= ARROW.maxLevel || hero.abilityLevel >= basicCap) return;
      hero.abilityLevel++;
      break;
    case 'dodge':
      if (hero.dodgeLevel >= DODGE.maxLevel || hero.dodgeLevel >= basicCap) return;
      hero.dodgeLevel++;
      break;
    case 'reveal':
      if (hero.revealLevel >= SCOUT.maxLevel || hero.revealLevel >= basicCap) return;
      hero.revealLevel++;
      break;
    case 'blast':
      if (hero.blastLevel >= BLAST.maxLevel || hero.blastLevel >= ultimateRankCap(hero.level)) return;
      hero.blastLevel++;
      break;
  }
  hero.skillPoints--;
}

/** R — Blast: mark an AoE circle that detonates after a fixed delay. */
function castBlast(state: MatchState, hero: HeroState, x: number, z: number): void {
  if (!hero.alive) return;
  if (hero.blastLevel < 1) return;
  if (hero.blastCooldown > 0) return;
  const target = { x, z };
  if (V.distance(hero.pos, target) > BLAST.castRange + 1) return;

  // Casting interrupts movement, breaks invisibility, and turns the hero
  // toward the target.
  beginCast(hero, true);
  const dir = V.sub(target, hero.pos);
  if (V.length(dir) > 0.01) hero.targetFacing = V.heading(dir);

  hero.blastCooldown = BLAST.cooldownByLevel[hero.blastLevel];
  state.blasts.push({
    id: `b${state.nextBlastId++}`,
    ownerId: hero.id,
    team: hero.team,
    pos: target,
    timer: BLAST.delay,
    damage: BLAST.damageByLevel[hero.blastLevel],
  });
}

function activateDodge(hero: HeroState): void {
  if (!hero.alive) return;
  if (hero.dodgeActive || hero.dodgeCooldown > 0 || hero.dodgeLevel < 1) return;

  // Dodging interrupts movement (and doesn't break invisibility — it's
  // defensive, not an attack).
  beginCast(hero, false);
  hero.dodgeActive = true;
  hero.dodgeTimer = DODGE.durationByLevel[hero.dodgeLevel];
  hero.dodgeCooldown = DODGE.cooldownByLevel[hero.dodgeLevel];
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

  if (hero.abilityRecoilTimer > 0) {
    hero.abilityRecoilTimer = Math.max(0, hero.abilityRecoilTimer - dt);
  }

  if (hero.abilityCooldown > 0) {
    hero.abilityCooldown = Math.max(0, hero.abilityCooldown - dt);
    if (hero.abilityCooldown <= 0 && hero.abilityCharges < ARROW.maxCharges) {
      hero.abilityCharges++;
      if (hero.abilityCharges < ARROW.maxCharges) {
        hero.abilityCooldown = ARROW.cooldownByLevel[Math.max(hero.abilityLevel, 1)];
      }
    }
  }

  if (hero.dodgeActive) {
    hero.dodgeTimer -= dt;
    if (hero.dodgeTimer <= 0) hero.dodgeActive = false;
  }

  if (hero.dodgeCooldown > 0) {
    hero.dodgeCooldown = Math.max(0, hero.dodgeCooldown - dt);
  }

  if (hero.blinkCooldown > 0) {
    hero.blinkCooldown = Math.max(0, hero.blinkCooldown - dt);
  }

  if (hero.blastCooldown > 0) {
    hero.blastCooldown = Math.max(0, hero.blastCooldown - dt);
  }

  if (hero.revealCooldown > 0) {
    hero.revealCooldown = Math.max(0, hero.revealCooldown - dt);
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
    moveAlongPath(hero, dt);
  } else if (hero.path.length === 0) {
    hero.moving = false;
  }

  updateFacing(hero, dt);
}

function moveAlongPath(hero: HeroState, dt: number): void {
  const target = hero.path[0];
  const dir = V.sub(target, hero.pos);
  const dist = V.length(dir);

  if (dist < HERO.arriveEpsilon) {
    hero.pos = { x: target.x, z: target.z };
    hero.path.shift();
    if (hero.path.length === 0) hero.moving = false;
  } else {
    const step = Math.min(heroSpeed(hero) * dt, dist);
    const unit = V.normalize(dir);
    hero.pos = V.add(hero.pos, V.scale(unit, step));
    hero.targetFacing = V.heading(unit);
  }
}

function updateFacing(hero: HeroState, dt: number): void {
  let diff = hero.targetFacing - hero.facing;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;

  const maxTurn = HERO.turnSpeed * dt;
  if (Math.abs(diff) < maxTurn) {
    hero.facing = hero.targetFacing;
  } else {
    hero.facing += Math.sign(diff) * maxTurn;
  }
}

function respawn(hero: HeroState, pos: V.Vec2): void {
  hero.pos = { x: pos.x, z: pos.z };
  hero.hp = HERO.maxHp;
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

    const target = findHitHero(state, p, p.ownerId);
    if (target) {
      const source = state.heroes.find((h) => h.id === p.ownerId);
      state.projectiles.splice(i, 1);
      if (source) {
        if (source.inventory.includes('ice_bow')) {
          target.slowTimer = ICE_BOW_SLOW_DURATION;
        }
        const { damage, crit } = rollAbilityDamage(source, p.damage, rng);
        applyDamage(state, target, source, damage, p.id, events, crit);
      }
      continue;
    }

    // Creeps are checked after heroes so an arrow that passes through a
    // dodging hero flies on and can hit the creep behind them.
    const creepTarget = hitCreep(state, p);
    if (creepTarget) {
      const source = state.heroes.find((h) => h.id === p.ownerId);
      state.projectiles.splice(i, 1);
      if (source) {
        if (source.inventory.includes('ice_bow')) {
          creepTarget.slowTimer = ICE_BOW_SLOW_DURATION;
        }
        const { damage, crit } = rollAbilityDamage(source, p.damage, rng);
        applyCreepDamage(state, creepTarget, source, damage, events, crit);
      }
    }
  }
}

// ── Damage, kills, rewards ────────────────────────────────────────────

function applyDamage(
  state: MatchState,
  target: HeroState,
  source: HeroState,
  damage: number,
  /** Id of the projectile (or blast) that dealt it — clients retire the matching arrow. */
  projectileId: string,
  events: SimEvent[],
  crit = false,
): void {
  if (!target.alive || target.invulnerable) return;

  target.hp = Math.max(0, target.hp - damage);
  events.push({
    type: 'hit',
    targetId: target.id,
    sourceId: source.id,
    projectileId,
    damage,
    x: target.pos.x,
    z: target.pos.z,
    crit,
  });

  if (target.hp > 0) return;

  // Death & kill credit. The victim's kill streak is reset *before* the reward
  // is computed and the killer's multi-kill count is incremented *after*,
  // preserving the original game's (quirky) bounty/multi-kill accounting.
  killHero(target);

  source.kills++;
  source.killStreak++;
  const gold = awardKillGold(state, source, target);
  addXp(source, killXpReward(target, source), events);
  source.multiKillTimer = MULTI_KILL_WINDOW;
  source.multiKillCount++;

  events.push({ type: 'kill', sourceId: source.id, victimId: target.id, gold });
}

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
    hero.skillPoints++;
    events.push({ type: 'levelUp', heroId: hero.id, level: hero.level });
  }
}

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
    if (!hero.alive || hero.hp >= HERO.maxHp) continue;
    for (const fountain of world.fountains) {
      if (V.distanceSq(hero.pos, fountain.pos) <= fountain.healRadius * fountain.healRadius) {
        hero.hp = Math.min(HERO.maxHp, hero.hp + fountain.healPerSecond * dt);
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

export function addItem(hero: HeroState, itemId: string): number {
  for (let i = 0; i < hero.inventory.length; i++) {
    if (hero.inventory[i] === null) {
      hero.inventory[i] = itemId;
      return i;
    }
  }
  return -1;
}

export function removeItem(hero: HeroState, itemId: string): void {
  const i = hero.inventory.indexOf(itemId);
  if (i !== -1) hero.inventory[i] = null;
}
