import { ShopItem } from "../world/Shop";
import { renderStatRows } from "./Tooltip";

/**
 * Shop HUD — appears bottom-center when hero is near a shop.
 * Shows available items with prices and hotkeys.
 */
export class ShopOverlay {
  readonly el: HTMLDivElement;

  constructor() {
    this.el = document.createElement("div");
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
    const title = document.createElement("div");
    title.textContent = "Shop — Press B to buy";
    title.style.cssText = `
      color: #ffcc44;
      font-size: 14px;
      font-weight: bold;
      text-shadow: 0 0 8px rgba(0,0,0,0.8);
      margin-bottom: 6px;
    `;
    this.el.appendChild(title);

    document.body.appendChild(this.el);
  }

  /** Show for a shop. Pass items to display. */
  show(): void {
    this.el.style.opacity = "1";
  }

  /** Hide when out of range. */
  hide(): void {
    this.el.style.opacity = "0";
  }
}
