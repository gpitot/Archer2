# Spell Leveling Rules — Change Request (for approval)

## Reference: how League of Legends does it

LoL is the model that matches the requested behaviour (R at 6/11/16). Its rules:

1. **One skill point per champion level.** You get a point at level 1 and one
   more each level-up (18 levels → 18 points).
2. **Points are never lost.** If you don't spend a point (or can't spend it
   where you want), it banks and can be spent any time later. Gates are
   *level thresholds*, not one-time windows — if you skip R at 6, you can
   still rank it at 7, 8, …
3. **Basic abilities (Q/W/E) have 5 ranks**, gated by champion level:
   an ability's rank may not exceed **⌈level / 2⌉**.
   - Rank 1: level 1+
   - Rank 2: level 3+
   - Rank 3: level 5+
   - Rank 4: level 7+
   - Rank 5: level 9+
   - So at level 1–2 an ability can only be rank 1 ("you can't level up Q at
     level 1 and 2"), at 3–4 max rank 2, etc.
4. **The ultimate (R) has 3 ranks**, gated separately:
   - Rank 1: level 6+
   - Rank 2: level 11+
   - Rank 3: level 16+
   - R points count toward your total but do **not** relax the basic-ability
     gates (levelling R at 6 doesn't let Q reach rank 4 earlier).
5. **No refunds / respec** during a match.

(Dota 2 differs: 4-rank basics, ult at 6/12/18, and no ⌈L/2⌉ gate on basics —
you *can* have Q rank 2 at level 2. The 6/11/16 pattern you described is LoL,
so LoL rules are used as the base.)

## Proposed adaptation for Archer Wars

Our hero caps at **level 10** (not 18), so the thresholds are compressed:

| Ability | Ranks | Rank gates (hero level required) |
|---|---|---|
| Q — Arrow  | 4 | 1 / 3 / 5 / 7  (rank ≤ ⌈level / 2⌉) |
| W — Dodge  | 4 | 1 / 3 / 5 / 7 |
| E — Reveal | 4 | 1 / 3 / 5 / 7 |
| R — Blast (ultimate) | 3 | **6 / 8 / 10** |

- **Skill points:** 1 at level 1, +1 per level → **10 total**.
- Max total ranks = 4+4+4+3 = **15**, so you can never max everything —
  builds stay meaningful (LoL has the same property: 18 points vs 18 ranks,
  but here it's tighter).
- Unspent points **bank** indefinitely; the level-up UI stays available until
  spent.
- R gates scale LoL's 6/11/16 onto a 10-level curve (unlock at 6, then every
  2 levels). R points don't affect the Q/W/E gates.
- No refunds/respec mid-match.

### Concrete examples

- Level 1: you may put your point in Q, W, or E (not R). Q cannot reach
  rank 2 until level 3 even if you bank the level-2 point.
- Level 6: R rank 1 becomes available. If you instead rank W at 6, you can
  still take R rank 1 at level 7 (or any later level).
- Level 8: R rank 2 available (requires rank 1 first, of course).
- Level 10: R rank 3 available; a typical finished build is one maxed basic
  (4), a second basic at 3, third untouched or vice-versa, and R at 3.

### Implementation notes (current code)

- `stepMatch.ts` `learnAbility`-style handler currently only checks
  `skillPoints > 0` and per-ability `maxLevel` — needs the two gate checks:
  - basics: `newRank <= ceil(hero.level / 2)`
  - ultimate: `newRank <= floor((hero.level - 4) / 2)` i.e. 1@6, 2@8, 3@10
- E (Reveal) and R (Blast) are currently fixed-power, always-available
  abilities with no ranks. This change makes them **learned/ranked**:
  they start unlearned (unusable) and need per-rank stat tables.

## Open questions for approval

1. **E and R become locked until skilled** — currently they're free from
   level 1. Confirm this is intended (it's the MOBA norm).
2. **Per-rank numbers for E and R** need designing. Strawman:
   - E Reveal: cooldown 15/12/9/6 s, duration 2/2.5/3/3.5 s
   - R Blast: damage 300/425/550, cooldown 20/17/14 s
3. R gates at **6/8/10** — alternative would be 6/9/10 or raising hero max
   level to 18 to copy LoL exactly. Preference?
4. Should Q start pre-learned at rank 1 (so new players always have an
   attack), with the level-1 point free to spend elsewhere? LoL does *not*
   do this, but our hero's basic attack **is** Q.
