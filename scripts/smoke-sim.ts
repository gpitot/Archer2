/**
 * Smoke test: runs the headless simulation under `tsx` with no browser.
 * Loads the precomputed navdata, creates a MatchState with two heroes, sends
 * a few commands, and asserts the expected results (one hero reaches its
 * destination, an arrow hits the other hero).
 *
 * Usage:  pnpm tsx scripts/smoke-sim.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createMatchState, createHeroState, HeroInput, MatchState } from '../src/sim/state';
import { stepMatch } from '../src/sim/stepMatch';
import { buildSimWorldFromNavdata } from '../src/sim/buildWorld';
import { HERO } from '../src/sim/rules';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const navdataPath = path.resolve(__dirname, '..', 'assets', 'navdata.json');

const navdata = JSON.parse(fs.readFileSync(navdataPath, 'utf-8'));
const world = buildSimWorldFromNavdata(navdata);

const shopPos = world.shop.pos;

// Seeded RNG for deterministic respawn positions in tests.
let seed = 42;
function rng(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function run(): void {
  const state = createMatchState();

  // Spawn two heroes on the same team near the shop so they can reach each other.
  const player = createHeroState('p1', 0, { x: shopPos.x + 40, z: shopPos.z + 40 });
  const dummy = createHeroState('p2', 0, { x: shopPos.x + 200, z: shopPos.z + 40 });
  state.heroes.push(player, dummy);

  let inputs: HeroInput[] = [];
  let totalTicks = 0;
  const maxTicks = 30 * 8; // 8 seconds at 30Hz

  // Phase 1: Move player toward the dummy.
  console.log('[smoke] moving player toward dummy...');
  const moveCmd: HeroInput = {
    heroId: 'p1',
    cmd: { type: 'moveTo', x: dummy.pos.x, z: dummy.pos.z },
  };

  for (let i = 0; i < 30 * 3; i++) {
    inputs = i === 0 ? [moveCmd] : [];
    stepMatch(state, inputs, 1 / 30, world, rng);
    totalTicks++;
  }

  const distAfterMove = Math.hypot(
    player.pos.x - dummy.pos.x,
    player.pos.z - dummy.pos.z,
  );
  console.log(`  distance after moving: ${distAfterMove.toFixed(1)} world units`);
  if (distAfterMove > 200) throw new Error('player did not move close enough to dummy');

  // Phase 2: Learn ability and fire at the dummy.
  console.log('[smoke] learning ability...');
  player.skillPoints = 1;
  stepMatch(state, [{ heroId: 'p1', cmd: { type: 'levelAbility', ability: 'arrow' } }], 1 / 30, world, rng);
  console.log(`  ability level: ${player.abilityLevel} (expected 1)`);
  if (player.abilityLevel !== 1) throw new Error('ability not learned');

  console.log('[smoke] firing arrow at dummy...');
  const fireInputs: HeroInput[] = [{
    heroId: 'p1',
    cmd: { type: 'cast', ability: 'arrow', x: dummy.pos.x, z: dummy.pos.z },
  }];
  stepMatch(state, fireInputs, 1 / 30, world, rng);
  console.log(`  projectiles in flight: ${state.projectiles.length} (expected 1)`);
  if (state.projectiles.length !== 1) throw new Error('arrow not created');
  if (player.abilityCooldown <= 0) throw new Error('ability not on cooldown');

  // Phase 3: Step until arrow hits. Use high HP so we test hit + kill separately.
  dummy.hp = 500; // enough to survive a level-1 arrow (200 dmg)
  stepMatch(state, [{
    heroId: 'p1',
    cmd: { type: 'cast', ability: 'arrow', x: dummy.pos.x, z: dummy.pos.z },
  }], 1 / 30, world, rng);

  console.log('[smoke] stepping until arrow resolves...');
  let hit = false;
  let expired = false;
  for (let i = 0; i < 30 * 5; i++) {
    const events = stepMatch(state, [], 1 / 30, world, rng);
    totalTicks++;
    if (state.projectiles.length === 0) {
      hit = events.some((e) => e.type === 'hit');
      expired = !hit;
      break;
    }
  }

  if (hit) {
    console.log(`  arrow hit! dummy HP: ${dummy.hp}/${HERO.maxHp} (raw: ${dummy.hp})`);
    if (dummy.hp >= 500) throw new Error('dummy took no damage');
  } else if (expired) {
    throw new Error('arrow expired without hitting — dummy too far?');
  } else {
    throw new Error('arrow neither hit nor expired within timeout');
  }

  // Phase 4: Award a kill to test gold/XP.
  console.log('[smoke] testing kill rewards...');
  // Wait for ability cooldown to expire.
  while (player.abilityCooldown > 0) {
    stepMatch(state, [], 1 / 30, world, rng);
    totalTicks++;
  }
  const oldGold = player.gold;
  const oldXp = player.xp;
  const oldKills = player.kills;
  dummy.hp = 1; // weaken so the next hit is lethal
  stepMatch(state, [{
    heroId: 'p1',
    cmd: { type: 'cast', ability: 'arrow', x: dummy.pos.x, z: dummy.pos.z },
  }], 1 / 30, world, rng);

  // Step until kill
  for (let i = 0; i < 30 * 5; i++) {
    const events = stepMatch(state, [], 1 / 30, world, rng);
    if (events.some((e) => e.type === 'kill')) {
      console.log(`  kill! player gold: ${player.gold} (was ${oldGold}), xp: ${player.xp} (was ${oldXp})`);
      console.log(`  player kills: ${player.kills}, deaths: ${player.deaths}`);
      break;
    }
  }

  if (player.kills <= oldKills) throw new Error('kill not registered');
  if (player.gold <= oldGold) throw new Error('no gold awarded');
  if (player.xp <= oldXp) throw new Error('no xp awarded');

  // Phase 5: Test ward placement.
  console.log('[smoke] testing ward...');
  player.wardCharges = 3;
  stepMatch(state, [{ heroId: 'p1', cmd: { type: 'ward' } }], 1 / 30, world, rng);
  console.log(`  wards placed: ${state.wards.length} (expected 1), charges left: ${player.wardCharges} (expected 2)`);
  if (state.wards.length !== 1) throw new Error('ward not placed');
  if (player.wardCharges !== 2) throw new Error('ward charge not consumed');

  // Phase 6: Test respawn.
  if (!dummy.alive) {
    console.log('[smoke] testing respawn...');
    let respawned = false;
    for (let i = 0; i < 30 * 5; i++) {
      const events = stepMatch(state, [], 1 / 30, world, rng);
      if (events.some((e) => e.type === 'respawn' && e.heroId === 'p2')) {
        respawned = true;
        break;
      }
    }
    console.log(`  dummy respawned: ${respawned}, alive: ${dummy.alive}`);
    if (!respawned) throw new Error('dummy did not respawn');
  }

  // Phase 7: Test shop buy.
  console.log('[smoke] testing shop buy...');
  player.gold = 100;
  const buyCmd: HeroInput = {
    heroId: 'p1',
    cmd: { type: 'buy', itemIndex: 0 }, // Boots of Speed
  };
  const events = stepMatch(state, [buyCmd], 1 / 30, world, rng);
  console.log(`  speedBonus: ${player.speedBonus} (expected 60), gold: ${player.gold} (expected 95)`);
  if (player.speedBonus !== 60) throw new Error('boots not applied');
  if (player.gold !== 95) throw new Error('gold not deducted');
  if (!events.some((e) => e.type === 'purchase')) throw new Error('no purchase event');

  console.log(`\n[smoke] ✅ all checks passed (${totalTicks} ticks)`);
}

try {
  run();
} catch (err) {
  console.error(`\n[smoke] ❌ FAILED: ${err}`);
  process.exit(1);
}
