/**
 * Active-item registry: blink teleportation (with cooldown gate), ward
 * placement, and ice-bow slow on hit — exercised end-to-end through the
 * generic `useItem` path.
 */
import { SimHarness, expectTrue, expectNear } from '../scripts/harness/SimHarness';
import { ARROW, HERO } from '../src/sim/rules';
import { SHOP_ITEMS, BLINK_COOLDOWN, ICE_BOW_SLOW_DURATION } from '../src/sim/shopItems';

export const name = 'item-actives';

export function run(h: SimHarness): void {
  // ── Blink dagger ──────────────────────────────────────────────────
  {
    const hero = h.spawnHero('b1', 0,
      h.findWalkableNear(h.shopPos.x + 100, h.shopPos.z + 60));

    // Position at shop to buy.
    hero.pos = { x: h.shopPos.x, z: h.shopPos.z };
    hero.gold = SHOP_ITEMS.find((i) => i.id === 'blink_dagger')!.cost;
    const blinkIdx = SHOP_ITEMS.findIndex((i) => i.id === 'blink_dagger');
    h.issue('b1', { type: 'buy', itemIndex: blinkIdx });
    const buyEvents = h.tick();
    expectTrue(buyEvents.some((e) => e.type === 'purchase'), 'blink dagger purchased');
    const slot = hero.inventory.indexOf('blink_dagger');
    expectTrue(slot !== -1, 'blink dagger in inventory');

    // Walk away so teleport is not a zero-length move.
    const far = h.findWalkableNear(h.shopPos.x + 300, h.shopPos.z + 200);
    h.issue('b1', { type: 'moveTo', x: far.x, z: far.z });
    h.runUntil(() => !hero.moving, h.seconds(10), 'reach blink start');
    const before = { x: hero.pos.x, z: hero.pos.z };

    // Blink toward the shop — useItem with a ground target.
    h.issue('b1', { type: 'useItem', slot, x: h.shopPos.x + 40, z: h.shopPos.z + 40 });
    h.tick();
    expectTrue(
      Math.hypot(hero.pos.x - before.x, hero.pos.z - before.z) > 50,
      'hero teleported away from start',
    );
    expectTrue((hero.itemCooldowns['blink_dagger'] ?? 0) > 0, 'blink on cooldown');

    // Second blink while on cooldown — rejected.
    const after = { x: hero.pos.x, z: hero.pos.z };
    h.issue('b1', { type: 'useItem', slot, x: h.shopPos.x + 20, z: h.shopPos.z + 20 });
    h.tick();
    expectTrue(hero.pos.x === after.x && hero.pos.z === after.z, 'blink rejected on cd');

    // Wait for cooldown to expire.
    h.runUntil(() => (hero.itemCooldowns['blink_dagger'] ?? 0) <= 0, h.seconds(12), 'cooldown expires');
    expectTrue((hero.itemCooldowns['blink_dagger'] ?? 0) <= 0, 'cooldown expired');
  }

  // ── Wards ──────────────────────────────────────────────────────────
  {
    const hero = h.spawnHero('w1', 1,
      h.findWalkableNear(h.shopPos.x + 100, h.shopPos.z - 60));
    hero.pos = { x: h.shopPos.x, z: h.shopPos.z };
    hero.gold = SHOP_ITEMS.find((i) => i.id === 'sentry_wards')!.cost;
    const wardIdx = SHOP_ITEMS.findIndex((i) => i.id === 'sentry_wards');
    h.issue('w1', { type: 'buy', itemIndex: wardIdx });
    h.tick();
    expectTrue(hero.wardCharges === 5, 'ward charges after buy');

    const slot = hero.inventory.indexOf('sentry_wards');
    expectTrue(slot !== -1, 'wards in inventory');

    const beforeWards = h.state.wards.length;
    h.issue('w1', { type: 'useItem', slot });
    h.tick();
    expectTrue(h.state.wards.length === beforeWards + 1, 'ward placed at hero');
    expectTrue(hero.wardCharges === 4, 'charge consumed');
  }

  // ── Ice Bow slow on hit ────────────────────────────────────────────
  {
    const { a: shooter, b: target } = h.spawnDuelists(300);

    shooter.pos = { x: h.shopPos.x, z: h.shopPos.z };
    shooter.gold = SHOP_ITEMS.find((i) => i.id === 'ice_bow')!.cost;
    const iceIdx = SHOP_ITEMS.findIndex((i) => i.id === 'ice_bow');
    h.issue(shooter.id, { type: 'buy', itemIndex: iceIdx });
    h.tick();
    expectTrue(shooter.inventory.includes('ice_bow'), 'ice bow bought');

    // Fire an arrow — on hit, target should get the slow debuff.
    h.issue(shooter.id, { type: 'cast', ability: 'arrow', x: target.pos.x, z: target.pos.z });
    const hitEvents = h.runUntil(
      (_s, evs) => evs.some((e) => e.type === 'hit'),
      h.seconds(2),
      'ice bow arrow hit',
    );
    expectTrue(hitEvents.some((e) => e.type === 'hit'), 'arrow hit');
    expectTrue(target.slowTimer > 0, `target slowed (t=${target.slowTimer.toFixed(3)})`);
    expectNear(target.slowTimer, ICE_BOW_SLOW_DURATION, 0.2, 'slow duration correct');
  }
}
