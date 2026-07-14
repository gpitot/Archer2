/**
 * MOBA-style spell bar overlay.
 *
 * Renders 4 ability slots (QWER) at the bottom centre of the screen.
 * Q is wired to the ArrowAbility; W/E/R are empty placeholders.
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

    const keys = ['Q', 'W', 'E', 'R'] as const;
    for (const key of keys) {
      const slot = new SpellSlot(key);
      this._slots.push(slot);
      this.container.appendChild(slot.el);
    }

    document.body.appendChild(this.container);
  }

  /** Update cooldown, level, and skill points. */
  update(cooldownProgress: number, abilityLevel: number, skillPoints: number): void {
    this._slots[0].setCooldown(cooldownProgress);
    this._slots[0].setLevel(abilityLevel);
    this._slots[0].setCanLevel(skillPoints > 0 && abilityLevel < 4);
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

  constructor(key: string) {
    const size = 56;
    const isActive = key === 'Q';

    this.el = document.createElement('div');
    this.el.style.cssText = `
      width: ${size}px;
      height: ${size}px;
      border: 2px solid ${isActive ? 'rgba(180,160,100,0.8)' : 'rgba(80,80,80,0.5)'};
      border-radius: 4px;
      background: ${isActive ? 'rgba(20,18,10,0.85)' : 'rgba(20,20,20,0.7)'};
      position: relative;
      overflow: hidden;
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
      color: ${isActive ? '#cc9944' : '#444'};
      opacity: 0.6;
    `;
    icon.textContent = key === 'Q' ? '➹' : '·';
    this.el.appendChild(icon);

    // Cooldown overlay
    this._cooldown = document.createElement('div');
    this._cooldown.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 0%;
      background: rgba(0,0,0,0.65);
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
      color: ${isActive ? '#cc9944' : '#555'};
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
        background: ${isActive ? '#888' : '#333'};
      `;
      this._levelDots.appendChild(dot);
    }
    this.el.appendChild(this._levelDots);
  }

  setCooldown(progress: number): void {
    const pct = Math.round((1 - progress) * 100);
    this._cooldown.style.height = `${pct}%`;
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
}
