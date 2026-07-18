import { ShopItem } from '../world/Shop';
import { renderStatRows } from './Tooltip';
import { SHOP_ITEMS_BY_ID } from '../sim/shopItems';

interface ShopCallback {
  onBuy: (index: number) => void;
  onClose: () => void;
}

/**
 * Modal shop window — opens when left-clicking a shop.
 * Shows all items with name, description, cost. Click or press 1–6 to buy.
 */
export class ShopWindow {
  readonly el: HTMLDivElement;
  private _overlay: HTMLDivElement;
  private _itemEls: HTMLDivElement[] = [];
  private _items: ShopItem[] = [];
  private _cb: ShopCallback;
  private _visible = false;

  constructor(cb: ShopCallback) {
    this._cb = cb;

    // Backdrop
    this._overlay = document.createElement('div');
    this._overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 400;
      background: rgba(0,0,0,0.5);
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

  /** Open with shop items. */
  open(items: ShopItem[], heroGold: number, inventory: readonly (string | null)[]): void {
    this._items = items;
    // Build panel content
    this.el.innerHTML = '';

    const panel = document.createElement('div');
    panel.style.cssText = `
      background: rgba(10, 8, 5, 0.95);
      border: 2px solid #886622;
      border-radius: 8px;
      padding: 16px;
      min-width: 360px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'Shop';
    title.style.cssText = `
      color: #ffcc44; font-size: 18px; font-weight: bold;
      text-align: center; margin-bottom: 12px;
      text-shadow: 0 0 6px rgba(0,0,0,0.5);
    `;
    panel.appendChild(title);

    // Items
    this._itemEls = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const owned = inventory.includes(item.id);
      const canBuy = !owned && heroGold >= item.cost;

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; align-items: center; gap: 10px;
        padding: 8px; margin-bottom: 4px;
        border-radius: 4px;
        cursor: ${canBuy ? 'pointer' : 'default'};
        background: ${owned ? 'rgba(20,40,20,0.4)' : canBuy ? 'rgba(40,30,10,0.6)' : 'rgba(20,15,5,0.4)'};
        border: 1px solid ${owned ? 'rgba(80,160,80,0.3)' : canBuy ? 'rgba(255,200,60,0.3)' : 'rgba(80,60,30,0.2)'};
        transition: background 0.1s;
        opacity: ${owned ? '0.7' : canBuy ? '1' : '0.5'};
      `;
      if (canBuy) {
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(60,45,15,0.7)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'rgba(40,30,10,0.6)'; });
        row.addEventListener('click', (e) => { e.stopPropagation(); this._cb.onBuy(i); this.close(); });
      }

      // Item icon (from source-of-truth item def or ShopItem fields)
      const def = SHOP_ITEMS_BY_ID[item.id];
      const itemIcon = def?.icon ?? item.icon;
      const itemColor = def?.color ?? item.color;
      const icon = document.createElement('span');
      icon.textContent = itemIcon ?? '●';
      icon.style.cssText = `
        display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px;
        border-radius: 3px;
        background: ${itemColor ?? '#444'};
        color: #fff; font-size: 13px;
        flex-shrink: 0;
      `;
      row.appendChild(icon);

      // Hotkey number
      const key = document.createElement('span');
      key.textContent = String(i + 1);
      key.style.cssText = `
        display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px;
        border-radius: 3px;
        background: rgba(0,0,0,0.5);
        color: #ffcc44; font-size: 12px; font-weight: bold;
        border: 1px solid #886622;
        flex-shrink: 0;
      `;
      row.appendChild(key);

      // Name + desc + stats
      const info = document.createElement('div');
      info.style.cssText = 'flex: 1;';
      const stats = item.stats && item.stats.length > 0
        ? `<div style="margin-top:4px;max-width:220px;">${renderStatRows(item.stats)}</div>`
        : '';
      info.innerHTML = `
        <div style="color:#fff;font-size:13px;font-weight:bold;">${item.name}</div>
        <div style="color:#999;font-size:10px;line-height:1.3;">${item.description || ''}</div>
        ${stats}
      `;
      row.appendChild(info);

      // Cost / Owned
      const cost = document.createElement('span');
      if (owned) {
        cost.textContent = 'Owned';
        cost.style.cssText = 'color: #66aa44; font-size: 11px; font-weight: bold; flex-shrink: 0;';
      } else {
        cost.textContent = `${item.cost}g`;
        cost.style.cssText = `
          color: ${canBuy ? '#ffcc44' : '#aa4444'}; font-size: 13px; font-weight: bold;
          flex-shrink: 0;
        `;
      }
      row.appendChild(cost);

      panel.appendChild(row);
      this._itemEls.push(row);
    }

    // Close hint
    const hint = document.createElement('div');
    hint.textContent = 'Click outside or press Escape to close';
    hint.style.cssText = `
      color: #666; font-size: 10px; text-align: center; margin-top: 10px;
    `;
    panel.appendChild(hint);

    this.el.appendChild(panel);

    // Show
    this._overlay.style.display = 'block';
    this.el.style.display = 'block';
    this._visible = true;
  }

  /** Update gold/inventory state without rebuilding the entire panel. */
  refresh(heroGold: number, inventory: readonly (string | null)[]): void {
    if (!this._visible) return;
    const items = this._items as ShopItem[];
    for (let i = 0; i < this._itemEls.length; i++) {
      const item = items[i];
      const owned = inventory.includes(item.id);
      const canBuy = !owned && heroGold >= item.cost;
      const row = this._itemEls[i];
      // Update background / opacity
      if (owned) {
        row.style.background = 'rgba(20,40,20,0.4)';
        row.style.border = '1px solid rgba(80,160,80,0.3)';
        row.style.opacity = '0.7';
        row.style.cursor = 'default';
        row.onclick = null;
        row.onmouseenter = null;
        row.onmouseleave = null;
      } else if (canBuy) {
        row.style.background = 'rgba(40,30,10,0.6)';
        row.style.border = '1px solid rgba(255,200,60,0.3)';
        row.style.opacity = '1';
        row.style.cursor = 'pointer';
        row.onclick = (e) => { e.stopPropagation(); this._cb.onBuy(i); this.close(); };
        row.onmouseenter = () => { row.style.background = 'rgba(60,45,15,0.7)'; };
        row.onmouseleave = () => { row.style.background = 'rgba(40,30,10,0.6)'; };
      } else {
        row.style.background = 'rgba(20,15,5,0.4)';
        row.style.border = '1px solid rgba(80,60,30,0.2)';
        row.style.opacity = '0.5';
        row.style.cursor = 'default';
        row.onclick = null;
        row.onmouseenter = null;
        row.onmouseleave = null;
      }
      // Update cost label
      const costEl = row.lastElementChild as HTMLElement;
      if (costEl) {
        if (owned) {
          costEl.textContent = 'Owned';
          costEl.style.color = '#66aa44';
        } else {
          costEl.textContent = `${item.cost}g`;
          costEl.style.color = canBuy ? '#ffcc44' : '#aa4444';
        }
      }
    }
  }

  close(): void {
    if (!this._visible) return;
    this._overlay.style.display = 'none';
    this.el.style.display = 'none';
    this.el.innerHTML = '';
    this._visible = false;
    this._cb.onClose();
  }

  get visible(): boolean { return this._visible; }
}
