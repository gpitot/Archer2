/**
 * Camp tier progression: a cleared camp respawns one tier stronger, climbing
 * the monster ladders. Each respawn upgrades the unit types, raises their
 * level (→ more hp/damage and more gold/xp), and — every second tier — fields
 * an extra unit. Verifies the pure `campComposition` ladder drives the sim.
 */
import { SimHarness, expectEvent, expectTrue } from '../scripts/harness/SimHarness';
import {
  CREEP,
  campComposition,
  campTierLevel,
  creepGold,
  creepMaxHp,
} from '../src/sim/creepRules';

export const name = 'creep-camp-tiers';
export const map = 'test';

/** Force-clear every creep in a camp (bypassing combat) so the camp respawns. */
function clearCamp(h: SimHarness, campId: string): void {
  for (const c of h.state.creeps) {
    if (c.campId === campId) {
      c.alive = false;
      c.hp = 0;
    }
  }
}

function aliveOf(h: SimHarness, campId: string) {
  return h.state.creeps.filter((c) => c.campId === campId && c.alive);
}

export function run(h: SimHarness): void {
  const base = ['ghoul', 'ghost'] as const;
  h.spawnCamp('camp_x', h.findWalkableNear(250, 420), [...base]);

  // ── Tier 0: the authored base composition, all at level 1. ──
  let alive = aliveOf(h, 'camp_x');
  expectTrue(alive.length === 2, `tier 0 fields 2 units: ${alive.length}`);
  expectTrue(
    alive[0].type === 'ghoul' && alive[1].type === 'ghost',
    `tier 0 is the base composition: ${alive.map((c) => c.type)}`,
  );
  expectTrue(alive.every((c) => c.level === 1), 'tier 0 units are level 1');
  const tier0Gold = creepGold(alive[0].type, alive[0].level);

  // ── Clear → tier 1: types climb one rung, level rises, count unchanged. ──
  clearCamp(h, 'camp_x');
  const r1 = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'creepRespawn'),
    h.seconds(CREEP.respawnInterval + 1),
    'tier 1 respawn',
  );
  expectEvent(r1, 'creepRespawn');
  alive = aliveOf(h, 'camp_x');
  const expect1 = campComposition([...base], 1);
  expectTrue(alive.length === expect1.length, `tier 1 unit count ${alive.length} == ${expect1.length}`);
  expectTrue(
    alive.map((c) => c.type).join(',') === expect1.join(','),
    `tier 1 upgraded types: ${alive.map((c) => c.type)} == ${expect1}`,
  );
  expectTrue(alive.every((c) => c.level === campTierLevel(1)), `tier 1 level is ${campTierLevel(1)}`);
  expectTrue(alive[0].type === 'cactoro' && alive[1].type === 'dragon', 'ghoul→cactoro, ghost→dragon');

  // ── Clear → tier 2: an extra unit joins ("greater number of monsters"). ──
  clearCamp(h, 'camp_x');
  h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'creepRespawn'),
    h.seconds(CREEP.respawnInterval + 1),
    'tier 2 respawn',
  );
  alive = aliveOf(h, 'camp_x');
  const expect2 = campComposition([...base], 2);
  expectTrue(expect2.length === 3, `tier 2 grows to 3 units in the ladder: ${expect2.length}`);
  expectTrue(alive.length === 3, `tier 2 fields the extra unit: ${alive.length}`);
  expectTrue(alive.every((c) => c.level === campTierLevel(2)), `tier 2 level is ${campTierLevel(2)}`);

  // Rewards scale up with the tier (stronger type + higher level).
  const tier2Gold = creepGold(alive[0].type, alive[0].level);
  expectTrue(tier2Gold > tier0Gold, `tier-2 gold ${tier2Gold} > tier-0 gold ${tier0Gold}`);
  expectTrue(alive[0].hp === creepMaxHp(alive[0].type, alive[0].level), 'respawned at full hp');
}
