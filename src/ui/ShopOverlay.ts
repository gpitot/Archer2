/**
 * Shop proximity prompt — a small badge that fades in bottom-centre when the
 * hero walks into range of a tavern. Purely a hint; the actual store is
 * `ShopWindow`.
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
      transition: opacity 0.15s, transform 0.15s;
      font-family: sans-serif;
    `;

    const badge = document.createElement("div");
    badge.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      padding: 7px 14px;
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(46,32,18,0.92), rgba(22,15,9,0.92));
      border: 1px solid rgba(214,168,74,0.55);
      box-shadow: 0 4px 16px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,220,150,0.14);
    `;

    const sign = document.createElement("span");
    sign.textContent = "🍺";
    sign.style.cssText = "font-size: 18px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.7));";
    badge.appendChild(sign);

    const label = document.createElement("span");
    label.innerHTML =
      `<span style="color:#e8dcc0;">Tavern &mdash; press </span>`
      + `<span style="display:inline-flex;align-items:center;justify-content:center;`
      + `min-width:18px;height:18px;padding:0 4px;margin:0 2px;border-radius:4px;`
      + `background:rgba(0,0,0,0.55);border:1px solid rgba(214,168,74,0.6);`
      + `color:#ffcc44;font-size:11px;font-weight:bold;line-height:1;">B</span>`
      + `<span style="color:#e8dcc0;"> to trade</span>`;
    label.style.cssText = `
      font-size: 13px; font-weight: bold;
      text-shadow: 0 1px 3px rgba(0,0,0,0.8);
    `;
    badge.appendChild(label);

    this.el.appendChild(badge);
    document.body.appendChild(this.el);
  }

  /** Show for a shop. Pass items to display. */
  show(): void {
    this.el.style.opacity = "1";
    this.el.style.transform = "translateX(-50%) translateY(0)";
  }

  /** Hide when out of range. */
  hide(): void {
    this.el.style.opacity = "0";
    this.el.style.transform = "translateX(-50%) translateY(6px)";
  }
}
