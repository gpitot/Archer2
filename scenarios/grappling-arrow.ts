/**
 * Grappling Arrow: hooking terrain reels the grappler in, hooking a hero
 * drags that hero toward the grappler, and the hook respects its cooldown.
 */
import { SimHarness, expectTrue, expectNear } from '../scripts/harness/SimHarness';
import { Vec2 } from '../src/sim/math';
import {
  SHOP_ITEMS,
  GRAPPLE_COOLDOWN,
  GRAPPLE_HERO_PULL_DISTANCE,
  GRAPPLE_PULL_DURATION,
  GRAPPLE_RANGE,
  GRAPPLE_STUN_EXTRA,
} from '../src/sim/shopItems';
import { HERO } from '../src/sim/rules';

export const name = 'grappling-arrow';

const GRAPPLE_IDX = SHOP_ITEMS.findIndex((i) => i.id === 'grappling_arrow');
const GRAPPLE_COST = SHOP_ITEMS[GRAPPLE_IDX].cost;

/** Buy the hook at the shop and return the inventory slot it landed in. */
function buyGrapple(h: SimHarness, heroId: string): number {
  const hero = h.hero(heroId);
  hero.pos = { x: h.shopPos.x, z: h.shopPos.z };
  hero.gold = GRAPPLE_COST;
  h.issue(heroId, { type: 'buy', shopIndex: 0, itemIndex: GRAPPLE_IDX });
  h.tick();
  const slot = hero.inventory.indexOf('grappling_arrow');
  expectTrue(slot !== -1, 'grappling arrow in inventory');
  return slot;
}

export function run(h: SimHarness): void {
  // ── Hooking terrain pulls the grappler toward it ───────────────────
  {
    const hero = h.spawnHero('g1', 0, h.findWalkableNear(h.shopPos.x, h.shopPos.z));
    const slot = buyGrapple(h, 'g1');

    // Find a solid obstacle in hook range with a clear line to it, and stand
    // off from it so the pull has somewhere to travel.
    let aim: Vec2 | null = null;
    let start: Vec2 | null = null;
    for (const ob of h.world.obstacles) {
      const center = { x: (ob.minX + ob.maxX) / 2, z: (ob.minZ + ob.maxZ) / 2 };
      const half = Math.max(ob.maxX - ob.minX, ob.maxZ - ob.minZ) / 2;
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 6) {
        const standoff = half + GRAPPLE_RANGE * 0.6;
        const from = h.findWalkableNear(
          center.x + Math.cos(angle) * standoff,
          center.z + Math.sin(angle) * standoff,
        );
        const gap = Math.hypot(center.x - from.x, center.z - from.z);
        if (gap < half + 150 || gap > GRAPPLE_RANGE * 0.9) continue;
        // Clear all the way to the obstacle's edge — the hook must reach *this*
        // obstacle, not something else in the way.
        const edge = {
          x: center.x + ((from.x - center.x) / gap) * (half + 20),
          z: center.z + ((from.z - center.z) / gap) * (half + 20),
        };
        if (!h.hasLineOfSight(from, edge)) continue;
        start = from;
        aim = center;
        break;
      }
      if (aim) break;
    }
    expectTrue(aim !== null && start !== null, 'found a hookable obstacle');

    hero.pos = { x: start!.x, z: start!.z };
    const before = { x: hero.pos.x, z: hero.pos.z };
    const distBefore = Math.hypot(aim!.x - before.x, aim!.z - before.z);

    h.issue('g1', { type: 'useItem', slot, x: aim!.x, z: aim!.z });
    expectTrue((hero.itemCooldowns['grappling_arrow'] ?? 0) === 0, 'hook off cooldown before use');

    // The hook flies, latches, and the yank runs for its full duration.
    h.runUntil(() => hero.pullTimer > 0, h.seconds(1), 'hook latches onto terrain');
    expectTrue((hero.itemCooldowns['grappling_arrow'] ?? 0) > 0, 'hook on cooldown after use');
    h.runUntil(() => hero.pullTimer <= 0, h.seconds(GRAPPLE_PULL_DURATION + 0.5), 'yank completes');

    const distAfter = Math.hypot(aim!.x - hero.pos.x, aim!.z - hero.pos.z);
    expectTrue(
      distAfter < distBefore - 100,
      `grappler reeled toward the obstacle (${distBefore.toFixed(0)} → ${distAfter.toFixed(0)})`,
    );
    expectTrue(hero.pullFrom === undefined, 'pull state cleared after arrival');

    // Cooldown gate: a second hook while it's down does nothing.
    const projectilesBefore = h.state.projectiles.length;
    h.issue('g1', { type: 'useItem', slot, x: aim!.x, z: aim!.z });
    h.tick();
    expectTrue(h.state.projectiles.length === projectilesBefore, 'second hook rejected on cooldown');
    expectTrue((hero.itemCooldowns['grappling_arrow'] ?? 0) <= GRAPPLE_COOLDOWN, 'cooldown not re-armed');
  }

  // ── Hooking a hero drags them toward the grappler ──────────────────
  {
    const { a: grappler, b: victim } = h.spawnDuelists(400);
    const slot = buyGrapple(h, grappler.id);

    // buyGrapple parked the grappler at the shop; restore the duel spacing.
    const startGap = 400;
    const dir = {
      x: (victim.pos.x - h.shopPos.x) / Math.hypot(victim.pos.x - h.shopPos.x, victim.pos.z - h.shopPos.z),
      z: (victim.pos.z - h.shopPos.z) / Math.hypot(victim.pos.x - h.shopPos.x, victim.pos.z - h.shopPos.z),
    };
    victim.pos = h.findWalkableNear(
      grappler.pos.x + dir.x * startGap,
      grappler.pos.z + dir.z * startGap,
    );
    expectTrue(h.hasLineOfSight(grappler.pos, victim.pos), 'clear line to the victim');

    const gapBefore = Math.hypot(victim.pos.x - grappler.pos.x, victim.pos.z - grappler.pos.z);
    const victimHpBefore = victim.hp;

    h.issue(grappler.id, { type: 'useItem', slot, x: victim.pos.x, z: victim.pos.z });
    h.runUntil(() => victim.pullTimer > 0, h.seconds(1), 'hook catches the victim');
    h.runUntil(() => victim.pullTimer <= 0, h.seconds(GRAPPLE_PULL_DURATION + 0.5), 'drag completes');

    // The duel gap (400) is well under the pull cap (1000), so the victim is
    // dragged the whole way to the stand-off rather than a fixed distance.
    const standoff = HERO.bodyRadius * 2;
    const gapAfter = Math.hypot(victim.pos.x - grappler.pos.x, victim.pos.z - grappler.pos.z);
    expectTrue(
      gapAfter < gapBefore - 200,
      `victim dragged in (${gapBefore.toFixed(0)} → ${gapAfter.toFixed(0)})`,
    );
    expectNear(
      gapAfter,
      standoff,
      60, // the destination snaps to walkable ground, so allow some slack
      'victim brought to the stand-off, not stacked on the grappler',
    );
    expectTrue(victim.hp === victimHpBefore, 'the hook deals no damage');
    expectTrue(grappler.pullTimer <= 0, 'the grappler is not moved by a hero hook');

    // ── The hook stuns for the drag plus half a second ───────────────
    expectTrue(victim.stunTimer > 0, 'victim still stunned after the drag lands');
    expectNear(victim.stunTimer, GRAPPLE_STUN_EXTRA, 0.12, 'roughly the extra stun remains');
    expectTrue(grappler.stunTimer <= 0, 'the grappler is not stunned by their own hook');

    // A stunned hero ignores orders outright.
    const stunnedAt = { x: victim.pos.x, z: victim.pos.z };
    h.issue(victim.id, { type: 'moveTo', x: stunnedAt.x + 400, z: stunnedAt.z });
    h.tick();
    expectTrue(!victim.moving && victim.path.length === 0, 'move order rejected while stunned');

    // …and acts again once it expires.
    h.runUntil(() => victim.stunTimer <= 0, h.seconds(1), 'stun expires');
    h.issue(victim.id, { type: 'moveTo', x: stunnedAt.x + 400, z: stunnedAt.z });
    h.tick();
    expectTrue(victim.moving, 'move order accepted once the stun expires');
  }

  // ── The hook catches creeps too, and stuns them the same way ───────
  {
    const hero = h.spawnHero('g3', 0, h.findWalkableNear(h.shopPos.x, h.shopPos.z));
    const slot = buyGrapple(h, 'g3');

    // The hook grabs heroes in preference to creeps, and the earlier blocks
    // left their duelists parked around the shop — shove them well clear so
    // this shot can only reach the creep.
    for (const other of h.state.heroes) {
      if (other.id === 'g3') continue;
      other.pos = { x: h.shopPos.x, z: h.shopPos.z - 3000 };
    }

    // Park the camp in front of the hero, inside hook range with a clear line.
    const campPos = h.findWalkableNear(hero.pos.x + 500, hero.pos.z);
    const [creep] = h.spawnCamp('gcamp', campPos, ['ghoul']);
    expectTrue(h.hasLineOfSight(hero.pos, creep.pos), 'clear line to the creep');

    const creepGapBefore = Math.hypot(creep.pos.x - hero.pos.x, creep.pos.z - hero.pos.z);
    const creepHpBefore = creep.hp;

    h.issue('g3', { type: 'useItem', slot, x: creep.pos.x, z: creep.pos.z });
    h.runUntil(() => creep.pullTimer > 0, h.seconds(1), 'hook catches the creep');
    expectTrue(creep.stunTimer > 0, 'hooked creep is stunned');

    h.runUntil(() => creep.pullTimer <= 0, h.seconds(GRAPPLE_PULL_DURATION + 0.5), 'creep drag completes');
    const creepGapAfter = Math.hypot(creep.pos.x - hero.pos.x, creep.pos.z - hero.pos.z);
    expectTrue(
      creepGapAfter < creepGapBefore - 200,
      `creep dragged in (${creepGapBefore.toFixed(0)} → ${creepGapAfter.toFixed(0)})`,
    );
    expectTrue(creep.hp === creepHpBefore, 'the hook deals no damage to creeps');

    // A stunned creep holds still even with the hero standing on top of it.
    const heldAt = { x: creep.pos.x, z: creep.pos.z };
    h.tick(2);
    expectTrue(
      creep.pos.x === heldAt.x && creep.pos.z === heldAt.z,
      'stunned creep does not chase',
    );
    h.runUntil(() => creep.stunTimer <= 0, h.seconds(1), 'creep stun expires');
  }
}
