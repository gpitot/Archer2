/**
 * The AI survives a volley of leading arrows. A scripted enemy fires arrows
 * aimed (with the same intercept solver the AI uses) at the AI's predicted
 * position whenever it has a clear, in-range shot — every one of these would
 * connect against a passive target. The AI's every-tick threat response (dodge
 * when it can time it, sidestep / kite otherwise) must avoid the vast majority
 * and keep the hero alive.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { ARROW, HERO } from '../src/sim/rules';
import { solveIntercept, heroVelocity, hasLineOfFire } from '../src/sim/ai/aim';
import { ABILITIES, canCast } from '../src/sim/abilities';

export const name = 'ai-dodges';

export function run(h: SimHarness): void {
  const { a: ai, b: shooter } = h.spawnDuelists(500);
  // Mid-game kit so dodge is available and both have real range.
  ai.level = 11;
  ai.abilities.arrow.level = 4;
  ai.abilities.dodge.level = 4;
  shooter.level = 11;
  shooter.abilities.arrow.level = 5;
  h.attachAi('p1');

  let fires = 0;
  let hitsTaken = 0;
  let dodgeCasts = 0;
  let prevDodgeCd = 0;

  for (let t = 0; t < h.seconds(12); t++) {
    shooter.hp = HERO.maxHp; // stays up to keep the volley coming

    // Fire a leading arrow at the AI whenever there's a clean, in-range shot.
    if (canCast(ABILITIES.arrow, shooter)) {
      const shot = solveIntercept(shooter.pos, ai.pos, heroVelocity(ai), ARROW.speed);
      const maxRange = ARROW.rangeByLevel[5];
      if (shot && ARROW.speed * shot.time <= maxRange - 50 && hasLineOfFire(h.world, shooter.pos, shot.point)) {
        h.issue('p2', { type: 'cast', ability: 'arrow', x: shot.point.x, z: shot.point.z });
      }
    }

    // Detect a dodge activation (cooldown jumps up from ~0).
    const cd = ai.abilities.dodge.cooldown;
    if (cd > prevDodgeCd + 0.1) dodgeCasts++;
    prevDodgeCd = cd;

    for (const e of h.tick()) {
      if (e.type === 'fire' && e.heroId === 'p2') fires++;
      if (e.type === 'hit' && e.targetId === 'p1') hitsTaken++;
    }
  }

  const avoid = fires > 0 ? 1 - hitsTaken / fires : 1;
  expectTrue(fires >= 6, `shooter loosed a real volley (fires=${fires})`);
  expectTrue(ai.alive && ai.deaths === 0, `AI survived the volley (alive=${ai.alive}, deaths=${ai.deaths})`);
  expectTrue(avoid >= 0.8, `AI avoided the volley — ${(avoid * 100).toFixed(0)}% dodged (${hitsTaken}/${fires} hit)`);
}
