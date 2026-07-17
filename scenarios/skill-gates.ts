/**
 * MOBA-style skill-point gates (LoL model):
 *  - The level-1 skill point is auto-spent on Q (rank 1, the basic attack).
 *  - Basics (Q/W/E) are capped at rank ceil(heroLevel / 2), max 5.
 *  - The ultimate (R) unlocks ranks at hero levels 6 / 11 / 16, max 3.
 *  - Unspendable points bank; gates are thresholds, not one-time windows.
 */
import { SimHarness, expectTrue } from '../scripts/harness/SimHarness';

export const name = 'skill-gates';

export function run(h: SimHarness): void {
  const { a: hero } = h.spawnDuelists(400);

  // The level-1 point is auto-spent on Q: rank 1, nothing banked.
  expectTrue(hero.abilities.arrow.level === 1, 'Q auto-learned at rank 1');
  expectTrue(hero.skillPoints === 0, 'level-1 point consumed by Q');

  // Level 1 with a banked point: Q rank 2 is gated (cap = ceil(1/2) = 1)
  // and R is locked.
  hero.skillPoints = 1;
  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();
  expectTrue(hero.abilities.arrow.level === 1 && hero.skillPoints === 1, 'Q rank 2 blocked at level 1');
  h.issue('p1', { type: 'levelAbility', ability: 'blast' });
  h.tick();
  expectTrue(hero.abilities.blast.level === 0 && hero.skillPoints === 1, 'R blocked before level 6');

  // R is unusable while unlearned — the cast command is ignored.
  h.issue('p1', { type: 'cast', ability: 'blast', x: hero.pos.x + 300, z: hero.pos.z });
  h.tick();
  expectTrue(h.state.blasts.length === 0, 'unlearned R cannot cast');

  // Basic rank 1 (here W) is allowed at level 1.
  h.issue('p1', { type: 'levelAbility', ability: 'dodge' });
  h.tick();
  expectTrue(hero.abilities.dodge.level === 1 && hero.skillPoints === 0, 'W rank 1 learned at level 1');

  // Level 5 with banked points: Q climbs only to the cap (ceil(5/2) = 3).
  hero.level = 5;
  hero.skillPoints = 4;
  for (let i = 0; i < 4; i++) {
    h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
    h.tick();
  }
  expectTrue(hero.abilities.arrow.level === 3, `Q capped at rank 3 at level 5 (got ${hero.abilities.arrow.level})`);
  expectTrue(hero.skillPoints === 2, 'unspendable points banked');

  // Level 6: R rank 1 unlocks; rank 2 stays gated until 11.
  hero.level = 6;
  h.issue('p1', { type: 'levelAbility', ability: 'blast' });
  h.tick();
  expectTrue(hero.abilities.blast.level === 1, 'R rank 1 available at level 6');
  h.issue('p1', { type: 'levelAbility', ability: 'blast' });
  h.tick();
  expectTrue(hero.abilities.blast.level === 1 && hero.skillPoints === 1, 'R rank 2 blocked until 11');

  // Threshold, not a window: E rank 1 (skipped so far) still learnable later.
  hero.level = 7;
  h.issue('p1', { type: 'levelAbility', ability: 'reveal' });
  h.tick();
  expectTrue(hero.abilities.reveal.level === 1, 'skipped ability still learnable later');

  // Levels 11 and 16 open R ranks 2 and 3; rank 3 is the hard max.
  hero.level = 11;
  hero.skillPoints = 3;
  h.issue('p1', { type: 'levelAbility', ability: 'blast' });
  h.tick();
  expectTrue(hero.abilities.blast.level === 2, 'R rank 2 at level 11');
  hero.level = 16;
  h.issue('p1', { type: 'levelAbility', ability: 'blast' });
  h.tick();
  expectTrue(hero.abilities.blast.level === 3, 'R rank 3 at level 16');
  h.issue('p1', { type: 'levelAbility', ability: 'blast' });
  h.tick();
  expectTrue(hero.abilities.blast.level === 3 && hero.skillPoints === 1, 'R capped at rank 3');

  // Basics cap at rank 5 (reachable from level 9).
  hero.level = 18;
  hero.skillPoints = 4;
  for (let i = 0; i < 4; i++) {
    h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
    h.tick();
  }
  expectTrue(hero.abilities.arrow.level === 5, 'Q reaches rank 5 at high level');
  expectTrue(hero.skillPoints === 2, 'points past rank 5 stay banked');
}
