---
name: wc3-data-extraction
description: 'Extract game stats, ability data, hero attributes, and design values from the original Warcraft III map files (war3map.j, war3map.w3u, war3map.w3a, war3map.wts). Use when the user asks about original game implementation, hero stats per level, ability damage formulas, item costs, or any gameplay constants from "Archer Wars: Legacy 1.4d".'
---

# WC3 Map Data Extraction

Extracts game stats, ability formulas, hero attributes, and gameplay constants from the
original Warcraft III map **"Archer Wars: Legacy 1.4d"** by cleeezzz.

## Key Files

All original map assets live in `assets/` relative to the project root:

| File | Size | Purpose |
|------|------|---------|
| `assets/war3map.j` | 429 KB | **JASS trigger script** — all gameplay logic. ~14,600 lines, obfuscated by Vexorian's optimizer (function/variable names are mangled, e.g., `P7`, `GD`, `vfai_`). |
| `assets/war3map.w3u` | 23 KB | **Custom unit data** — hero classes, shops, ancients, dummy units. Binary SLK-based format. |
| `assets/war3map.w3a` | 107 KB | **Custom ability data** — arrow abilities, class spells, shop items. Binary SLK-based format. |
| `assets/war3map.w3t` | 22 KB | **Custom item data** — boots, bows, gems, recipes. Binary SLK-based format. |
| `assets/war3map.w3h` | 1 KB | **Custom buff data** — invuln shield, meld buffs. |
| `assets/war3map.wts` | 2 KB | **String table** — map name, credits, rank names, player commands. Plain text with `STRING <n> { ... }` format. |
| `assets/war3map.doo` | 491 KB | Doodad placement — tree/rock positions. |
| `assets/war3map.w3e` | 218 KB | Terrain heightmap + textures. |
| `assets/war3map.wpm` | 492 KB | Pathing map — walkable/unwalkable cells. |

## Methodology

### 1. Find Ability Damage/Range Formulas in JASS

The original map registers spell-cast events via triggers, then calls custom arrow-creation
functions (not WC3's built-in damage). To find damage formulas:

```bash
# Find arrow creation calls (P7 / U7 functions)
grep -n "call U7\|call P7" assets/war3map.j

# U7 is the wrapper, P7 is the implementation. Parameters:
#   U7(unitTypeId, caster, abilityLevel, cx, cy, tx, ty, 
#       collisionRadius, speed?, param?, param?, RANGE, DAMAGE, targetUnit, homingTarget)
```

**Key line numbers:**
- Arrow engine loop: `s__Arrow_Execute` at line **6179**
- Arrow creation wrapper `U7`: line **6170**
- Arrow creation `P7`: line **6020** (sets `PD[d]` = damage, `TD[d]` = range)
- Spread Shot (Assault): `AAV` at **10721** — calls `ARV(i)` for range, `AOV(i)` for damage
- Detonate/Frag (Demolitionist): `ACV` at **10749** — calls `ABV(i)` for range, `ANV(i)` for damage
- Mirror Image split: `A4V` at **10895** — calls `A3V(i)` for range, `A2V(i)` for damage
- Holy Arrow (ult): `CLV` at **12170** — calls `CKV(i)` for damage, range = 999999 (infinite)
- Normal hero shot: `BWV` at **11709** — uses per-unit stored `WK[b]`/`YK[b]`

**Damage formula functions** (each takes `i` = ability level 1–4):
```
AOV(i)  → return 350.0 + (100.0 * i) + 0.5     // Assault spread shot damage
ARV(i)  → return 1500.0 + (500.0 * i)           // Assault spread shot range
ANV(i)  → return 133.33 + (66.66 * i) + 0.5     // Demolitionist/Revolver damage ← JS port uses this
ABV(i)  → return 333.33 + (666.66 * i)          // Demolitionist/Revolver range
A2V(i)  → return 83.33 + (66.66 * i) + 0.5      // Illusionist mirror arrow damage
A3V(i)  → return 333.33 + (666.66 * i)          // Illusionist mirror arrow range
CKV(i)  → return 133.33 + (66.66 * i) + 0.5     // Holy Arrow / ult damage
```

**Sniper bonus damage** (applied in arrow engine, line **6237**):
```
damage = (GetUnitAbilityLevel(caster, 'A02L') * 25.0) + 100.0 + distance/80  // capped at +200
```

### 2. Parse Hero Stats from w3u (Binary Object Data)

The `.w3u` file uses the WC3 SLK-based modification format. Each entry is:
```
[4 bytes] modification_id (e.g., 'ustr', 'uagi', 'unam')
[4 bytes] data_type (0=int, 2=real/float, 3=string)
[4 bytes] value (int or float inline; for string: pointer offset into file)
```

**Quick one-liner to dump hero entries:**
```bash
python3 << 'PYEOF'
import struct
with open('assets/war3map.w3u', 'rb') as f:
    data = f.read()
# Find all hero unit IDs (E000-E00B) embedded in "EmooXXXX5" pattern
for hero_id in [b'E000', b'E004', b'E005', b'E006', b'E007', b'E008', b'E00B']:
    idx = data.find(hero_id)
    if idx < 0: continue
    # The 'unam' (name) field follows ~8 bytes after
    unam_off = data.find(b'unam', idx, idx + 50)
    if unam_off > 0:
        # Name string pointer is at unam_off + 12
        ptr = struct.unpack_from('<I', data, unam_off + 8)[0]
        end = data.index(0, ptr)
        name = data[ptr:end].decode('latin-1')
        print(f"\n=== {hero_id.decode()} = {name} ===")
    # Scan for stat fields within 200 bytes
    for field in [b'ustr', b'uagi', b'uint', b'ustp', b'uagp', b'uinp', b'umvs', b'uhpm']:
        foff = data.find(field, idx, idx + 200)
        if foff > 0:
            val_type = struct.unpack_from('<I', data, foff + 4)[0]
            val = struct.unpack_from('<I', data, foff + 8)[0]
            if val_type == 2:  # float
                val = struct.unpack_from('<f', data, foff + 8)[0]
                print(f"  {field.decode()}: {val:.2f}")
            else:
                print(f"  {field.decode()}: {val}")
PYEOF
```

**Hero unit IDs mapped to class names** (from w3u `unam` field):
| ID | Class | Abilities |
|----|-------|-----------|
| `E000` | Assault | A006/A022 (Spread), A011/A017 (Detonate), A003/A006 (Meld) |
| `E004` | Gravity | A011/A017 (Black Hole), A021 (Gravity Enhance) |
| `E005` | Time | A011/A017 (Time Distort), A022 (Time Warp) |
| `E006` | Illusionist | A003/A021 (Mirror Image), A022 (Stars of Mirror) |
| `E007` | Demolitionist | A011/A017 (Frag Arrow), A006/A022 (Detonate) |
| `E008` | Sniper | A028/A027 (Sniper Shot), A029 (Falcon), A02C (Homing Beacon) |
| `E00B` | Revolver | A011/A017 (Standard Arrow), A006/A022 |

### 3. Find Physical/Combat Stats in JASS

```bash
# Kill reward and XP (line ~7926)
grep -n "GetHeroLevel\|SetHeroXP\|KILL.*gold\|xp.*reward\|first.*blood" assets/war3map.j

# Movement speed display (line 10792)
grep -n "movespeed\|GetUnitMoveSpeed\|SetUnitMoveSpeed" assets/war3map.j

# HP, mana references
grep -n "UNIT_STATE_LIFE\|UNIT_STATE_MANA\|SetUnitState\|GetUnitState" assets/war3map.j | head -30

# Respawn logic (line ~8391, ~9000)
grep -n "ReviveHero\|respawn\|Respawn\|respawnTimer" assets/war3map.j
```

**Key extracted constants:**
- Kill gold: **5g** base, +5g first blood, streak bonuses at 3/6/10/15/21/28 kills (+1 to +7g)
- XP from kills: `KILL_XP_TABLE[victimLevel]`, bonus `50 * levelDifference` when killer is lower level
- Move speed display: `GetUnitMoveSpeed(hero) - 1` (object data `umvs` = 1 for all heroes — likely overridden)
- HP: referenced via `GetUnitState(u, UNIT_STATE_LIFE)`, no hardcoded constant found in JASS

### 4. Find Item Data in JASS

```bash
# Item buy/refund logic
grep -n "H3\|item.*cost\|item.*gold\|refund\|GetItemTypeId" assets/war3map.j | head -20

# Item effects inside arrow engine (line ~6088-6132)
# Search for item procs: 'I005', 'I00G', 'I00F', 'I00J', 'I00M'
```

### 5. Read String Table

```bash
cat assets/war3map.wts
```
Contains rank names, player commands, credits. Plain text.

### 6. Find Event Wiring (Spell Cast → Arrow Launch)

```bash
# Spell-cast event registrations
grep -n "GetSpellAbilityId\|EVENT_PLAYER_UNIT_SPELL" assets/war3map.j | head -40

# Arrow ability IDs:
#   A00D = dummy "loading" arrow (level 1, hidden)
#   A01X = real arrow ability (levels 1-4, replaces A00D on first shot)
#   A011/A017 = Demolitionist/Gravity/Time/Revolver Q
#   A006/A022 = Assault W / Revolver W (Spread/Detonate)
#   A003/A021 = Mirror/Illusionist E
#   A028/A027 = Sniper abilities
#   A029 = Sniper Falcon
#   A02C = Sniper Homing Beacon
#   A02L = Holy Arrow (ult)
#   A02B = class selection dummy (removed after picking)
```

## Known Gap: w3u Binary Parser

The current approach uses `data.find()` to locate field IDs in the binary. A proper
SLK-based w3u parser would:

1. Read the header: version (4 bytes) + table_id (4 bytes)
2. Parse entries sequentially: original_id (4) + n_custom_or_mods (4)
3. For `n_custom == 0`: modifications apply to original unit; next 4 bytes = n_mods
4. For `n_custom > 0`: that many custom unit entries follow, each: custom_id (4) + n_mods (4)
5. Each modification: mod_id (4) + data_type (4) + value_or_ptr (4)
   - Type 0 = int, Type 2 = float, Type 3 = string pointer

The hero entries are modifications to base unit `hgyr` (Gryphon Rider), with custom IDs
`E000`–`E00B`. The entries don't have clear boundaries in the binary due to variable
string data — the `unam` (name) field is the most reliable delimiter.

## Quick Reference: JS Port's Source of Truth

The JS implementation in `src/sim/rules.ts` claims values were "lifted verbatim from the
original `Hero` and `ArrowAbility` classes." Cross-referencing:

| JS Constant | Original Source | Match? |
|-------------|----------------|--------|
| `HERO.maxHp = 100` | Object data `uhpm` (varies per class) | **Unclear** — w3u has `uhpm=0` for all heroes |
| `HERO.baseSpeed = 480` | Object data `umvs = 1` | **No** — original uses trigger-based speed |
| Arrow damage `[200,266,333,400]` | `ANV(i)` = `133.33+66.66*i` | ✅ **Exact match** |
| Arrow range `[800,1333,1866,2400]` | `ABV(i)` / 1.25 scaling | **Close** — original ranges are `[1000,1667,2333,3000]` |
| Arrow cooldown `[2.25,2.0,1.75,1.5]` | WC3 ability cooldown field in w3a | **Unverified** |
| `XP_TABLE` | WC3 hero XP constants | **Unverified** (WC3 uses built-in XP curve) |
| `KILL_GOLD.base = 5` | JASS line 7946 | ✅ **Exact match** |

## Tips for Navigating Obfuscated JASS

- Function names starting with `vfai_` are from an AI/command system (ignore for gameplay)
- Look for native WC3 function calls (`GetUnitX`, `CreateUnit`, `SetUnitState`) to find relevant logic
- Ability IDs like `'A01X'` are 4-character codes — grep them to trace a single mechanic
- The `s__` prefix indicates vJASS struct methods (e.g., `s__Arrow_Execute`)
- `DisplayTextToPlayer` / `DisplayTimedTextToPlayer` calls often reveal debug messages
- Comments in the JASS (lines starting with `//`) are rare but valuable when present
