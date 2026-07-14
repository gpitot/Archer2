/**
 * K/D counter — top-right corner.
 */
export class KDDisplay {
  readonly el: HTMLDivElement;
  private _label: HTMLDivElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      top: 12px;
      right: 16px;
      z-index: 200;
      pointer-events: none;
      font-family: sans-serif;
      font-size: 14px;
      font-weight: bold;
      color: #ccddff;
      text-shadow: 0 0 6px rgba(0,0,0,0.8);
      text-align: right;
    `;

    this._label = document.createElement('div');
    this._label.textContent = 'K/D: 0/0';
    this.el.appendChild(this._label);

    document.body.appendChild(this.el);
  }

  update(kills: number, deaths: number): void {
    this._label.textContent = `K/D: ${kills}/${deaths}`;
  }
}
