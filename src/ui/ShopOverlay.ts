import { ShopItem } from '../world/Shop';
import { renderStatRows } from './Tooltip';

/**
 * Shop HUD — appears bottom-center when hero is near a shop.
 * Shows available items with prices and hotkeys.
 */
export class ShopOverlay {
  readonly el: HTMLDivElement;
  private _itemsEl: HTMLDivElement;
  private _visible = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      bottom: 120px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 300;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      font-family: sans-serif;
      text-align: center;
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'Shop — Press B to buy';
    title.style.cssText = `
      color: #ffcc44;
      font-size: 14px;
      font-weight: bold;
      text-shadow: 0 0 8px rgba(0,0,0,0.8);
      margin-bottom: 6px;
    `;
    this.el.appendChild(title);

    // Items
    this._itemsEl = document.createElement('div');
    this._itemsEl.style.cssText = `
      display: flex;
      gap: 6px;
      justify-content: center;
    `;
    this.el.appendChild(this._itemsEl);

    document.body.appendChild(this.el);
  }

  /** Show for a shop. Pass items to display. */
  show(items: ShopItem[]): void {
    this._itemsEl.innerHTML = '';
    for (const item of items) {
      const card = document.createElement('div');
      card.style.cssText = `
        background: rgba(0,0,0,0.75);
        border: 1px solid rgba(255,200,60,0.4);
        border-radius: 4px;
        padding: 6px 10px;
        min-width: 100px;
        max-width: 150px;
        text-align: left;
      `;
      const stats = item.stats && item.stats.length > 0
        ? `<div style="margin-top:4px;border-top:1px solid rgba(180,160,100,0.25);padding-top:3px;">${renderStatRows(item.stats)}</div>`
        : '';
      card.innerHTML = `
        <div style="color:#fff;font-size:12px;font-weight:bold;">${item.name}</div>
        <div style="color:#aaa;font-size:10px;line-height:1.3;">${item.description || ''}</div>
        ${stats}
        <div style="color:#ffcc44;font-size:11px;margin-top:3px;">${item.cost}g</div>
      `;
      this._itemsEl.appendChild(card);
    }
    this.el.style.opacity = '1';
    this._visible = true;
  }

  /** Hide when out of range. */
  hide(): void {
    if (!this._visible) return;
    this.el.style.opacity = '0';
    this._visible = false;
  }
}
