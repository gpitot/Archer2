/**
 * Gold counter — WC3-style gold display near the portrait.
 */
export class GoldDisplay {
  readonly el: HTMLDivElement;
  private _label: HTMLDivElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 124px;
      z-index: 200;
      pointer-events: none;
      font-family: sans-serif;
    `;

    this._label = document.createElement('div');
    this._label.style.cssText = `
      color: #ffcc44;
      font-size: 22px;
      font-weight: bold;
      text-shadow: 0 0 6px rgba(0,0,0,0.8);
    `;
    this._label.textContent = '0';
    this.el.appendChild(this._label);

    document.body.appendChild(this.el);
  }

  update(gold: number): void {
    this._label.textContent = String(Math.floor(gold));
  }
}
