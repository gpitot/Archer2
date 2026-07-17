/**
 * The hero ability registry — the single place an ability is defined.
 * Command dispatch, skill-point spending, per-tick cooldown updates, client
 * keybindings, cast guards, and the spell bar all iterate `ABILITIES` /
 * `ABILITY_ORDER` instead of hardcoding each spell.
 *
 * Phase-2 shape: ability state still lives in named `HeroState` fields
 * (abilityLevel, dodgeCooldown, …); each def bridges to them through
 * `runtime`. A later phase replaces the flat fields with a generic
 * `Record<AbilityId, AbilityRuntime>` and deletes the bridge.
 */
import * as V from './math';
import { ARROW, BLAST, DODGE, SCOUT } from './rules';
import { HeroState, MatchState, SimEvent } from './state';
import { SimWorld } from './world';
import { spawnProjectile } from './projectiles';
import { breakInvisibility } from './stepRunes';

export type AbilityId = 'arrow' | 'dodge' | 'reveal' | 'blast';

/**
 * Canonical iteration order (QWER). Deterministic ordering matters: the sim
 * ticks ability timers in this order on every peer, and later phases build
 * the wire record from it.
 */
export const ABILITY_ORDER: readonly AbilityId[] = ['arrow', 'dodge', 'reveal', 'blast'];

/** Everything a cast implementation may touch. */
export interface CastContext {
  state: MatchState;
  hero: HeroState;
  world: SimWorld;
  events: SimEvent[];
  /** Ground/aim point for 'aim' and 'point' targeting (absent for 'self'). */
  x?: number;
  z?: number;
}

/** Phase-2 bridge from the registry to the named HeroState fields. */
export interface AbilityRuntimeBridge {
  getLevel(hero: HeroState): number;
  setLevel(hero: HeroState, level: number): void;
  getCooldown(hero: HeroState): number;
  getCharges?(hero: HeroState): number;
  /** Advance this ability's timers by `dt` (cooldowns, recharge, windows). */
  tick(hero: HeroState, dt: number): void;
}

export interface AbilityDef {
  id: AbilityId;
  /** HUD slot / hotkey. */
  slot: 'Q' | 'W' | 'E' | 'R';
  /** Basics rank-gate on ceil(level/2); ultimates on hero levels 6/11/16. */
  kind: 'basic' | 'ultimate';
  maxLevel: number;
  cooldownByLevel: readonly number[];
  /**
   * How the client asks for a target: 'aim' fires toward the cursor,
   * 'point' enters ground-targeting (with `castRange`), 'self' needs none.
   */
  targeting: 'aim' | 'point' | 'self';
  castRange?: number;
  charges?: { max: number; recoil: number };
  /** Readiness guards beyond being alive (level learned, off cooldown, …). */
  canCast(hero: HeroState): boolean;
  /** Full validation + effect. Mirrors the sim exactly — used by both sides. */
  cast(ctx: CastContext): void;
  runtime: AbilityRuntimeBridge;
}

/** Client-side pre-check for a cast: alive + the ability's own guards. */
export function canCast(def: AbilityDef, hero: HeroState): boolean {
  return hero.alive && def.canCast(hero);
}

// ── Shared cast helpers ───────────────────────────────────────────────

/** Clear movement state so the hero stops wherever they are. */
export function stopMovement(hero: HeroState): void {
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

// ── Q — Shoot Arrow ───────────────────────────────────────────────────

function canCastArrow(hero: HeroState): boolean {
  return hero.abilityLevel >= 1 && hero.abilityCharges > 0 && hero.abilityRecoilTimer <= 0;
}

function castArrow(ctx: CastContext): void {
  const { state, hero, events } = ctx;
  if (!hero.alive || !canCastArrow(hero)) return;

  // Casting interrupts movement; attacking breaks invisibility.
  beginCast(hero, true);

  // Turn toward the shot (same smoothed turn as movement).
  const dir = aimDir(hero, ctx.x ?? hero.pos.x, ctx.z ?? hero.pos.z);
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

// ── W — Dodge ─────────────────────────────────────────────────────────

function canCastDodge(hero: HeroState): boolean {
  return !hero.dodgeActive && hero.dodgeCooldown <= 0 && hero.dodgeLevel >= 1;
}

function castDodge(ctx: CastContext): void {
  const hero = ctx.hero;
  if (!hero.alive || !canCastDodge(hero)) return;

  // Dodging interrupts movement (and doesn't break invisibility — it's
  // defensive, not an attack).
  beginCast(hero, false);
  hero.dodgeActive = true;
  hero.dodgeTimer = DODGE.durationByLevel[hero.dodgeLevel];
  hero.dodgeCooldown = DODGE.cooldownByLevel[hero.dodgeLevel];
}

// ── E — Scout ─────────────────────────────────────────────────────────

function canCastScout(hero: HeroState): boolean {
  return hero.revealLevel >= 1 && hero.revealCooldown <= 0;
}

/**
 * Fire a damage-free vision projectile toward the aim point. It flies over
 * everything (no obstacle or unit collision) and expires at max range; the
 * client grants fog vision around it while it's in flight.
 */
function castScout(ctx: CastContext): void {
  const { state, hero, events } = ctx;
  if (!hero.alive || !canCastScout(hero)) return;

  // Casting interrupts movement and turns the hero toward the shot. Note:
  // unlike other casts the scout does NOT break invisibility (possible bug,
  // preserved as-is — review separately).
  beginCast(hero, false);
  const dir = aimDir(hero, ctx.x ?? hero.pos.x, ctx.z ?? hero.pos.z);
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

// ── R — Blast ─────────────────────────────────────────────────────────

function canCastBlast(hero: HeroState): boolean {
  return hero.blastLevel >= 1 && hero.blastCooldown <= 0;
}

/** Mark an AoE circle that detonates after a fixed delay. */
function castBlast(ctx: CastContext): void {
  const { state, hero } = ctx;
  if (!hero.alive || !canCastBlast(hero)) return;
  if (ctx.x === undefined || ctx.z === undefined) return;
  const target = { x: ctx.x, z: ctx.z };
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

// ── Registry ──────────────────────────────────────────────────────────

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  arrow: {
    id: 'arrow',
    slot: 'Q',
    kind: 'basic',
    maxLevel: ARROW.maxLevel,
    cooldownByLevel: ARROW.cooldownByLevel,
    targeting: 'aim',
    charges: { max: ARROW.maxCharges, recoil: ARROW.recoilTime },
    canCast: canCastArrow,
    cast: castArrow,
    runtime: {
      getLevel: (h) => h.abilityLevel,
      setLevel: (h, v) => { h.abilityLevel = v; },
      getCooldown: (h) => h.abilityCooldown,
      getCharges: (h) => h.abilityCharges,
      tick: (h, dt) => {
        if (h.abilityRecoilTimer > 0) {
          h.abilityRecoilTimer = Math.max(0, h.abilityRecoilTimer - dt);
        }
        if (h.abilityCooldown > 0) {
          h.abilityCooldown = Math.max(0, h.abilityCooldown - dt);
          if (h.abilityCooldown <= 0 && h.abilityCharges < ARROW.maxCharges) {
            h.abilityCharges++;
            if (h.abilityCharges < ARROW.maxCharges) {
              h.abilityCooldown = ARROW.cooldownByLevel[Math.max(h.abilityLevel, 1)];
            }
          }
        }
      },
    },
  },
  dodge: {
    id: 'dodge',
    slot: 'W',
    kind: 'basic',
    maxLevel: DODGE.maxLevel,
    cooldownByLevel: DODGE.cooldownByLevel,
    targeting: 'self',
    canCast: canCastDodge,
    cast: castDodge,
    runtime: {
      getLevel: (h) => h.dodgeLevel,
      setLevel: (h, v) => { h.dodgeLevel = v; },
      getCooldown: (h) => h.dodgeCooldown,
      tick: (h, dt) => {
        if (h.dodgeActive) {
          h.dodgeTimer -= dt;
          if (h.dodgeTimer <= 0) h.dodgeActive = false;
        }
        if (h.dodgeCooldown > 0) {
          h.dodgeCooldown = Math.max(0, h.dodgeCooldown - dt);
        }
      },
    },
  },
  reveal: {
    id: 'reveal',
    slot: 'E',
    kind: 'basic',
    maxLevel: SCOUT.maxLevel,
    cooldownByLevel: SCOUT.cooldownByLevel,
    targeting: 'aim',
    canCast: canCastScout,
    cast: castScout,
    runtime: {
      getLevel: (h) => h.revealLevel,
      setLevel: (h, v) => { h.revealLevel = v; },
      getCooldown: (h) => h.revealCooldown,
      tick: (h, dt) => {
        if (h.revealCooldown > 0) {
          h.revealCooldown = Math.max(0, h.revealCooldown - dt);
        }
      },
    },
  },
  blast: {
    id: 'blast',
    slot: 'R',
    kind: 'ultimate',
    maxLevel: BLAST.maxLevel,
    cooldownByLevel: BLAST.cooldownByLevel,
    targeting: 'point',
    castRange: BLAST.castRange,
    canCast: canCastBlast,
    cast: castBlast,
    runtime: {
      getLevel: (h) => h.blastLevel,
      setLevel: (h, v) => { h.blastLevel = v; },
      getCooldown: (h) => h.blastCooldown,
      tick: (h, dt) => {
        if (h.blastCooldown > 0) {
          h.blastCooldown = Math.max(0, h.blastCooldown - dt);
        }
      },
    },
  },
};
