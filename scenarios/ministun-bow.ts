/**
 * Ministun Bow: each arrow hit has a 20% chance to stun the target for 1s.
 *
 * The roll itself is checked directly against the item's hook with a stubbed
 * rng (deterministic, no reliance on how the seeded stream happens to fall),
 * then the integration path confirms real arrows fired through the sim proc
 * it and that the proc lands a genuine stun.
 */
import { SimHarness, expectTrue, expectNear } from '../scripts/harness/SimHarness';
import { MINISTUN_CHANCE, MINISTUN_DURATION, SHOP_ITEMS_BY_ID } from '../src/sim/shopItems';

export const name = 'ministun-bow';

export function run(h: SimHarness): void {
  const { a: shooter, b: target } = h.spawnDuelists(400);
  shooter.inventory[0] = 'ministun_bow';

  const hook = SHOP_ITEMS_BY_ID['ministun_bow'].onProjectileHitHero!;

  // ── The roll ───────────────────────────────────────────────────────
  hook(shooter, target, 100, () => MINISTUN_CHANCE - 0.01);
  expectNear(target.stunTimer, MINISTUN_DURATION, 1e-6, 'a winning roll stuns for the full duration');

  target.stunTimer = 0;
  hook(shooter, target, 100, () => MINISTUN_CHANCE);
  expectTrue(target.stunTimer === 0, 'a roll exactly at the threshold does not proc');

  hook(shooter, target, 100, () => 0.99);
  expectTrue(target.stunTimer === 0, 'a losing roll does not proc');

  // Stuns refresh rather than stack, so a lucky streak can't accumulate.
  hook(shooter, target, 100, () => 0);
  h.tick();
  expectTrue(target.stunTimer < MINISTUN_DURATION, 'stun ticks down');
  hook(shooter, target, 100, () => 0);
  expectNear(target.stunTimer, MINISTUN_DURATION, 1e-6, 'a second proc refreshes to full, never doubles');

  // The proc is a real stun: the victim ignores orders until it expires.
  h.issue(target.id, { type: 'moveTo', x: target.pos.x + 400, z: target.pos.z });
  h.tick();
  expectTrue(!target.moving && target.path.length === 0, 'move order rejected while ministunned');
  h.runUntil(() => target.stunTimer <= 0, h.seconds(MINISTUN_DURATION + 0.5), 'ministun expires');

  // ── Integration: arrows fired through the sim proc it ──────────────
  h.issue(shooter.id, { type: 'levelAbility', ability: 'arrow' });
  h.tick();

  const arrow = shooter.abilities.arrow;
  let hits = 0;
  let procs = 0;
  for (let i = 0; i < 25; i++) {
    // Keep the dummy alive — we care about proc rate, not the kill.
    target.hp = 625;
    target.stunTimer = 0;
    // Arrows are charge-based with a recoil between shots. Wait for the shot
    // to actually be available, or the cast is silently rejected and we'd sit
    // waiting on a hit that never comes.
    h.runUntil(
      () => (arrow.charges ?? 0) > 0 && (arrow.recoil ?? 0) <= 0,
      h.seconds(5),
      'arrow ready',
    );
    h.issue(shooter.id, { type: 'cast', ability: 'arrow', x: target.pos.x, z: target.pos.z });
    h.runUntil(
      (_s, evs) => evs.some((e) => e.type === 'hit' && e.projectileId !== 'burn'),
      h.seconds(2),
      'arrow hit',
    );
    hits++;
    if (target.stunTimer > 0) procs++;
  }

  expectTrue(procs > 0, `arrows procced the ministun (${procs}/${hits} hits)`);
  // A 20% chance over 40 hits: seeded, so this is deterministic, but keep the
  // band wide — it is a smoke test that the rate is plausible, not a rng test.
  expectTrue(
    procs < hits * 0.6,
    `proc rate is a chance, not every hit (${procs}/${hits})`,
  );
}
