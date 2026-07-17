/**
 * The hero ability registry — the single place an ability is defined.
 * Command dispatch, skill-point spending, per-tick cooldown updates, client
 * keybindings, cast guards, the spell bar, and the wire encoding all iterate
 * `ABILITIES` / `ABILITY_ORDER` instead of hardcoding each spell.
 *
 * Ability state lives in `hero.abilities[id]` (an `AbilityRuntime` record
 * entry created by `createAbilityRuntimes`) — adding a spell means adding a
 * def here and nothing else: state, wire meta, cooldown ticking, keybinding,
 * and HUD slot all follow from the registry.
 */
import * as V from './math';
import { ARROW, BLAST, DODGE, SCOUT } from './rules';
import type { AbilityRuntime, HeroState, MatchState, SimEvent } from './state';
import type { SimWorld } from './world';
import type { StatLine, TooltipContent } from '../ui/Tooltip';
import { spawnProjectile } from './projectiles';
import { breakInvisibility } from './stepRunes';

export type AbilityId = 'arrow' | 'dodge' | 'reveal' | 'blast';

/**
 * Format a per-rank table (index 0 = unlearned) into a stat line's values,
 * dropping the unlearned slot so index 0 of the result is rank 1.
 */
function perRank(table: readonly number[], suffix = ''): readonly string[] {
  return table.slice(1).map((v) => `${v}${suffix}`);
}

/**
 * Canonical iteration order (QWER). Deterministic ordering matters: the sim
 * ticks ability timers in this order on every peer, and hero state / wire
 * records are built with keys in this order.
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

export interface AbilityDef {
  id: AbilityId;
  /** HUD slot / hotkey. */
  slot: 'Q' | 'W' | 'E' | 'R';
  /** Display name shown in the hover tooltip. */
  name: string;
  /** One-sentence flavour/summary shown at the top of the tooltip. */
  description: string;
  /** Per-rank stat rows (Damage/Cooldown/…) shown in the tooltip. */
  stats: readonly StatLine[];
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
  /** The ability keeps an active window open after casting (e.g. dodge). */
  hasActiveWindow?: boolean;
  /** Readiness guards beyond being alive (level learned, off cooldown, …). */
  canCast(hero: HeroState): boolean;
  /** Full validation + effect. Mirrors the sim exactly — used by both sides. */
  cast(ctx: CastContext): void;
  /** Advance this ability's timers by `dt` (cooldowns, recharge, windows). */
  tick(hero: HeroState, dt: number): void;
}

/** Client-side pre-check for a cast: alive + the ability's own guards. */
export function canCast(def: AbilityDef, hero: HeroState): boolean {
  return hero.alive && def.canCast(hero);
}

/**
 * Build the hover-tooltip content for an ability, emphasising the value for
 * the hero's current rank (`level`; 0 = unlearned → no emphasis).
 */
export function abilityTooltip(def: AbilityDef, level: number): TooltipContent {
  const footer =
    level > 0 ? `Rank ${level}/${def.maxLevel}` : `${def.maxLevel} ranks — not yet learned`;
  return {
    name: `${def.slot} · ${def.name}`,
    description: def.description,
    stats: def.stats,
    highlightIndex: level > 0 ? level - 1 : undefined,
    footer,
  };
}

/**
 * Fresh per-ability runtime record for a new hero, keyed in ABILITY_ORDER
 * (deterministic key iteration on every peer). The level-1 skill point is
 * auto-spent on Q, so arrow starts at rank 1 with a full magazine.
 */
export function createAbilityRuntimes(): Record<AbilityId, AbilityRuntime> {
  const out = {} as Record<AbilityId, AbilityRuntime>;
  for (const id of ABILITY_ORDER) {
    const def = ABILITIES[id];
    const runtime: AbilityRuntime = { level: 0, cooldown: 0 };
    if (def.charges) {
      runtime.charges = 0;
      runtime.recoil = 0;
    }
    if (def.hasActiveWindow) {
      runtime.active = false;
      runtime.activeTimer = 0;
    }
    out[id] = runtime;
  }
  out.arrow.level = 1;
  out.arrow.charges = ARROW.maxCharges;
  return out;
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

/** Standard cooldown decrement (no recharge semantics). */
function tickCooldown(runtime: AbilityRuntime, dt: number): void {
  if (runtime.cooldown > 0) {
    runtime.cooldown = Math.max(0, runtime.cooldown - dt);
  }
}

// ── Q — Shoot Arrow ───────────────────────────────────────────────────

function canCastArrow(hero: HeroState): boolean {
  const a = hero.abilities.arrow;
  return a.level >= 1 && (a.charges ?? 0) > 0 && (a.recoil ?? 0) <= 0;
}

function castArrow(ctx: CastContext): void {
  const { state, hero, events } = ctx;
  if (!hero.alive || !canCastArrow(hero)) return;
  const a = hero.abilities.arrow;

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
    maxRange: ARROW.rangeByLevel[a.level],
    traveled: 0,
    damage: ARROW.damageByLevel[a.level],
  });
  a.charges!--;
  a.recoil = ARROW.recoilTime;
  // Start recharge if not already ticking; never reset a running recharge.
  if (a.charges! < ARROW.maxCharges && a.cooldown <= 0) {
    a.cooldown = ARROW.cooldownByLevel[a.level];
  }
}

// ── W — Dodge ─────────────────────────────────────────────────────────

function canCastDodge(hero: HeroState): boolean {
  const a = hero.abilities.dodge;
  return !a.active && a.cooldown <= 0 && a.level >= 1;
}

function castDodge(ctx: CastContext): void {
  const hero = ctx.hero;
  if (!hero.alive || !canCastDodge(hero)) return;
  const a = hero.abilities.dodge;

  // Dodging interrupts movement (and doesn't break invisibility — it's
  // defensive, not an attack).
  beginCast(hero, false);
  a.active = true;
  a.activeTimer = DODGE.durationByLevel[a.level];
  a.cooldown = DODGE.cooldownByLevel[a.level];
}

// ── E — Scout ─────────────────────────────────────────────────────────

function canCastScout(hero: HeroState): boolean {
  const a = hero.abilities.reveal;
  return a.level >= 1 && a.cooldown <= 0;
}

/**
 * Fire a damage-free vision projectile toward the aim point. It flies over
 * everything (no obstacle or unit collision) and expires at max range; the
 * client grants fog vision around it while it's in flight.
 */
function castScout(ctx: CastContext): void {
  const { state, hero, events } = ctx;
  if (!hero.alive || !canCastScout(hero)) return;
  const a = hero.abilities.reveal;

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
    maxRange: SCOUT.rangeByLevel[a.level],
    traveled: 0,
    damage: 0,
  });
  a.cooldown = SCOUT.cooldownByLevel[a.level];
}

// ── R — Blast ─────────────────────────────────────────────────────────

function canCastBlast(hero: HeroState): boolean {
  const a = hero.abilities.blast;
  return a.level >= 1 && a.cooldown <= 0;
}

/** Mark an AoE circle that detonates after a fixed delay. */
function castBlast(ctx: CastContext): void {
  const { state, hero } = ctx;
  if (!hero.alive || !canCastBlast(hero)) return;
  if (ctx.x === undefined || ctx.z === undefined) return;
  const target = { x: ctx.x, z: ctx.z };
  if (V.distance(hero.pos, target) > BLAST.castRange + 1) return;
  const a = hero.abilities.blast;

  // Casting interrupts movement, breaks invisibility, and turns the hero
  // toward the target.
  beginCast(hero, true);
  const dir = V.sub(target, hero.pos);
  if (V.length(dir) > 0.01) hero.targetFacing = V.heading(dir);

  a.cooldown = BLAST.cooldownByLevel[a.level];
  state.blasts.push({
    id: `b${state.nextBlastId++}`,
    ownerId: hero.id,
    team: hero.team,
    pos: target,
    timer: BLAST.delay,
    damage: BLAST.damageByLevel[a.level],
  });
}

// ── Registry ──────────────────────────────────────────────────────────

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  arrow: {
    id: 'arrow',
    slot: 'Q',
    name: 'Shoot Arrow',
    description: 'Fire a fast arrow that damages the first enemy it strikes. Holds multiple charges.',
    stats: [
      { label: 'Damage', values: perRank(ARROW.damageByLevel) },
      { label: 'Range', values: perRank(ARROW.rangeByLevel) },
      { label: 'Cooldown', values: perRank(ARROW.cooldownByLevel, 's') },
      { label: 'Charges', values: [String(ARROW.maxCharges)] },
    ],
    kind: 'basic',
    maxLevel: ARROW.maxLevel,
    cooldownByLevel: ARROW.cooldownByLevel,
    targeting: 'aim',
    charges: { max: ARROW.maxCharges, recoil: ARROW.recoilTime },
    canCast: canCastArrow,
    cast: castArrow,
    tick: (h, dt) => {
      const a = h.abilities.arrow;
      if (a.recoil! > 0) {
        a.recoil = Math.max(0, a.recoil! - dt);
      }
      if (a.cooldown > 0) {
        a.cooldown = Math.max(0, a.cooldown - dt);
        if (a.cooldown <= 0 && a.charges! < ARROW.maxCharges) {
          a.charges!++;
          if (a.charges! < ARROW.maxCharges) {
            a.cooldown = ARROW.cooldownByLevel[Math.max(a.level, 1)];
          }
        }
      }
    },
  },
  dodge: {
    id: 'dodge',
    slot: 'W',
    name: 'Dodge',
    description: 'Enter an evasive stance that avoids all incoming arrows for a short window.',
    stats: [
      { label: 'Duration', values: perRank(DODGE.durationByLevel, 's') },
      { label: 'Cooldown', values: perRank(DODGE.cooldownByLevel, 's') },
    ],
    kind: 'basic',
    maxLevel: DODGE.maxLevel,
    cooldownByLevel: DODGE.cooldownByLevel,
    targeting: 'self',
    hasActiveWindow: true,
    canCast: canCastDodge,
    cast: castDodge,
    tick: (h, dt) => {
      const a = h.abilities.dodge;
      if (a.active) {
        a.activeTimer! -= dt;
        if (a.activeTimer! <= 0) a.active = false;
      }
      tickCooldown(a, dt);
    },
  },
  reveal: {
    id: 'reveal',
    slot: 'E',
    name: 'Scout',
    description: 'Launch a soaring vision projectile that reveals fog of war along its path.',
    stats: [
      { label: 'Range', values: perRank(SCOUT.rangeByLevel) },
      { label: 'Sight Radius', values: [String(SCOUT.sightRadius)] },
      { label: 'Cooldown', values: perRank(SCOUT.cooldownByLevel, 's') },
    ],
    kind: 'basic',
    maxLevel: SCOUT.maxLevel,
    cooldownByLevel: SCOUT.cooldownByLevel,
    targeting: 'aim',
    canCast: canCastScout,
    cast: castScout,
    tick: (h, dt) => tickCooldown(h.abilities.reveal, dt),
  },
  blast: {
    id: 'blast',
    slot: 'R',
    name: 'Blast',
    description: 'Mark a target area that detonates after a short delay, damaging all enemies caught inside.',
    stats: [
      { label: 'Damage', values: perRank(BLAST.damageByLevel) },
      { label: 'Cooldown', values: perRank(BLAST.cooldownByLevel, 's') },
      { label: 'Radius', values: [String(BLAST.radius)] },
      { label: 'Cast Range', values: [String(BLAST.castRange)] },
      { label: 'Delay', values: [`${BLAST.delay}s`] },
    ],
    kind: 'ultimate',
    maxLevel: BLAST.maxLevel,
    cooldownByLevel: BLAST.cooldownByLevel,
    targeting: 'point',
    castRange: BLAST.castRange,
    canCast: canCastBlast,
    cast: castBlast,
    tick: (h, dt) => tickCooldown(h.abilities.blast, dt),
  },
};
