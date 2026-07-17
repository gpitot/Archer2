/**
 * MOBA-style spell bar overlay.
 *
 * Renders 4 ability slots (QWER) at the bottom centre of the screen.
 * Q is wired to the ArrowAbility; W is Dodge; E is the Scout projectile; R is Blast.
 * Q also has a charge indicator above the slot when the ability has >1 max charge.
 * Basics (Q/W/E) show 5 rank dots; the ultimate (R) shows 3.
 */

/** Per-slot display state passed to `SpellBar.update`. */
export interface SpellSlotInfo {
  /** 0..1 — 1 = ready, <1 = cooling down. */
  cooldownProgress: number;
  /** Current rank (0 = unlearned/locked). */
  level: number;
  /** True when a skill point can be spent here right now (glow). */
  canLevel: boolean;
  charges?: number;
  maxCharges?: number;
}

export class SpellBar {
  readonly container: HTMLDivElement;

  private _slots: SpellSlot[] = [];

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: flex-end;
      gap: 8px;
      z-index: 200;
      pointer-events: none;
    `;

    const keys: { key: string; maxLevel: number }[] = [
      { key: 'Q', maxLevel: 5 },
      { key: 'W', maxLevel: 5 },
      { key: 'E', maxLevel: 5 },
      { key: 'R', maxLevel: 3 },
    ];
    for (const { key, maxLevel } of keys) {
      const slot = new SpellSlot(key, maxLevel);
      this._slots.push(slot);
      this.container.appendChild(slot.el);
    }

    document.body.appendChild(this.container);
  }

  /** Update cooldown, level, skill points, and charge state per slot. */
  update(q: SpellSlotInfo, w: SpellSlotInfo, e: SpellSlotInfo, r: SpellSlotInfo): void {
    const infos = [q, w, e, r];
    for (let i = 0; i < 4; i++) {
      const info = infos[i];
      const slot = this._slots[i];
      slot.setLocked(info.level < 1);
      slot.setCooldown(info.cooldownProgress);
      slot.setLevel(info.level);
      slot.setOnCooldown(info.cooldownProgress < 1);
      slot.setCanLevel(info.canLevel);
      slot.setCharges(info.charges ?? 0, info.maxCharges ?? 1);
    }
  }

  destroy(): void {
    this.container.remove();
  }
}

class SpellSlot {
  readonly el: HTMLDivElement;
  private _cooldown: HTMLDivElement;
  private _keyLabel: HTMLDivElement;
  private _levelDots: HTMLDivElement;
  private _chargeLabel: HTMLDivElement;
  private _icon: HTMLDivElement;
  private _maxLevel: number;
  private _locked = false;
  private _onCd = false;
  private _canLevel = false;

  constructor(key: string, maxLevel: number) {
    const size = 56;
    this._maxLevel = maxLevel;

    this.el = document.createElement('div');
    this.el.style.cssText = `
      width: ${size}px;
      height: ${size}px;
      border: 2px solid rgba(180,160,100,0.8);
      border-radius: 4px;
      background: rgba(20,18,10,0.85);
      position: relative;
      overflow: visible;
    `;

    // Placeholder icon
    const icon = document.createElement('div');
    icon.style.cssText = `
      position: absolute;
      inset: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #cc9944;
      opacity: 0.6;
    `;
    icon.textContent = key === 'Q' ? '➹' : key === 'W' ? '↯' : key === 'E' ? '◉' : key === 'R' ? '✸' : '·';
    this._icon = icon;
    this.el.appendChild(icon);

    // Cooldown overlay (sweeps from top to bottom, WC3-style blue tint)
    this._cooldown = document.createElement('div');
    this._cooldown.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 0%;
      background: rgba(15,22,40,0.78);
      transition: none;
      pointer-events: none;
    `;
    this.el.appendChild(this._cooldown);

    // Key label
    this._keyLabel = document.createElement('div');
    this._keyLabel.style.cssText = `
      position: absolute;
      bottom: 2px;
      left: 4px;
      font-family: sans-serif;
      font-size: 11px;
      font-weight: bold;
      color: #cc9944;
      text-shadow: 0 0 4px rgba(0,0,0,0.8);
    `;
    this._keyLabel.textContent = key;
    this.el.appendChild(this._keyLabel);

    // Level dots (rank pips at top: 5 for basics, 3 for the ultimate)
    this._levelDots = document.createElement('div');
    this._levelDots.style.cssText = `
      position: absolute;
      top: 3px;
      right: 3px;
      display: flex;
      gap: 2px;
      pointer-events: none;
    `;
    for (let i = 0; i < maxLevel; i++) {
      const dot = document.createElement('div');
      dot.style.cssText = `
        width: 5px;
        height: 5px;
        border-radius: 1px;
        background: #888;
      `;
      this._levelDots.appendChild(dot);
    }
    this.el.appendChild(this._levelDots);

    // Charge indicator (above the slot, only shown when maxCharges > 1)
    this._chargeLabel = document.createElement('div');
    this._chargeLabel.style.cssText = `
      position: absolute;
      top: -18px;
      right: -4px;
      font-family: sans-serif;
      font-size: 11px;
      font-weight: bold;
      color: #f0d060;
      text-shadow: 0 0 4px rgba(0,0,0,0.9);
      pointer-events: none;
      display: none;
    `;
    this.el.appendChild(this._chargeLabel);

    // Inner wrapper for content that should be clipped (cooldown overlay).
    const inner = document.createElement('div');
    inner.style.cssText = `
      position: absolute;
      inset: 0;
      overflow: hidden;
      border-radius: 2px;
      pointer-events: none;
    `;
    this.el.appendChild(inner);

    // Move the existing icon, cooldown, key label, and level dots into inner.
    // (They were already added to this.el — we need to re-parent them.)
    inner.appendChild(icon);
    inner.appendChild(this._cooldown);
    inner.appendChild(this._keyLabel);
    inner.appendChild(this._levelDots);
  }

  /** Dim the slot when the ability is unlearned (rank 0). */
  setLocked(locked: boolean): void {
    if (this._locked === locked) return;
    this._locked = locked;
    this._icon.style.color = locked ? '#444' : '#cc9944';
    this.el.style.background = locked ? 'rgba(20,20,20,0.7)' : 'rgba(20,18,10,0.85)';
    this._refreshBorder();
  }

  setCooldown(progress: number): void {
    const pct = Math.round((1 - progress) * 100);
    this._cooldown.style.height = `${pct}%`;
  }

  /** Mute the border, glow, and key label when on cooldown. */
  setOnCooldown(onCd: boolean): void {
    this._onCd = onCd;
    this._refreshBorder();
  }

  /** Highlight dots up to `level` (0 = none). */
  setLevel(level: number): void {
    const dots = this._levelDots.children;
    for (let i = 0; i < this._maxLevel; i++) {
      (dots[i] as HTMLElement).style.background = i < level ? '#cc9944' : '#444';
    }
  }

  /** Glow border when a skill point can be spent here (including learning from 0). */
  setCanLevel(can: boolean): void {
    this._canLevel = can;
    this._refreshBorder();
  }

  /** Border/glow priority: can-level glow > locked > on-cooldown > ready. */
  private _refreshBorder(): void {
    if (this._canLevel) {
      this.el.style.borderColor = 'rgba(255,200,60,0.9)';
      this.el.style.boxShadow = '0 0 8px rgba(255,200,60,0.4)';
      this._keyLabel.style.color = '#cc9944';
      return;
    }
    this.el.style.boxShadow = 'none';
    if (this._locked) {
      this.el.style.borderColor = 'rgba(80,80,80,0.5)';
      this._keyLabel.style.color = '#555';
    } else if (this._onCd) {
      this.el.style.borderColor = 'rgba(55,55,65,0.55)';
      this._keyLabel.style.color = '#666';
    } else {
      this.el.style.borderColor = 'rgba(180,160,100,0.8)';
      this._keyLabel.style.color = '#cc9944';
    }
  }

  /** Show charge count above the slot (only when maxCharges > 1). */
  setCharges(current: number, max: number): void {
    if (max <= 1) {
      this._chargeLabel.style.display = 'none';
      return;
    }
    this._chargeLabel.style.display = '';
    this._chargeLabel.textContent = String(current);
  }
}
