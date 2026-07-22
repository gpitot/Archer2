/**
 * Defenders mode: with no hero in aggro range, creeps march across the map
 * to the nearest castle, batter it down, and razing the last castle ends the
 * match in defeat. Also checks the mode's friendly-fire gate (allied arrows
 * pass through teammates) and the fixed wave clock (the camp climbs a tier
 * on schedule even while the previous wave is still alive).
 */
import { SimHarness, expectEvent, expectTrue } from '../scripts/harness/SimHarness';
import { spawnCastles } from '../src/sim/buildings';
import { BUILDING_TYPES } from '../src/sim/buildingRules';

export const name = 'defenders-castle';
export const map = 'test';

export function run(h: SimHarness): void {
  h.state.mode = 'defenders';

  // A castle on open ground; the camp spawns well outside any aggro radius.
  const castlePos = h.findWalkableNear(-400, 420);
  spawnCastles(h.state, h.world, [castlePos]);
  expectTrue(h.state.buildings.length === 1, 'castle spawned');
  const castle = h.state.buildings[0];

  const [ghoul] = h.spawnCamp('camp_wave', h.findWalkableNear(600, 420), ['ghoul']);
  const startDist = Math.hypot(ghoul.pos.x - castle.pos.x, ghoul.pos.z - castle.pos.z);
  expectTrue(startDist > 900, `camp starts far from the castle (${startDist.toFixed(0)})`);

  // Two allied defenders standing between camp and castle, colinear with the
  // arrow line — the friendly-fire probe. Placed out of the ghoul's aggro
  // path (north offset) so the march itself stays undisturbed.
  const shooter = h.spawnHero('p1', 0, h.findWalkableNear(-200, -200));
  const ally = h.spawnHero('p2', 0, h.findWalkableNear(0, -200));
  h.issue('p1', { type: 'cast', ability: 'arrow', x: ally.pos.x, z: ally.pos.z });
  const ffEvents = h.tick(h.seconds(1));
  expectTrue(
    !ffEvents.some((e) => e.type === 'hit' && e.targetId === 'p2'),
    'allied arrow passed through the teammate',
  );

  // The ghoul marches on the castle unprompted and starts swinging.
  const hitEvents = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'buildingHit'),
    h.seconds(30),
    'creep reaches and attacks the castle',
  );
  expectEvent(hitEvents, 'buildingHit');
  expectTrue(castle.hp < BUILDING_TYPES.castle.maxHp, 'castle is taking damage');

  // Waves ride a fixed clock: the camp climbs a tier even though the ghoul
  // is alive and mid-siege, and the survivor is left untouched (still a
  // ghoul, still swinging) rather than being reset by the respawn.
  const camp = h.state.camps.find((c) => c.id === 'camp_wave')!;
  h.runUntil(
    () => camp.tier >= 1,
    h.seconds(20),
    'wave clock ticks while the previous wave lives',
  );
  expectTrue(ghoul.alive && ghoul.type === 'ghoul', 'survivor untouched by the wave tick');

  // Let the wave finish the job (skip the grind — drop the castle low).
  castle.hp = 50;
  const endEvents = h.runUntil(
    (s) => s.outcome === 'defeat',
    h.seconds(10),
    'razing the castle ends the match in defeat',
  );
  expectEvent(endEvents, 'buildingKill');
  const over = expectEvent(endEvents, 'matchOver');
  expectTrue(over.type === 'matchOver' && over.outcome === 'defeat', 'outcome is defeat');

  // Frozen after the end: no further events, tick still advances.
  const tickBefore = h.state.tick;
  const frozen = h.tick(h.seconds(1));
  expectTrue(frozen.length === 0, 'sim is frozen after matchOver');
  expectTrue(h.state.tick === tickBefore + h.seconds(1), 'tick still advances while frozen');
}
