/**
 * Six empty item slots — WC3-style 2×3 grid next to the hero portrait.
 */
export class ItemBar {
  readonly container: HTMLDivElement;
  private _slots: HTMLDivElement[] = [];

  // Simple icons for known item IDs
  private static readonly _icons: Record<string, string> = {
    boots: '🥾',
  };

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      bottom: 56px;
      left: 124px;
      display: grid;
      grid-template-columns: repeat(3, 36px);
      grid-template-rows: repeat(2, 36px);
      gap: 4px;
      z-index: 200;
      pointer-events: none;
    `;

    for (let i = 0; i < 6; i++) {
      const slot = document.createElement('div');
      slot.style.cssText = `
        width: 36px; height: 36px;
        background: rgba(0, 0, 0, 0.65);
        border: 2px solid rgba(180, 160, 100, 0.5);
        border-radius: 3px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        color: #ffcc44;
      `;
      this._slots.push(slot);
      this.container.appendChild(slot);
    }

    document.body.appendChild(this.container);
  }

  /** Update slots from hero inventory (array of item IDs or null). */
  update(inventory: readonly (string | null)[]): void {
    for (let i = 0; i < 6; i++) {
      const itemId = inventory[i];
      const slot = this._slots[i];
      if (itemId) {
        slot.textContent = ItemBar._icons[itemId] ?? '●';
        slot.style.borderColor = 'rgba(255,200,60,0.7)';
        slot.style.background = 'rgba(30, 20, 5, 0.8)';
      } else {
        slot.textContent = '';
        slot.style.borderColor = 'rgba(180, 160, 100, 0.5)';
        slot.style.background = 'rgba(0, 0, 0, 0.65)';
      }
    }
  }
}
