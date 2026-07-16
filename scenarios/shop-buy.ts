/**
 * Comprehensive shop buy test — reproduces buying items from the shop on the test map.
 */
import { SimHarness, expectTrue, expectNear, expectEvent } from '../scripts/harness/SimHarness';
import { TEST_MAP_SPAWNS } from '../src/world/testMap';

export const name = 'shop-buy';
export const map = 'test';

export function run(h: SimHarness): void {
  const shopPos = h.shopPos;
  
  // Spawn hero at the first test map spawn
  const spawn = h.findWalkableNear(TEST_MAP_SPAWNS[0].x, TEST_MAP_SPAWNS[0].z);
  const hero = h.spawnHero('p1', 0, spawn);

  // Hero should NOT be near the shop initially (spawns are ~500+ units away)
  const distToShop = Math.hypot(hero.pos.x - shopPos.x, hero.pos.z - shopPos.z);
  expectTrue(distToShop > h.world.shop.interactRadius, 'hero starts far from shop');

  // Give gold for testing
  hero.gold = 20;

  // Walk to the shop
  h.issue('p1', { type: 'moveTo', x: shopPos.x, z: shopPos.z });
  
  // Run until hero stops moving (arrived near shop)
  h.runUntil(() => {
    const d = Math.hypot(hero.pos.x - shopPos.x, hero.pos.z - shopPos.z);
    return d <= h.world.shop.interactRadius;
  }, h.seconds(15), 'hero arrives at shop');

  // Verify near shop
  const distAfter = Math.hypot(hero.pos.x - shopPos.x, hero.pos.z - shopPos.z);
  expectNear(distAfter, 0, h.world.shop.interactRadius, 'hero near shop');

  // Try to buy without enough gold
  hero.gold = 2;
  h.issue('p1', { type: 'buy', itemIndex: 0 });
  let events = h.tick();
  expectTrue(events.length === 0, 'cannot buy with insufficient gold');

  // Give enough gold and buy
  hero.gold = 20;
  h.issue('p1', { type: 'buy', itemIndex: 0 });
  events = h.tick();
  expectEvent(events, 'purchase', 'bought boots');
  expectTrue(hero.inventory[0] === 'boots', 'boots in slot 0');
  expectTrue(hero.speedBonus === 60, 'speed bonus applied');
  expectTrue(hero.gold === 15, 'gold deducted');

  // Buy wards
  h.issue('p1', { type: 'buy', itemIndex: 1 });
  events = h.tick();
  expectEvent(events, 'purchase', 'bought wards');
  expectTrue(hero.inventory[1] === 'sentry_wards', 'wards in slot 1');
  expectTrue(hero.wardCharges === 5, 'ward charges');
  expectTrue(hero.gold === 5, 'gold after wards');

  // ── Use items via hotkeys ──

  // Use boots (slot 0) — passive, nothing happens
  h.issue('p1', { type: 'useItem', slot: 0 });
  events = h.tick();
  expectTrue(events.length === 0, 'using boots does nothing');
  expectTrue(hero.inventory[0] === 'boots', 'boots still in slot 0');

  // Use wards (slot 1) — places a ward at hero position
  const wardCountBefore = h.state.wards.length;
  h.issue('p1', { type: 'useItem', slot: 1 });
  events = h.tick();
  expectTrue(h.state.wards.length === wardCountBefore + 1, 'ward placed');
  expectTrue(hero.wardCharges === 4, `ward charges after use: ${hero.wardCharges}`);
  expectTrue(hero.inventory[1] === 'sentry_wards', 'wards still in slot (charges remain)');

  // Use empty slot — nothing happens
  h.issue('p1', { type: 'useItem', slot: 2 });
  events = h.tick();
  expectTrue(events.length === 0, 'using empty slot does nothing');
}
