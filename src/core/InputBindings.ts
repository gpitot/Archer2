/**
 * Keyboard input bindings extracted from Game.ts. Takes an `InputManager`
 * and a set of callbacks, then wires QWER abilities, item hotkeys, camera,
 * shop, and targeting keys.
 */
import { ABILITIES, ABILITY_ORDER, AbilityDef, canCast } from '../sim/abilities';
import { SHOP_ITEMS, SHOP_ITEMS_BY_ID } from '../sim/shopItems';
import type { InputManager } from '../input/InputManager';
import type { TargetingSystem } from '../input/TargetingSystem';
import { shopHotkeyCode } from '../ui/shopHotkeys';
import type { Command, HeroState } from '../sim/state';

export interface InputCallbacks {
  /** Current player hero state (read fresh on each keypress). */
  getPlayerState: () => HeroState;
  /** Enqueue a sim command (prediction + wire). */
  enqueueCommand: (cmd: Command) => void;
  /** Activate ground-targeting for a point-targeted ability (e.g. R blast). */
  activateAbilityTargeting: (def: AbilityDef) => void;
  /** Activate ground-targeting for an item with point-targeted on-use. */
  activateItemTargeting: (def: import('../sim/shopItems').ShopItemDef, slot: number) => void;
  /** Open the shop window. */
  openShop: () => void;
  /** Close the shop window. */
  closeShop: () => void;
  /** True when the player is within interact range of the shop. */
  isPlayerNearShop: () => boolean;
  /** True when the shop window is currently visible. */
  isShopVisible: () => boolean;
  /** The shop index of the currently open shop window. */
  getShopIndex: () => number;
  /** Snap camera to hero position (one-shot). */
  centerOnHero: () => void;
  /** Toggle the scoreboard modal. */
  toggleScore: () => void;
  /** True when the scoreboard window is currently visible. */
  isScoreVisible: () => boolean;
}

/** Register all gameplay keyboard bindings on the given InputManager. */
export function bindInput(input: InputManager, targeting: TargetingSystem, cb: InputCallbacks): void {
  // ── Click interceptor ──
  input.setClickInterceptor((pos) => targeting.handleClick(pos.x, pos.z));
  input.onRightClick(() => targeting.cancel());

  // QWER ability keys — one binding per registry entry.
  const SLOT_CODES: Record<AbilityDef['slot'], string> = {
    Q: 'KeyQ', W: 'KeyW', E: 'KeyE', R: 'KeyR',
  };
  for (const abilityId of ABILITY_ORDER) {
    const def = ABILITIES[abilityId];
    input.onKeyDown(SLOT_CODES[def.slot], () => {
      if (input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight')) {
        targeting.cancel();
        cb.enqueueCommand({ type: 'levelAbility', ability: abilityId });
        return;
      }
      if (def.targeting === 'point') {
        if (targeting.isActive && targeting.sourceItemId === abilityId) {
          targeting.cancel();
          return;
        }
        targeting.cancel();
        cb.activateAbilityTargeting(def);
        return;
      }
      targeting.cancel();
      const p = cb.getPlayerState();
      if (!p || !canCast(def, p)) return;
      if (def.targeting === 'self') {
        cb.enqueueCommand({ type: 'cast', ability: abilityId });
        return;
      }
      const aim = input.aimPosition;
      cb.enqueueCommand({
        type: 'cast',
        ability: abilityId,
        x: aim ? aim.x : p.pos.x + Math.sin(p.facing) * 100,
        z: aim ? aim.z : p.pos.z + Math.cos(p.facing) * 100,
      });
    });
  }

  // B — Open shop when near
  input.onKeyDown('KeyB', () => {
    if (cb.isShopVisible?.() ?? false) {
      cb.closeShop();
    } else if (cb.isPlayerNearShop()) {
      cb.openShop();
    }
  });

  // Escape — cancel targeting, close scoreboard, or close shop
  input.onKeyDown('Escape', () => {
    if (targeting.isActive) { targeting.cancel(); return; }
    if (cb.isScoreVisible()) { cb.toggleScore(); return; }
    cb.closeShop();
  });

  // Tab — toggle scoreboard
  input.onKeyDown('Tab', () => {
    cb.toggleScore();
  });

  // Space — snap camera to hero (one-shot, no follow)
  input.onKeyDown('Space', () => { cb.centerOnHero(); });

  // Letter hotkeys: buy the matching shop slot while the shop is open.
  // The shop outgrew the ten digits, and digits belong to the inventory, so
  // shop slots get letters from the reserved-safe pool in shopHotkeys.ts.
  for (let i = 0; i < SHOP_ITEMS.length; i++) {
    const code = shopHotkeyCode(i);
    if (!code) break;
    input.onKeyDown(code, () => {
      if (!cb.isShopVisible()) return;
      cb.enqueueCommand({ type: 'buy', shopIndex: cb.getShopIndex(), itemIndex: i });
    });
  }

  // Number keys 1–6: use the item in that inventory slot.
  for (let i = 1; i <= 6; i++) {
    input.onKeyDown(`Digit${i}`, () => {
      const slot = i - 1;
      const p = cb.getPlayerState();
      if (slot >= p.inventory.length) return;
      const itemId = p.inventory[slot];
      const def = itemId ? SHOP_ITEMS_BY_ID[itemId] : undefined;

      // Toggle: if same item's targeting is already active, cancel.
      if (targeting.isActive && itemId && targeting.sourceItemId === itemId) {
        targeting.cancel();
        return;
      }
      targeting.cancel();

      if (def?.use?.targeting === 'point') {
        cb.activateItemTargeting(def, slot);
        return;
      }
      cb.enqueueCommand({ type: 'useItem', slot });
    });
  }
}
