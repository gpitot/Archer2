/**
 * Gem of Critical Strike: bought at the shop it grants a 20% chance for any
 * ability to deal double damage. Verifies the purchase path, the crit flag on
 * hit events, exact 2× damage on crits, and a plausible crit rate over many
 * shots (deterministic seeded RNG).
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';
import { ARROW, HERO } from '../src/sim/rules';
import { CRIT_CHANCE, SHOP_ITEMS } from '../src/sim/shopItems';

export const name = 'crit-strike';

export function run(h: SimHarness): void {
  const { a: shooter, b: target } = h.spawnDuelists(400);

  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();

  // ── Purchase ────────────────────────────────────────────────────────
  const gemIndex = SHOP_ITEMS.findIndex((i) => i.id === 'crit_gem');
  expectTrue(gemIndex !== -1, 'crit_gem exists in the shop catalogue');

  shooter.pos = { x: h.shopPos.x, z: h.shopPos.z };
  shooter.gold = SHOP_ITEMS[gemIndex].cost;
  h.issue('p1', { type: 'buy', itemIndex: gemIndex });
  h.tick();
  expectTrue(shooter.inventory.includes('crit_gem'), 'gem sits in inventory');
  expectTrue(shooter.gold === 0, 'gold was spent');
  expectTrue(shooter.critChance === CRIT_CHANCE, `critChance is ${CRIT_CHANCE}`);

  // Non-stackable: a second copy is refused.
  shooter.gold = SHOP_ITEMS[gemIndex].cost;
  h.issue('p1', { type: 'buy', itemIndex: gemIndex });
  h.tick();
  expectTrue(shooter.critChance === CRIT_CHANCE, 'second gem refused — chance stays 20%');
  expectTrue(shooter.gold === SHOP_ITEMS[gemIndex].cost, 'second purchase not charged');

  // ── Crit rolls over many arrows ─────────────────────────────────────
  const base = ARROW.damageByLevel[1];
  const shots = 60;
  let crits = 0;

  for (let i = 0; i < shots; i++) {
    // Refill so we never wait on recharge, and keep the target alive.
    shooter.abilityCharges = ARROW.maxCharges;
    shooter.abilityRecoilTimer = 0;
    target.hp = HERO.maxHp;

    h.issue('p1', { type: 'fire', aimX: target.pos.x, aimZ: target.pos.z });
    const events = h.runUntil((_s, evs) => evs.some((e) => e.type === 'hit'), h.seconds(2), `hit #${i + 1}`);
    const hit = events.find((e) => e.type === 'hit');
    if (!hit || hit.type !== 'hit') throw new Error('no hit event');

    if (hit.crit) {
      crits++;
      expectTrue(hit.damage === base * 2, `crit deals double damage (${hit.damage})`);
      expectTrue(target.hp === HERO.maxHp - base * 2, 'target hp reflects crit damage');
    } else {
      expectTrue(hit.damage === base, `normal hit deals base damage (${hit.damage})`);
      expectTrue(target.hp === HERO.maxHp - base, 'target hp reflects base damage');
    }
  }

  // 20% of 60 = 12 expected; the seeded LCG is deterministic, so this is a
  // stable regression check rather than a flaky statistical one.
  expectTrue(crits >= 4 && crits <= 24, `crit count plausible for 20% (${crits}/${shots})`);
  expectTrue(crits > 0, 'at least one crit landed');
}
