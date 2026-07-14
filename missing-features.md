# Missing Features: Archer Wars Legacy 1.4d → Archer2

The original game is the Warcraft 3 custom map **"Archer Wars: Legacy 1.4d"** by cleeezzz. Its full implementation is in this repo: the game logic is `assets/war3map.j` (~14,600 lines of JASS, run through Vexorian's optimizer, so most function names are mangled — line numbers below are the reliable pointers), and object data is in `assets/war3map.w3t` (items), `assets/war3map.w3a` (abilities), `assets/war3map.w3u` (units), `assets/war3map.w3h` (buffs), and `assets/war3map.wts` (strings).

Our version (`src/`, TS/three.js) currently implements: click-to-move + A* pathfinding, hill terrain, static obstacles, a single instant-fire Arrow (Q, levels 1–4 with the original's exact damage/range/CD numbers), death/respawn, gold + XP, one shop item, and HUD widgets. Everything below is what the original has on top of that.

## 1. Six archer classes with unique ability kits — MISSING (biggest gap)

Original has 6 hero classes (**Assault, Sniper, Demolitionist, Mirror, Gravity, Time**), each an "Archer" variant with a distinct W/E/R kit; some classes are locked until you rank up. Our version has one generic hero and only the Q arrow — `src/ui/SpellBar.ts` renders W/E/R as empty placeholders.

- **Where:** class units in `assets/war3map.w3u`; ability data/tooltips in `assets/war3map.w3a`; "Locked" buff `B006` in `war3map.w3h`; unlock commands at `war3map.j:1331` (`-unlock`); spell-cast trigger wiring at `war3map.j:13640–13698`; skill-learn events at 13656/13743/13748.
- Per-class abilities (all missing):
  - **Assault:** Spread Shot (3 arrows, 150–350 dmg each, angle scales with cast distance, CD 15→10s); **Meld** (0.5–0.8s invisibility that makes arrows pass through you — the game's active dodge, CD 25→15s); **Holy Arrow** ult (450–750 dmg, shockwave, fire trail, self-heal 200–500); Assault Mastery (CD reduction passive).
  - **Sniper:** passive **distance-scaled bonus damage** (+distance/80, capped +200 — applied in the arrow engine at `war3map.j:6215–6219`); Sniper's Mark (map-wide mark + vision + bonus dmg); **Falcon** companion pet (dies → Sniper loses 40% max HP); Homing Beacon (arrows curve toward the Falcon, engine flags `XF/IF` at 6254–6256, 6274–6282, 6337–6346); **Blink** to Falcon's position at 40% max-HP cost (`war3map.j:9124–9136`).
  - **Demolitionist:** Fragmentation Arrows (expired arrows release 3 fragments, 100 dmg, 200 AoE — engine 6306–6324); **Detonate** (remote-detonate every arrow in flight, 125–200 dmg AoE, CD 15→10s).
  - **Mirror:** **Mirror Image** (each shot becomes 3 arrows at 35–40% dmg — child-arrow split in engine 6274–6282); Stars of Mirror ult (star formation, 400 dmg per arrow).
  - **Gravity:** **Black Hole / Gravity Field** (300–600 AoE field that curves ALL arrows in range); Gravity Enhance toggle (your arrows pull nearby arrows/enemies, 600 range pull loop at `war3map.j:6347–6374`, drains 1 mana/arrow).
  - **Time:** **Time Distort** (field that slows enemy arrows inside it, they regain speed on exit); **Time Warp** (teleports arrows in range forward 500–800 units; own arrows gain unlimited range).

## 2. Arrow-engine physics depth — PARTIALLY MISSING

Our `src/combat/Projectile.ts` flies straight at a fixed 900 speed. The original arrow engine is the heart of the game and supports:

- **Acceleration:** arrows start slow and accelerate to a max speed (`KD += FF` until `ZD`, `war3map.j:6271–6273`) — this is the dodge/skill-shot feel of the original.
- **Homing, curving, gravity pull, time-slow, image-splitting, fragmentation, detonation** (see §1) — the engine is a generic struct-driven projectile system.
- **One-hit-per-unit dedup group**, out-of-bounds death at arena walls, per-arrow hit radius.
- **Where:** arrow creation `P7` at `war3map.j:6020` (wrapper `U7` 6170); movement/collision loop `s__Arrow_Execute` at `war3map.j:6179`; explosion FX `GroundExpFX` 6173; collision filter (skips melded/invisible/invulnerable units) at 8046.

## 3. Mana system — MISSING

Original heroes have mana: abilities cost mana, items grant mana/mana regen, Mana Steal drains enemies, Gravity Enhance drains per arrow, respawn restores mana (`war3map.j:8392`). Our `src/entities/Hero.ts` has HP only.

## 4. Dodge/stealth & detection layer — MISSING

Meld (buff `BOwk`) makes an archer untargetable by arrow collision; counters are **Sentry Wards**, **Clear Sight**, gem, Sniper's Mark ("Revealed" buff `Bfae`). Arrow collision filter checks `not UnitHasBuffBJ('BOwk')` and visibility at `war3map.j:8046`. Ours has no invisibility, no detection, no buff system at all.

## 5. Ancient of War objective (base destruction) — MISSING

Every player owns an **Ancient of War** building (rawcodes `'eaom'/'e00A'/'e00C'`, array `IS[]`). Destroying it defeats that player: killer gets +20 gold, victim's items are refunded to gold and zeroed, their units removed, alliances dropped. It is also the **respawn anchor** (§9). Ours has no structures or defeat state.

- **Where:** Ancient-death handler `OJV` at `war3map.j:8697` (message 8714, +20g at 8718, cleanup `OHV` 8691); win-check filters 8655–8658.

## 6. Game modes & host mode-voting — MISSING

At game start, Player 1 gets a "Game List" multiboard and types mode commands, then `-done`: `-ffa`, `-2team`…`-6team`, `-dm X` (deathmatch, first to X kills, 10–100), `-rm` (round mode, 5–30 round wins), `-sg X` (starting gold 1–1000), `-fm` (fun mode), `-tl` (target lock), `-sp` (shuffle players). Ours has no modes and no match configuration.

- **Where:** mode multiboard `ICV` at `war3map.j:9960` (rows 9986–10063); `-done` handler 13243; mode chat registration 13210–13245; mode-state strings 7680–7800.

## 7. Win/loss, placements & match end — MISSING

Original ends matches three ways: last Ancient standing (with 3rd/2nd/1st **placement announcements** and scaled kill bonuses, `war3map.j:8756–8814`), deathmatch kill target (`KR`), and **round mode** (last team alive wins the round `O6V` at 9073, first to `SR` round wins takes the game, 9106–9112). Victory pauses all units and plays victory sound. Ours tracks K/D (`src/ui/KDDisplay.ts`) but has no win condition or match end whatsoever.

## 8. Teams, alliances & shared vision — MISSING

Teams as forces `WP[]`, per-team fog/vision `RT[]`, team-together start placement, ally/share chat engine (`sHV` at `war3map.j:2315`), un-allying on defeat. Ours has no team concept — friendly fire is avoided only by "skip projectile owner".

## 9. Respawn design — PARTIALLY MISSING

Ours respawns after a flat 3s at a random cell with 1.5s invulnerability (`src/core/Game.ts:245–316`, `Hero.ts:383–403`). The original:

- Delay scales with danger: `base + distance-from-your-Ancient-to-nearest-enemy / 1000` seconds (`X5V` at `war3map.j:8430`, calc 8468–8469).
- A "Revive:" **leaderboard countdown** shows the timer (8472–8476; tick `X4V` 8369).
- Revive happens **at your Ancient**, restores mana, **re-equips your stored inventory** (8389–8421).
- Spawn-kill protection is a visible shield buff `'BHds'` (`war3map.w3h`; toggled 8393–8395). (We have the invuln, not the visual/buff.)

## 10. Full item shop — MOSTLY MISSING (1 of ~25 items)

Ours has one passive item (Boots of Speed, `src/core/Game.ts:91–97`). The original shop (paged via a "View More Items [Z]" entry) has stack limits, **recipe/combine items**, **active items**, and on-hit procs. All item data in `assets/war3map.w3t`; refund values `H3` at `war3map.j:4773`; buy/sell triggers ~13689; bow procs applied inside the arrow engine at `war3map.j:6088–6132`. Items:

- **Boots of Speed** 20g (+40 MS, stack 2) → **Uber Boots** (recipe: 2×Boots + 35g scroll; +100 MS + **active: teleport to allied Ancient**, 20s CD).
- Ring of Regeneration 15g (+2 HP/s), Health Stone 25g (+100 HP), Vitality Fairy 50g (+200 HP) → **Mega Stone** recipe (+300 HP +4 regen); Sobi Mask 20g, Pendant of Mana 20g → **Mana Stone** recipe; Mega+Mana → **The Great Stone**.
- **Improved Bow** 100g (+25 dmg per skill, stack 3); **Fire Bow** 50g (+25 dmg, 18% burn DoT + flame ring — disabled in water); **Ice Bow** 50g (+25 dmg, 15% frost nova + 50% slow — **freezes** targets standing in water); **Lightning Bow** 50g (+25 dmg, 15% lightning 100–125 — **conducts through water**); **Elemental Bow** (+75 dmg, all three procs).
- **Critical Strike** 60g, upgradeable L1→L3 (10/15/20% for +25/33/50%; reroll logic 6115–6129).
- **Lifesteal** 70g (20%), **Double Shot** 30g (every 10th shot repeats), **Mana Steal** 30g (25% mana drain/shot), **Starfall** 30g (every 10 successive hits).
- **Sentry Wards** 10g (5 charges, 300s vision ward), **Clear Sight** 15g (true-sight vs Meld; **drops on death**).
- **Item refund on death/defeat:** unheld items convert back to gold (8412, 8728, 9017). Ours has no active items, recipes, procs, stack limits, or refunds.

## 11. Kill streaks, multi-kills & announcements — PARTIALLY MISSING

Ours computes first-blood/streak/multi-kill **gold** (`src/entities/Hero.ts:310–354`) but the announcement text is a TODO stub (Hero.ts:352) and there is **no audio**. The original broadcasts every event with a **sound**: First Blood (+5g); streaks at 3/6/10/15/21/28 kills — Killing Spree, Monster Kill, Mega Kill, Dominating, Unstoppable, Godlike, Beyond Godlike "SOMEONE KILL HIM!" (+1…+7g); Double Kill +15g, Triple Kill +30g; plus "…has been pwned by … for 5 gold!" on every kill.

- **Where:** kill handler `XRV` at `war3map.j:7903`; streak tables `E8V` 7829–7836; multi-kill `E9V` 7866; sounds loaded near 12869. Note: original gold economy is kill-only — our passive K/D-scaled income (`Hero.ts:179–184`) is an invention, and our +5g/kill matches.

## 12. Persistent rank save/load system — MISSING

13-rank kill ladder (New 0 → Beginner 10 → … → Angel 10,000 → **Goddess 20,000**); player names get a " (Rank)" suffix updated every second; "ranked up" announcements; ranks gate class unlocks (§1). `-save` prints an obfuscated code (name-keyed bit codec by Korolen) packing kills/deaths; `-load <code>` restores them next game. Ours has nothing persistent.

- **Where:** rank tables `D0V` at `war3map.j:12668` (thresholds 12688–12699); name suffix `D_V` 12656; rank-up message 8010; save `D5V` 12709; load `D7V` 12731; codec `VNV/VDV/VHV/VLV/VPV` 6604–6755; chat registration 13726/13736; ladder text `war3map.wts` STRING 4688.

## 13. Scoreboard multiboard — MISSING

A live board listing **every player's kills, deaths, and rank** (`IDV` at `war3map.j:10075`; refreshers `E5/O5/R5` 5224–5281), plus the revive-countdown leaderboard. Ours shows only the local player's K/D (`src/ui/KDDisplay.ts`).

## 14. Chat & player commands — MISSING

No chat exists in ours. Original player commands (quest text `war3map.wts` STRING 3385; registrations `war3map.j:13538–13736`): `-zoom xxxx` / `-zoom overhead` (camera, handler ~13708 — we do have wheel zoom), `-ms` (move speed), `-delay`, `-tt xx` (timed text), `-save`/`-load`, leaver phrases, and a `-hear` chat-spy (`Trig_Hear*` 1139–1213). There's also a large host/single-player **cheat pack** (`Cheatz` dispatcher at 1300, help list 1453–1537: `-gold`, `-lvl`, `-nocd`, `-mh`, arrow-key keybinds `BindKey` 1719, etc.) — dev tooling, low priority.

## 15. Water terrain interactions — MISSING

The original map has deep water detected via `IsTerrainPathable(..., PATHING_TYPE_FLOATABILITY)` (`war3map.j:8046, 8199–8236, 10589–10594`), and the elemental bows key off it: fire ring suppressed in water, ice **freezes** targets in water, lightning **conducts** to extra targets in water. Our terrain (`src/world/Terrain.ts`) has hills only — no water at all (game.md lists rivers as "future").

## 16. Destructible trees — MISSING

Arrows/explosions destroy trees in their blast radius (`EnumDestructablesInRect` + `KillDestructable` at `war3map.j:6243, 6321`; helpers `Y5` 5440, `CFV` 12047, `AHV` 10784), dynamically opening firing lanes. Our trees (`src/world/Obstacles.ts`) permanently block navigation and arrows.

## 17. 12-player multiplayer & leaver handling — MISSING

Original: 12 human slots (`config` at `war3map.j:13926`), leaver cleanup `X8V` 8483 (announce, remove units/Ancient, drop from forces). Ours is single-player with one static dummy target (`src/core/Game.ts:114–117`) — no networking, no AI (both already planned in `game.md`).

## 18. Small mechanics worth noting

- **Catch-up XP:** killer below victim's level gains `levelDiff×50` XP (`war3map.j:7930`) — ours has an equivalent underdog bonus (`Hero.ts:299`), so this one is covered.
- **Sound design generally** — the original has kill sounds, victory sound, streak lines; ours is silent.
- **Not in the original** (don't port): map runes/powerups, ice-sliding, shrinking map — confirmed absent from the script.

## Suggested priority order (if features get built later)

1. Charged/accelerating arrow + generic projectile engine hooks (§2) — enables everything else.
2. Win condition + deathmatch mode (§6–7), scoreboard (§13).
3. Item shop with bows/procs/recipes/actives (§10) + mana (§3).
4. One extra class kit (Assault: Spread Shot + Meld + Holy Arrow) to prove the class system (§1, §4).
5. Ancient objective + distance respawn (§5, §9), water (§15), destructible trees (§16).
6. Streak announcements/sounds (§11), ranks/persistence (§12), chat commands (§14), multiplayer (§17).
