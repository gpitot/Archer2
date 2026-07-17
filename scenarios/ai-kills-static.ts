/**
 * The AI opponent kills a stationary, do-nothing drone within a few seconds —
 * the baseline "it can aim and finish" check.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';

export const name = 'ai-kills-static';

export function run(h: SimHarness): void {
  const { b: drone } = h.spawnDuelists(500);
  // 'p1' is the AI, 'p2' (drone) issues no commands and just stands there.
  h.attachAi('p1');

  h.runUntil((_s, evs) => evs.some((e) => e.type === 'kill' && e.victimId === 'p2'),
    h.seconds(15), 'AI kills the static drone');

  expectTrue(!drone.alive || drone.hp <= 0, `drone was killed (hp=${drone.hp})`);
  expectTrue(h.hero('p1').kills >= 1, `AI recorded the kill (kills=${h.hero('p1').kills})`);
}
