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
  BOUNTY_TABLE,
  DODGE,
  HERO,
  KILL_GOLD,
  KILL_XP_TABLE,
  MULTI_KILL_WINDOW,
  PASSIVE_INCOME,
  SPREE_BONUS,
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
  hitHeroByCreepProjectile,
  stepCreeps,
} from './stepCreeps';
import { findReachableNear, findRespawnPosition, SimWorld, sphereHitsObstacle } from './world';

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
  stepProjectiles(state, dt, world, events);
  stepWards(state, dt);
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
  }
}

/** Clear movement state so the hero stops wherever they are. */
function stopMovement(hero: HeroState): void {
  hero.path = [];
  hero.moving = false;
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

  // Casting a spell interrupts movement.
  stopMovement(hero);

  let dir = V.sub({ x: aimX, z: aimZ }, hero.pos);
  if (V.length(dir) < 0.01) {
    dir = { x: Math.sin(hero.facing), z: Math.cos(hero.facing) };
  } else {
    dir = V.normalize(dir);
  }

  // Turn toward the shot (same smoothed turn as movement).
  hero.targetFacing = V.heading(dir);

  const spawn = V.add(hero.pos, V.scale(dir, ARROW.spawnOffset));
  const projectile: ProjectileState = {
    id: `p${state.nextProjectileId++}`,
    ownerId: hero.id,
    team: hero.team,
    pos: spawn,
    dir,
    speed: ARROW.speed,
    maxRange: ARROW.rangeByLevel[hero.abilityLevel],
    traveled: 0,
    damage: ARROW.damageByLevel[hero.abilityLevel],
  };
  state.projectiles.push(projectile);
  hero.abilityCharges--;
  hero.abilityRecoilTimer = ARROW.recoilTime;
  // Start recharge if not already ticking; never reset a running recharge.
  if (hero.abilityCharges < ARROW.maxCharges && hero.abilityCooldown <= 0) {
    hero.abilityCooldown = ARROW.cooldownByLevel[hero.abilityLevel];
  }
  events.push({ type: 'fire', heroId: hero.id, projectileId: projectile.id });
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
  hero.blinkCooldown = 10;
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

function spendSkillPoint(hero: HeroState, ability: 'arrow' | 'dodge'): void {
  if (hero.skillPoints <= 0) return;
  if (ability === 'arrow' && hero.abilityLevel >= ARROW.maxLevel) return;
  if (ability === 'dodge' && hero.dodgeLevel >= DODGE.maxLevel) return;
  hero.skillPoints--;
  if (ability === 'arrow') hero.abilityLevel++;
  else hero.dodgeLevel++;
}

function activateDodge(hero: HeroState): void {
  if (!hero.alive) return;
  if (hero.dodgeActive || hero.dodgeCooldown > 0 || hero.dodgeLevel < 1) return;

  // Dodging interrupts movement.
  stopMovement(hero);
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

  if (hero.invulnerable) {
    hero.invulnerableTimer -= dt;
    if (hero.invulnerableTimer <= 0) hero.invulnerable = false;
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
}

// ── Projectiles ───────────────────────────────────────────────────────

function stepProjectiles(
  state: MatchState,
  dt: number,
  world: SimWorld,
  events: SimEvent[],
): void {
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const p = state.projectiles[i];
    p.traveled += p.speed * dt;

    if (p.traveled >= p.maxRange) {
      state.projectiles.splice(i, 1);
      continue;
    }

    p.pos = V.add(p.pos, V.scale(p.dir, p.speed * dt));

    if (sphereHitsObstacle(world, p.pos, ARROW.collisionRadius)) {
      state.projectiles.splice(i, 1);
      continue;
    }

    if (p.ownerKind === 'creep') {
      // Creep fireball: hits any hero, never hits creeps.
      const target = hitHeroByCreepProjectile(state, p);
      if (target) {
        const creep = state.creeps.find((c) => c.id === p.ownerId);
        state.projectiles.splice(i, 1);
        if (creep) applyCreepDamageToHero(state, target, p.damage, creep, events);
      }
      continue;
    }

    const target = hitHero(state, p);
    if (target) {
      const source = state.heroes.find((h) => h.id === p.ownerId);
      state.projectiles.splice(i, 1);
      if (source) applyDamage(state, target, source, p.damage, events);
      continue;
    }

    // Creeps are checked after heroes so an arrow that passes through a
    // dodging hero flies on and can hit the creep behind them.
    const creepTarget = hitCreep(state, p);
    if (creepTarget) {
      const source = state.heroes.find((h) => h.id === p.ownerId);
      state.projectiles.splice(i, 1);
      if (source) applyCreepDamage(state, creepTarget, source, p.damage, events);
    }
  }
}

/** First live enemy hero the projectile overlaps (2D), or null. */
function hitHero(state: MatchState, p: ProjectileState): HeroState | null {
  const hitRadius = HERO.bodyRadius + ARROW.collisionRadius;
  const r2 = hitRadius * hitRadius;
  for (const hero of state.heroes) {
    if (hero.id === p.ownerId) continue;
    if (!hero.alive || hero.invulnerable) continue;
    if (hero.dodgeActive) continue; // pass through dodging heroes
    if (V.distanceSq(p.pos, hero.pos) < r2) return hero;
  }
  return null;
}

// ── Damage, kills, rewards ────────────────────────────────────────────

function applyDamage(
  state: MatchState,
  target: HeroState,
  source: HeroState,
  amount: number,
  events: SimEvent[],
): void {
  if (!target.alive || target.invulnerable) return;

  target.hp = Math.max(0, target.hp - amount);
  events.push({
    type: 'hit',
    targetId: target.id,
    sourceId: source.id,
    damage: amount,
    x: target.pos.x,
    z: target.pos.z,
  });

  if (target.hp > 0) return;

  // Death & kill credit. The victim's kill streak is reset *before* the reward
  // is computed and the killer's multi-kill count is incremented *after*,
  // preserving the original game's (quirky) bounty/multi-kill accounting.
  killHero(target);

  source.kills++;
  source.killStreak++;
  awardKillGold(state, source, target);
  addXp(source, killXpReward(target, source), events);
  source.multiKillTimer = MULTI_KILL_WINDOW;
  source.multiKillCount++;

  events.push({ type: 'kill', sourceId: source.id, victimId: target.id });
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

function awardKillGold(state: MatchState, killer: HeroState, victim: HeroState): void {
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
}

function killXpReward(victim: HeroState, killer: HeroState): number {
  let xp = KILL_XP_TABLE[Math.min(victim.level, 10)];
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
  return HERO.baseSpeed + hero.speedBonus;
}

export function passiveIncome(hero: HeroState): number {
  if (hero.kills === 0) return PASSIVE_INCOME.base;
  const raw = (hero.deaths * 2) / hero.kills;
  return Math.max(PASSIVE_INCOME.min, Math.min(PASSIVE_INCOME.max, Math.round(raw)));
}

export function xpForLevel(level: number): number {
  return XP_TABLE[Math.min(level, 10)] ?? 5400;
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
