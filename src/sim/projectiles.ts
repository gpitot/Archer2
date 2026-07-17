/**
 * Shared projectile primitives: spawning (with the wire `fire` event),
 * per-tick kinematics, and the hero hit-scan. One implementation for hero
 * arrows, scout projectiles, and creep fireballs — and for the client's
 * cosmetic own-arrow flight, which must end exactly where the sim's does.
 */
import * as V from './math';
import { ARROW, HERO } from './rules';
import { HeroState, MatchState, ProjectileState, SimEvent } from './state';
import { ObstacleAABB, sphereHitsObstacle } from './world';

/**
 * Register a new projectile and announce it. Assigns the deterministic id,
 * pushes it into `state.projectiles`, and emits the `fire` event.
 *
 * `state.tick` is pre-increment here: position at time t on the tick timeline
 * is spawnPos + dir * speed * (t - tick * dt), matching the sim's same-tick
 * advance. The event carries a copy — the live projectile keeps advancing
 * while events await the next snapshot broadcast. (Snapshots never re-send
 * projectiles; the `fire` event is the only way they travel the wire.)
 */
export function spawnProjectile(
  state: MatchState,
  events: SimEvent[],
  init: Omit<ProjectileState, 'id'>,
): ProjectileState {
  const projectile: ProjectileState = { id: `p${state.nextProjectileId++}`, ...init };
  state.projectiles.push(projectile);
  events.push({
    type: 'fire',
    heroId: projectile.ownerId,
    tick: state.tick,
    projectile: { ...projectile, pos: { ...projectile.pos }, dir: { ...projectile.dir } },
  });
  return projectile;
}

/**
 * Advance a projectile by `dt`: accrue range (expiring at max range before
 * moving), step the position, then collide against obstacles. Pass `world`
 * as null to skip obstacle collision (scout projectiles fly over
 * everything).
 */
export function advanceProjectile(
  p: { pos: V.Vec2; dir: V.Vec2; speed: number; traveled: number; maxRange: number },
  dt: number,
  world: { obstacles: ObstacleAABB[] } | null,
  collisionRadius: number,
): 'flying' | 'expired' | 'blocked' {
  p.traveled += p.speed * dt;
  if (p.traveled >= p.maxRange) return 'expired';

  p.pos = V.add(p.pos, V.scale(p.dir, p.speed * dt));

  if (world && sphereHitsObstacle(world, p.pos, collisionRadius)) return 'blocked';
  return 'flying';
}

/**
 * First live hero the projectile overlaps (2D), or null. Dodging heroes are
 * passed through (dodge evades projectiles). Pass `skipOwnerId` for
 * hero-owned projectiles so archers can't shoot themselves; creep-owned
 * projectiles hit any hero.
 */
export function findHitHero(
  state: MatchState,
  p: ProjectileState,
  skipOwnerId?: string,
): HeroState | null {
  const hitRadius = HERO.bodyRadius + ARROW.collisionRadius;
  const r2 = hitRadius * hitRadius;
  for (const hero of state.heroes) {
    if (skipOwnerId !== undefined && hero.id === skipOwnerId) continue;
    if (!hero.alive || hero.invulnerable) continue;
    if (hero.dodgeActive) continue;
    if (V.distanceSq(p.pos, hero.pos) < r2) return hero;
  }
  return null;
}
