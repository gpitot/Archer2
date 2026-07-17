/**
 * The AI leads a strafing target. A practice dummy (hp topped up each tick so
 * the sample isn't cut short by a kill) runs back and forth perpendicular to
 * the original line of fire. Across a ~0.6s arrow flight it moves ~200u — a
 * "shoot at the current position" bot would miss almost all of these, so the
 * intercept solver is what keeps the hit rate high (~0.7–0.8, stable across
 * seeds).
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { HERO } from '../src/sim/rules';
import * as V from '../src/sim/math';

export const name = 'ai-leads-moving-target';

export function run(h: SimHarness): void {
  const { a: shooter, b: dummy } = h.spawnDuelists(500);
  h.attachAi('p1');

  const perp0 = V.normalize(V.sub(dummy.pos, shooter.pos));
  const perp = { x: perp0.z, z: -perp0.x };
  const anchor = { x: dummy.pos.x, z: dummy.pos.z };
  const legLen = 900;
  let sign = 1;

  const setLeg = () => {
    const wp = V.add(anchor, V.scale(perp, legLen * sign));
    h.issue('p2', { type: 'moveTo', x: wp.x, z: wp.z });
  };
  setLeg();

  let fires = 0;
  let hits = 0;
  for (let t = 0; t < h.seconds(25); t++) {
    dummy.hp = HERO.maxHp; // immortal practice dummy — keep the sample going
    const wp = V.add(anchor, V.scale(perp, legLen * sign));
    if (!dummy.moving || V.distance(dummy.pos, wp) < 120) {
      sign = -sign;
      setLeg();
    }
    for (const e of h.tick()) {
      if (e.type === 'fire' && e.heroId === 'p1') fires++;
      if (e.type === 'hit' && e.sourceId === 'p1' && e.targetId === 'p2') hits++;
    }
  }

  const rate = fires > 0 ? hits / fires : 0;
  expectTrue(fires >= 8, `AI fired a meaningful sample (fires=${fires})`);
  expectTrue(hits >= 6, `AI landed lead shots on the moving dummy (hits=${hits})`);
  expectTrue(rate >= 0.6, `hit rate vs strafing dummy ${(rate * 100).toFixed(0)}% ≥ 60% (${hits}/${fires})`);
}
