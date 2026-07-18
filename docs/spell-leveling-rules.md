# Spell Leveling Rules — Change Request (APPROVED)

> Status: approved 2026-07-17 with the following decisions:
> 1. E and R are locked until skilled. 2. E ranks reduce cooldown and extend
> duration; R ranks reduce cooldown and increase damage. 3. Hero cap raised
> to 18 for exact LoL parity (basics 5 ranks @ 1/3/5/7/9, ult @ 6/11/16).
> 4. Q auto-learned at rank 1 using the level-1 skill point (heroes start
> with 0 banked points; a maxed build completes exactly at level 18).

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

## Final spec for Archer Wars (hero cap raised 10 → 18)

| Ability | Ranks | Rank gates (hero level required) |
|---|---|---|
| Q — Arrow  | 5 | auto-learned rank 1 / 3 / 5 / 7 / 9  (rank ≤ ⌈level / 2⌉) |
| W — Dodge  | 5 | 1 / 3 / 5 / 7 / 9 |
| E — Reveal | 5 | 1 / 3 / 5 / 7 / 9 |
| R — Blast (ultimate) | 3 | **6 / 11 / 16** |

- **Skill points:** the level-1 point is **auto-spent on Q** (rank 1 — it's
  the hero's basic attack), then +1 per level → **17 spendable** points
  (levels 2–18) for the 17 remaining ranks. A fully maxed build completes
  exactly at level 18.
- **E and R start locked** (unusable) until a point is spent.
- Unspent points **bank** indefinitely; gates are level thresholds, not
  one-time windows.
- R points don't affect the Q/W/E gates.
- No refunds/respec mid-match.

### Per-rank stat tables

- **Q Arrow** (extends existing 4-rank progression to 5):
  damage 200/266/333/400/466 · range 800 (all ranks) ·
  cooldown 2.25/2.0/1.75/1.5/1.25 s
- **W Dodge**: duration 0.8 s (all ranks) · cooldown 8/7/6/5/4 s
- **E Reveal**: range 5000 (all ranks) · sight radius 800/1000/1200/1400/1600 ·
  cooldown 22/19/16/13/10 s
- **R Blast**: damage 300/425/550 · cooldown 20/17/14 s
  (cast range, radius, and 1.5 s fuse unchanged)

### XP curve extension (levels 11–18)

The existing curve adds +100 XP per step (200, 300, … 1000). Continued:

| Level | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
|---|---|---|---|---|---|---|---|---|
| Total XP | 6500 | 7700 | 9000 | 10400 | 11900 | 13500 | 15200 | 17000 |

Kill-XP for victims above level 10 stays at the 300 cap.

### Gate formulas (implementation)

- Basics: `rank ≤ min(5, ceil(level / 2))`
- Ultimate: rank cap = 0 below 6, 1 at 6–10, 2 at 11–15, 3 at 16+

### Concrete examples

- Level 1: Q is usable at rank 1 (your level-1 point, auto-spent); the next
  point arrives at level 2 and can go in W or E (not R, not Q — Q rank 2
  needs level 3).
- Level 6: R rank 1 becomes available. If you instead rank W at 6, you can
  still take R rank 1 at level 7 (or any later level).
- Level 11: R rank 2 available; level 16: R rank 3 (requires prior ranks).
- Levels 1–2: no ability can exceed rank 1 ("can't level Q at 1 and 2").
