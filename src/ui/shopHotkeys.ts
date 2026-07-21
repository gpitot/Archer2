/**
 * Letter hotkeys for the shop window.
 *
 * The shop carries more than ten items, so digits no longer cover the list
 * (and they're already taken by the six inventory slots). Letters are handed
 * out in order from a pool that skips every key the game already binds:
 * Q/W/E/R (abilities) and B (open/close shop).
 */

/** Keys bound elsewhere in gameplay — never handed to a shop slot. */
const RESERVED = new Set(['Q', 'W', 'E', 'R', 'B']);

/** Letters available as shop hotkeys, in assignment order. */
export const SHOP_HOTKEYS: readonly string[] = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter(
  (c) => !RESERVED.has(c),
);

/** Hotkey letter for the nth shop slot, or null once the pool runs out. */
export function shopHotkey(index: number): string | null {
  return SHOP_HOTKEYS[index] ?? null;
}

/** KeyboardEvent.code for the nth shop slot (e.g. 'KeyA'), or null. */
export function shopHotkeyCode(index: number): string | null {
  const letter = shopHotkey(index);
  return letter ? `Key${letter}` : null;
}
