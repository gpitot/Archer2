/**
 * Six empty item slots — WC3-style 2×3 grid next to the hero portrait.
 */
import { formatCooldown } from './SpellBar';

export class ItemBar {
  readonly container: HTMLDivElement;
  private _slots: HTMLDivElement[] = [];
  private _icons: HTMLSpanElement[] = [];
  private _badges: HTMLSpanElement[] = [];
  private _cooldowns: HTMLDivElement[] = [];
  private _cdTexts: HTMLDivElement[] = [];
  private _flashes: HTMLDivElement[] = [];
  private _wasOnCd: boolean[] = [];
  private _hotkeys: HTMLSpanElement[] = [];

  // Simple icons for known item IDs
  private static readonly _icons: Record<string, string> = {
    boots: '🥾',
    sentry_wards: '👁️',
    blink_dagger: '🗡️',
    crit_gem: '💎',
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

      // Radial cooldown mask (clockwise wipe from 12 o'clock — same as the
      // spell bar). Semi-transparent so the icon stays recognisable.
      const cooldown = document.createElement('div');
      cooldown.style.cssText = `
        position: absolute;
        inset: 0;
        background: none;
        pointer-events: none;
      `;
      slot.appendChild(cooldown);

      // Countdown number — above the mask, centre of the slot.
      const cdText = document.createElement('div');
      cdText.style.cssText = `
        position: absolute;
        inset: 0;
        align-items: center;
        justify-content: center;
        font-family: sans-serif;
        font-size: 13px;
        font-weight: bold;
        color: #fff;
        text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 5px rgba(0,0,0,0.7);
        pointer-events: none;
        display: none;
      `;
      slot.appendChild(cdText);

      // Ready flash — briefly lights up when the cooldown completes.
      const flash = document.createElement('div');
      flash.style.cssText = `
        position: absolute;
        inset: 0;
        background: rgba(255,240,190,0.9);
        opacity: 0;
        pointer-events: none;
      `;
      slot.appendChild(flash);

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
      this._cdTexts.push(cdText);
      this._flashes.push(flash);
      this._wasOnCd.push(false);
      this.container.appendChild(slot);
    }

    document.body.appendChild(this.container);
  }

  /**
   * Update slots from hero inventory (array of item IDs or null).
   * `charges` maps item IDs to a remaining-count badge (e.g. ward charges).
   * `cooldowns` maps item IDs to cooldown progress (0 = just used, 1 = ready).
   * `cooldownRemaining` maps item IDs to seconds until ready (countdown text).
   */
  update(
    inventory: readonly (string | null)[],
    charges: Record<string, number> = {},
    cooldowns: Record<string, number> = {},
    cooldownRemaining: Record<string, number> = {},
  ): void {
    for (let i = 0; i < 6; i++) {
      const itemId = inventory[i];
      const slot = this._slots[i];
      const badge = this._badges[i];
      const cooldown = this._cooldowns[i];
      const cdText = this._cdTexts[i];
      if (itemId) {
        this._icons[i].textContent = ItemBar._icons[itemId] ?? '●';
        const progress = cooldowns[itemId] ?? 1;
        const onCd = progress < 1;
        if (onCd) {
          // Radial wipe: revealed clockwise from the top as cooldown elapses.
          const angle = progress * 360;
          cooldown.style.background =
            `conic-gradient(transparent ${angle}deg, rgba(0,0,0,0.6) ${angle}deg)`;
          cdText.style.display = 'flex';
          cdText.textContent = formatCooldown(cooldownRemaining[itemId] ?? 0);
        } else {
          cooldown.style.background = 'none';
          cdText.style.display = 'none';
        }
        // Ready flash on the cooldown → ready transition
        if (this._wasOnCd[i] && !onCd) this._playReadyFlash(i);
        this._wasOnCd[i] = onCd;
        // Border stays visible during cooldown — slightly muted; bright when ready.
        slot.style.borderColor = onCd ? 'rgba(150,132,85,0.6)' : 'rgba(255,200,60,0.7)';
        slot.style.background = 'rgba(255, 255, 255, 0.1)';
        this._hotkeys[i].style.color = onCd ? '#997733' : '#ffcc44';
        this._icons[i].style.filter = onCd ? 'grayscale(0.6) brightness(0.7)' : 'none';
        const count = charges[itemId];
        if (count !== undefined) {
          badge.textContent = String(count);
          badge.style.display = 'block';
        } else {
          badge.style.display = 'none';
        }
      } else {
        this._icons[i].textContent = '';
        this._icons[i].style.filter = 'none';
        badge.style.display = 'none';
        cooldown.style.background = 'none';
        cdText.style.display = 'none';
        this._wasOnCd[i] = false;
        slot.style.borderColor = 'rgba(180, 160, 100, 0.5)';
        slot.style.background = 'rgba(255, 255, 255, 0.1)';
        this._hotkeys[i].style.color = '#ffcc44';
      }
    }
  }

  /** Brief bright pulse when an item cooldown completes. */
  private _playReadyFlash(i: number): void {
    this._flashes[i].animate(
      [{ opacity: 0.9 }, { opacity: 0 }],
      { duration: 350, easing: 'ease-out' },
    );
    this._slots[i].animate(
      [
        { boxShadow: '0 0 10px rgba(255,230,150,0.9)' },
        { boxShadow: '0 0 0 rgba(255,230,150,0)' },
      ],
      { duration: 450, easing: 'ease-out' },
    );
  }
}
