import { ShopItem } from '../world/Shop';
import { Tooltip } from './Tooltip';
import { SHOP_ITEMS_BY_ID, itemTooltip } from '../sim/shopItems';
import { shopHotkey } from './shopHotkeys';

interface ShopCallback {
  onBuy: (shopIndex: number, itemIndex: number) => void;
  onClose: () => void;
}

/** Per-card element refs, so `refresh` can restyle without rebuilding. */
interface ShopCard {
  el: HTMLDivElement;
  tile: HTMLDivElement;
  icon: HTMLSpanElement;
  cost: HTMLDivElement;
  key: HTMLSpanElement;
}

/** Cards per row — 4 keeps a 12-item shop to three tidy rows. */
const COLUMNS = 4;

/** Card visuals per state, so open() and refresh() can't drift apart. */
const CARD_STYLES = {
  buyable: {
    background: 'linear-gradient(180deg, rgba(62,44,20,0.92), rgba(34,24,11,0.92))',
    border: '1px solid rgba(214,168,74,0.45)',
    boxShadow: '0 2px 6px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,222,150,0.12)',
    opacity: '1',
    cursor: 'pointer',
  },
  hover: {
    background: 'linear-gradient(180deg, rgba(96,68,28,0.95), rgba(52,36,15,0.95))',
    border: '1px solid rgba(255,206,102,0.85)',
    boxShadow: '0 4px 14px rgba(0,0,0,0.55), 0 0 12px rgba(255,190,80,0.25), inset 0 1px 0 rgba(255,230,170,0.2)',
    opacity: '1',
    cursor: 'pointer',
  },
  owned: {
    background: 'linear-gradient(180deg, rgba(28,48,26,0.9), rgba(16,28,15,0.9))',
    border: '1px solid rgba(110,180,100,0.4)',
    boxShadow: 'inset 0 1px 0 rgba(180,255,170,0.08)',
    opacity: '0.75',
    cursor: 'default',
  },
  locked: {
    background: 'linear-gradient(180deg, rgba(26,21,13,0.85), rgba(16,13,8,0.85))',
    border: '1px solid rgba(120,96,52,0.22)',
    boxShadow: 'none',
    opacity: '0.45',
    cursor: 'default',
  },
} as const;

/**
 * Modal shop window — opens when left-clicking a shop.
 *
 * Items are laid out as a grid of cards (icon, name, price) rather than a
 * vertical list; hover for description + stats. Click a card or press its
 * letter hotkey to buy. When out of range, cards are disabled but the window
 * stays open.
 */
export class ShopWindow {
  readonly el: HTMLDivElement;
  private _overlay: HTMLDivElement;
  private _cards: ShopCard[] = [];
  private _items: ShopItem[] = [];
  private _goldEl: HTMLSpanElement | null = null;
  private _cb: ShopCallback;
  private _visible = false;
  private _inRange = true;
  private _shopIndex = 0;

  constructor(cb: ShopCallback) {
    this._cb = cb;

    // Backdrop
    this._overlay = document.createElement('div');
    this._overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 400;
      background: radial-gradient(ellipse at center, rgba(0,0,0,0.35), rgba(0,0,0,0.65));
      backdrop-filter: blur(2px);
      pointer-events: auto;
      display: none;
    `;
    this._overlay.addEventListener('click', () => this.close());
    document.body.appendChild(this._overlay);

    // Panel
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 401;
      pointer-events: auto;
      display: none;
      font-family: sans-serif;
    `;
    document.body.appendChild(this.el);
  }

  /** Currently open shop index (or the last opened). */
  get shopIndex(): number { return this._shopIndex; }

  /** Open with shop items. Pass inRange=false to show all items disabled. */
  open(items: ShopItem[], heroGold: number, inventory: readonly (string | null)[], inRange: boolean, shopIndex: number): void {
    this._items = items;
    this._inRange = inRange;
    this._shopIndex = shopIndex;
    this.el.innerHTML = '';

    const panel = document.createElement('div');
    panel.style.cssText = `
      background:
        linear-gradient(180deg, rgba(38,27,16,0.97), rgba(18,13,8,0.98));
      border: 2px solid #8a6a2c;
      border-radius: 10px;
      padding: 18px 20px 14px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,220,150,0.12);
    `;

    // ── Header: tavern name on the left, purse on the right ──
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 24px; padding-bottom: 10px; margin-bottom: 14px;
      border-bottom: 1px solid rgba(214,168,74,0.28);
    `;

    const title = document.createElement('div');
    title.textContent = '🍺 The Rusty Quiver';
    title.style.cssText = `
      color: #ffcc44; font-size: 19px; font-weight: bold;
      letter-spacing: 0.5px;
      text-shadow: 0 2px 6px rgba(0,0,0,0.7);
    `;
    header.appendChild(title);

    const gold = document.createElement('span');
    gold.textContent = `${heroGold}g`;
    gold.style.cssText = `
      color: #ffd76a; font-size: 15px; font-weight: bold;
      text-shadow: 0 0 8px rgba(255,190,60,0.35);
    `;
    this._goldEl = gold;
    header.appendChild(gold);
    panel.appendChild(header);

    // Out of range warning (always created; shown/hidden in refresh)
    const warning = document.createElement('div');
    warning.className = 'shop-range-warning';
    warning.textContent = '⚠ Out of range — move closer to buy';
    warning.style.cssText = `
      color: #ff9a55; font-size: 12px; font-weight: bold;
      text-align: center; margin-bottom: 12px;
      padding: 7px; border-radius: 5px;
      background: rgba(255,80,20,0.1);
      border: 1px solid rgba(255,120,50,0.3);
      display: ${inRange ? 'none' : 'block'};
    `;
    panel.appendChild(warning);

    // ── Item grid ──
    const grid = document.createElement('div');
    grid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(${Math.min(COLUMNS, items.length)}, 138px);
      gap: 10px;
    `;

    this._cards = [];
    for (let i = 0; i < items.length; i++) {
      const card = this._buildCard(items[i], i);
      grid.appendChild(card.el);
      this._cards.push(card);
    }
    panel.appendChild(grid);

    // Close hint
    const hint = document.createElement('div');
    hint.textContent = 'Press a letter to buy · Escape or click outside to close';
    hint.style.cssText = `
      color: #7a6a4e; font-size: 10px; text-align: center; margin-top: 12px;
    `;
    panel.appendChild(hint);

    this.el.appendChild(panel);

    // Apply initial per-card state through the same path refresh() uses.
    this.refreshCards(heroGold, inventory, inRange);

    this._overlay.style.display = 'block';
    this.el.style.display = 'block';
    this._visible = true;
  }

  /** Build one item card (static structure; state applied by `_applyState`). */
  private _buildCard(item: ShopItem, index: number): ShopCard {
    const def = SHOP_ITEMS_BY_ID[item.id];
    const itemColor = def?.color ?? item.color ?? '#5a4a2a';
    const itemIcon = def?.icon ?? item.icon ?? '●';

    const el = document.createElement('div');
    el.style.cssText = `
      position: relative;
      display: flex; flex-direction: column; align-items: center;
      gap: 7px; padding: 12px 8px 10px;
      border-radius: 8px;
      box-sizing: border-box;
      transition: background 0.12s, box-shadow 0.12s, border-color 0.12s;
    `;

    // Hotkey badge — top-left corner of the card.
    const key = document.createElement('span');
    key.textContent = shopHotkey(index) ?? '';
    key.style.cssText = `
      position: absolute; top: 5px; left: 6px;
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 17px; height: 17px; padding: 0 3px;
      border-radius: 4px;
      background: rgba(0,0,0,0.55);
      border: 1px solid rgba(214,168,74,0.5);
      color: #ffcc44; font-size: 10px; font-weight: bold;
      line-height: 1;
    `;
    el.appendChild(key);

    // Icon tile — a glossy orb tinted with the item's own colour.
    const tile = document.createElement('div');
    tile.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      width: 62px; height: 62px;
      border-radius: 12px;
      background:
        radial-gradient(circle at 32% 26%, rgba(255,255,255,0.42), rgba(255,255,255,0) 58%),
        linear-gradient(160deg, ${itemColor}, rgba(0,0,0,0.55));
      border: 1px solid rgba(255,255,255,0.18);
      box-shadow: inset 0 -6px 12px rgba(0,0,0,0.35), 0 3px 8px rgba(0,0,0,0.45);
      transition: transform 0.12s, box-shadow 0.12s;
    `;
    const icon = document.createElement('span');
    icon.textContent = itemIcon;
    icon.style.cssText = `
      font-size: 32px; line-height: 1;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,0.6));
    `;
    tile.appendChild(icon);
    el.appendChild(tile);

    // Name — wraps to two lines, so cards stay a uniform height.
    const name = document.createElement('div');
    name.textContent = item.name;
    name.style.cssText = `
      color: #f0e6d0; font-size: 11.5px; font-weight: bold;
      text-align: center; line-height: 1.25;
      min-height: 29px;
      display: flex; align-items: center;
    `;
    el.appendChild(name);

    const cost = document.createElement('div');
    cost.style.cssText = 'font-size: 12px; font-weight: bold;';
    el.appendChild(cost);

    // Hover tooltip (same content model as inventory / spell bar).
    Tooltip.shared().attach(el, () => (def ? itemTooltip(def, true) : null));

    return { el, tile, icon, cost, key };
  }

  /** Apply the buyable/owned/locked look to one card and wire its handlers. */
  private _applyState(card: ShopCard, index: number, owned: boolean, canBuy: boolean): void {
    const style = owned ? CARD_STYLES.owned : canBuy ? CARD_STYLES.buyable : CARD_STYLES.locked;
    const { el } = card;
    el.style.background = style.background;
    el.style.border = style.border;
    el.style.boxShadow = style.boxShadow;
    el.style.opacity = style.opacity;
    el.style.cursor = style.cursor;

    card.icon.style.filter = owned || canBuy
      ? 'drop-shadow(0 2px 3px rgba(0,0,0,0.6))'
      : 'grayscale(0.7) brightness(0.75) drop-shadow(0 2px 3px rgba(0,0,0,0.6))';
    card.key.style.color = canBuy ? '#ffcc44' : '#8a7550';

    if (canBuy) {
      el.onmouseenter = () => {
        el.style.background = CARD_STYLES.hover.background;
        el.style.border = CARD_STYLES.hover.border;
        el.style.boxShadow = CARD_STYLES.hover.boxShadow;
        card.tile.style.transform = 'scale(1.06)';
      };
      el.onmouseleave = () => {
        el.style.background = CARD_STYLES.buyable.background;
        el.style.border = CARD_STYLES.buyable.border;
        el.style.boxShadow = CARD_STYLES.buyable.boxShadow;
        card.tile.style.transform = 'scale(1)';
      };
      el.onclick = (e) => { e.stopPropagation(); this._cb.onBuy(this._shopIndex, index); };
    } else {
      el.onmouseenter = null;
      el.onmouseleave = null;
      el.onclick = null;
      card.tile.style.transform = 'scale(1)';
    }
  }

  /** Update gold/inventory/range state without rebuilding the entire panel. */
  refresh(heroGold: number, inventory: readonly (string | null)[], inRange: boolean): void {
    if (!this._visible) return;
    this._inRange = inRange;

    // Update range warning banner
    const warning = this.el.querySelector('.shop-range-warning') as HTMLElement | null;
    if (warning) warning.style.display = inRange ? 'none' : 'block';

    this.refreshCards(heroGold, inventory, inRange);
  }

  /** Re-evaluate affordability/ownership for every card. */
  private refreshCards(heroGold: number, inventory: readonly (string | null)[], inRange: boolean): void {
    if (this._goldEl) this._goldEl.textContent = `${heroGold}g`;

    for (let i = 0; i < this._cards.length; i++) {
      const item = this._items[i];
      const card = this._cards[i];
      // Stackable items (e.g. wards) remain purchasable even when already owned.
      const owned = !item.consumable && !item.stackable && inventory.includes(item.id);
      const canBuy = inRange && heroGold >= item.cost && (item.consumable || item.stackable || !owned);

      this._applyState(card, i, owned, canBuy);

      if (owned) {
        card.cost.textContent = 'Owned';
        card.cost.style.color = '#7dc45c';
      } else {
        card.cost.textContent = `${item.cost}g`;
        card.cost.style.color = canBuy ? '#ffcc44' : '#b05a4a';
      }
    }
  }

  close(): void {
    if (!this._visible) return;
    Tooltip.shared().hide();
    this._overlay.style.display = 'none';
    this.el.style.display = 'none';
    this.el.innerHTML = '';
    this._cards = [];
    this._goldEl = null;
    this._visible = false;
    this._cb.onClose();
  }

  get visible(): boolean { return this._visible; }
}
