/**
 * Six empty item slots — WC3-style 2×3 grid next to the hero portrait.
 */
export class ItemBar {
  readonly container: HTMLDivElement;
  private _slots: HTMLDivElement[] = [];
  private _icons: HTMLSpanElement[] = [];
  private _badges: HTMLSpanElement[] = [];
  private _cooldowns: HTMLDivElement[] = [];
  private _hotkeys: HTMLSpanElement[] = [];

  // Simple icons for known item IDs
  private static readonly _icons: Record<string, string> = {
    boots: '🥾',
    sentry_wards: '👁️',
    blink_dagger: '🗡️',
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
        position: relative;
        overflow: hidden;
      `;
      const icon = document.createElement('span');
      slot.appendChild(icon);

      // Cooldown overlay (sweeps from top to bottom, WC3-style blue tint —
      // same as the spell bar)
      const cooldown = document.createElement('div');
      cooldown.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 0%;
        background: rgba(15,22,40,0.78);
        pointer-events: none;
      `;
      slot.appendChild(cooldown);

      // Hotkey number (top-left corner)
      const hotkey = document.createElement('span');
      hotkey.textContent = String(i + 1);
      hotkey.style.cssText = `
        position: absolute;
        top: 0; left: 3px;
        font-size: 8px;
        color: #ffcc44;
        text-shadow: 0 0 3px #000;
        line-height: 1;
      `;
      slot.appendChild(hotkey);
      this._hotkeys.push(hotkey);

      // Charge-count badge (bottom-right corner, e.g. remaining wards)
      const badge = document.createElement('span');
      badge.style.cssText = `
        position: absolute;
        bottom: 0; right: 2px;
        font-size: 10px;
        color: #fff;
        text-shadow: 0 0 2px #000, 0 0 2px #000;
        display: none;
      `;
      slot.appendChild(badge);

      this._slots.push(slot);
      this._icons.push(icon);
      this._badges.push(badge);
      this._cooldowns.push(cooldown);
      this.container.appendChild(slot);
    }

    document.body.appendChild(this.container);
  }

  /**
   * Update slots from hero inventory (array of item IDs or null).
   * `charges` maps item IDs to a remaining-count badge (e.g. ward charges).
   * `cooldowns` maps item IDs to cooldown progress (0 = just used, 1 = ready).
   */
  update(
    inventory: readonly (string | null)[],
    charges: Record<string, number> = {},
    cooldowns: Record<string, number> = {},
  ): void {
    for (let i = 0; i < 6; i++) {
      const itemId = inventory[i];
      const slot = this._slots[i];
      const badge = this._badges[i];
      const cooldown = this._cooldowns[i];
      if (itemId) {
        this._icons[i].textContent = ItemBar._icons[itemId] ?? '●';
        const progress = cooldowns[itemId] ?? 1;
        const onCd = progress < 1;
        cooldown.style.height = `${Math.round((1 - progress) * 100)}%`;
        // Mute the border and hotkey while on cooldown (same as spell bar)
        slot.style.borderColor = onCd ? 'rgba(55,55,65,0.55)' : 'rgba(255,200,60,0.7)';
        slot.style.background = 'rgba(30, 20, 5, 0.8)';
        this._hotkeys[i].style.color = onCd ? '#666' : '#ffcc44';
        const count = charges[itemId];
        if (count !== undefined) {
          badge.textContent = String(count);
          badge.style.display = 'block';
        } else {
          badge.style.display = 'none';
        }
      } else {
        this._icons[i].textContent = '';
        badge.style.display = 'none';
        cooldown.style.height = '0%';
        slot.style.borderColor = 'rgba(180, 160, 100, 0.5)';
        slot.style.background = 'rgba(0, 0, 0, 0.65)';
        this._hotkeys[i].style.color = '#ffcc44';
      }
    }
  }
}
