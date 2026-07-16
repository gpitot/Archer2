/**
 * MOBA-style spell bar overlay.
 *
 * Renders 4 ability slots (QWER) at the bottom centre of the screen.
 * Q is wired to the ArrowAbility; W is Dodge; E is Reveal; R is Blast.
 * Q also has a charge indicator above the slot when the ability has >1 max charge.
 */
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

    const keys: { key: string; active: boolean }[] = [
      { key: 'Q', active: true },
      { key: 'W', active: true },
      { key: 'E', active: true },
      { key: 'R', active: true },
    ];
    for (const { key, active } of keys) {
      const slot = new SpellSlot(key, active);
      this._slots.push(slot);
      this.container.appendChild(slot.el);
    }
    // E (Reveal) and R (Blast) have no levels — hide their level dots.
    this._slots[2].hideLevelDots();
    this._slots[3].hideLevelDots();

    document.body.appendChild(this.container);
  }

  /** Update cooldown, level, skill points, and charge state. */
  update(
    cooldownProgress: number,
    abilityLevel: number,
    skillPoints: number,
    dodgeCooldownProgress: number,
    dodgeLevel: number,
    charges: number,
    maxCharges: number,
    revealCooldownProgress: number,
    blastCooldownProgress: number,
  ): void {
    // Q — Arrow
    const qOnCd = cooldownProgress < 1;
    this._slots[0].setCooldown(cooldownProgress);
    this._slots[0].setLevel(abilityLevel);
    this._slots[0].setCanLevel(skillPoints > 0 && abilityLevel < 4);
    this._slots[0].setOnCooldown(qOnCd);
    this._slots[0].setCharges(charges, maxCharges);

    // W — Dodge
    const wOnCd = dodgeCooldownProgress < 1;
    this._slots[1].setCooldown(dodgeCooldownProgress);
    this._slots[1].setLevel(dodgeLevel);
    this._slots[1].setCanLevel(skillPoints > 0 && dodgeLevel < 4);
    this._slots[1].setOnCooldown(wOnCd);

    // E — Reveal (no levels)
    const eOnCd = revealCooldownProgress < 1;
    this._slots[2].setCooldown(revealCooldownProgress);
    this._slots[2].setOnCooldown(eOnCd);

    // R — Blast (no levels)
    const rOnCd = blastCooldownProgress < 1;
    this._slots[3].setCooldown(blastCooldownProgress);
    this._slots[3].setOnCooldown(rOnCd);
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
  private _isActive: boolean;

  constructor(key: string, active: boolean) {
    const size = 56;
    this._isActive = active;

    this.el = document.createElement('div');
    this.el.style.cssText = `
      width: ${size}px;
      height: ${size}px;
      border: 2px solid ${this._isActive ? 'rgba(180,160,100,0.8)' : 'rgba(80,80,80,0.5)'};
      border-radius: 4px;
      background: ${this._isActive ? 'rgba(20,18,10,0.85)' : 'rgba(20,20,20,0.7)'};
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
      color: ${this._isActive ? '#cc9944' : '#444'};
      opacity: 0.6;
    `;
    icon.textContent = key === 'Q' ? '➹' : key === 'W' ? '↯' : key === 'E' ? '◉' : key === 'R' ? '✸' : '·';
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
      color: ${this._isActive ? '#cc9944' : '#555'};
      text-shadow: 0 0 4px rgba(0,0,0,0.8);
    `;
    this._keyLabel.textContent = key;
    this.el.appendChild(this._keyLabel);

    // Level dots (1–4 small squares at top)
    this._levelDots = document.createElement('div');
    this._levelDots.style.cssText = `
      position: absolute;
      top: 3px;
      right: 3px;
      display: flex;
      gap: 2px;
      pointer-events: none;
    `;
    for (let i = 0; i < 4; i++) {
      const dot = document.createElement('div');
      dot.style.cssText = `
        width: 5px;
        height: 5px;
        border-radius: 1px;
        background: ${this._isActive ? '#888' : '#333'};
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

  /** Hide the level dots for abilities that have no levels. */
  hideLevelDots(): void {
    this._levelDots.style.display = 'none';
  }

  setCooldown(progress: number): void {
    const pct = Math.round((1 - progress) * 100);
    this._cooldown.style.height = `${pct}%`;
  }

  /** Mute the border, glow, and key label when on cooldown. */
  setOnCooldown(onCd: boolean): void {
    if (!this._isActive) return;
    if (onCd) {
      this.el.style.borderColor = 'rgba(55,55,65,0.55)';
      this.el.style.boxShadow = 'none';
      this._keyLabel.style.color = '#666';
    } else {
      this.el.style.borderColor = 'rgba(180,160,100,0.8)';
      this.el.style.boxShadow = 'none';
      this._keyLabel.style.color = '#cc9944';
    }
  }

  /** Highlight dots up to `level` (0 = none, 1–4 = filled). */
  setLevel(level: number): void {
    const dots = this._levelDots.children;
    for (let i = 0; i < 4; i++) {
      (dots[i] as HTMLElement).style.background = i < level ? '#cc9944' : '#444';
    }
  }

  /** Glow border when a skill point can be spent here (including learning from 0). */
  setCanLevel(can: boolean): void {
    this.el.style.borderColor = can ? 'rgba(255,200,60,0.9)' : 'rgba(180,160,100,0.8)';
    this.el.style.boxShadow = can ? '0 0 8px rgba(255,200,60,0.4)' : 'none';
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
