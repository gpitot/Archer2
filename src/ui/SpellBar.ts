/**
 * MOBA-style spell bar overlay.
 *
 * Renders 4 ability slots (QWER) at the bottom centre of the screen.
 * Q is wired to the ArrowAbility; W is Dodge; E is the Scout projectile; R is Blast.
 * Q also has a charge indicator above the slot when the ability has >1 max charge.
 * Basics (Q/W/E) show 5 rank dots; the ultimate (R) shows 3.
 */
import { Tooltip, type TooltipContent } from './Tooltip';

/** Per-slot display state passed to `SpellBar.update`. */
export interface SpellSlotInfo {
  /** 0..1 — 1 = ready, <1 = cooling down. */
  cooldownProgress: number;
  /** Seconds until ready (0 = ready). Drives the countdown number. */
  cooldownRemaining: number;
  /** Current rank (0 = unlearned/locked). */
  level: number;
  /** True when a skill point can be spent here right now (glow). */
  canLevel: boolean;
  charges?: number;
  maxCharges?: number;
}

/** What the bar needs to build one slot — derived from an AbilityDef. */
export interface SpellSlotDef {
  /** Hotkey label (Q/W/E/R). */
  key: string;
  /** Ability id passed to the level-up callback. */
  abilityId: string;
  /** Rank-dot count (5 for basics, 3 for the ultimate). */
  maxLevel: number;
  /** Hover-tooltip content for the given current rank. */
  tooltip: (level: number) => TooltipContent;
  /** Called when the player left-clicks the slot while it can be leveled. */
  onLevel?: (abilityId: string) => void;
}

export class SpellBar {
  readonly container: HTMLDivElement;

  private _slots: SpellSlot[] = [];

  constructor(defs: SpellSlotDef[]) {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      bottom: 36px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: flex-end;
      gap: 8px;
      z-index: 200;
      pointer-events: none;
    `;

    for (const { key, abilityId, maxLevel, tooltip, onLevel } of defs) {
      const slot = new SpellSlot(key, abilityId, maxLevel, tooltip, onLevel);
      this._slots.push(slot);
      this.container.appendChild(slot.el);
    }

    document.body.appendChild(this.container);
  }

  /** Update cooldown, level, skill points, and charge state per slot (same order as `defs`). */
  update(infos: SpellSlotInfo[]): void {
    for (let i = 0; i < this._slots.length; i++) {
      const info = infos[i];
      const slot = this._slots[i];
      if (!info) continue;
      slot.setLocked(info.level < 1);
      slot.setCooldown(info.cooldownProgress, info.cooldownRemaining);
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

/**
 * Format a cooldown countdown: whole seconds above 3s, one decimal below.
 */
export function formatCooldown(remaining: number): string {
  return remaining > 3 ? String(Math.ceil(remaining)) : remaining.toFixed(1);
}

class SpellSlot {
  readonly el: HTMLDivElement;
  private _cooldown: HTMLDivElement;
  private _cdText: HTMLDivElement;
  private _flash: HTMLDivElement;
  private _keyLabel: HTMLDivElement;
  private _levelDots: HTMLDivElement;
  private _chargeLabel: HTMLDivElement;
  private _icon: HTMLDivElement;
  private _maxLevel: number;
  private _locked = false;
  private _onCd = false;
  private _canLevel = false;
  private _level = 0;
  private _onLevel?: (abilityId: string) => void;
  private _abilityId: string;

  constructor(key: string, abilityId: string, maxLevel: number, tooltip: (level: number) => TooltipContent, onLevel?: (abilityId: string) => void) {
    const size = 56;
    this._maxLevel = maxLevel;
    this._onLevel = onLevel;
    this._abilityId = abilityId;

    this.el = document.createElement('div');
    this.el.style.cssText = `
      width: ${size}px;
      height: ${size}px;
      border: 2px solid rgba(180,160,100,0.8);
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.1);
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
      opacity: 1;
    `;
    icon.textContent = key === 'Q' ? '➹' : key === 'W' ? '↯' : key === 'E' ? '◉' : key === 'R' ? '✸' : '·';
    this._icon = icon;
    this.el.appendChild(icon);

    // Radial cooldown mask (LoL/Dota-style clockwise wipe from 12 o'clock).
    // Semi-transparent so the icon stays recognisable underneath.
    this._cooldown = document.createElement('div');
    this._cooldown.style.cssText = `
      position: absolute;
      inset: 0;
      background: none;
      pointer-events: none;
    `;
    this.el.appendChild(this._cooldown);

    // Countdown number — rendered above the mask, centre of the slot.
    this._cdText = document.createElement('div');
    this._cdText.style.cssText = `
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: sans-serif;
      font-size: 20px;
      font-weight: bold;
      color: #fff;
      text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7);
      pointer-events: none;
      display: none;
    `;
    this.el.appendChild(this._cdText);

    // Ready flash — briefly lights up when the cooldown completes.
    this._flash = document.createElement('div');
    this._flash.style.cssText = `
      position: absolute;
      inset: 0;
      background: rgba(255,240,190,0.9);
      opacity: 0;
      pointer-events: none;
    `;
    this.el.appendChild(this._flash);

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

    // Move the existing layers into inner, in rendering order:
    // icon < radial mask < labels/dots < countdown number < ready flash.
    inner.appendChild(icon);
    inner.appendChild(this._cooldown);
    inner.appendChild(this._keyLabel);
    inner.appendChild(this._levelDots);
    inner.appendChild(this._cdText);
    inner.appendChild(this._flash);

    // Hover tooltip (LoL/Dota-style), reflecting the current rank.
    Tooltip.shared().attach(this.el, () => tooltip(this._level));

    // Left-click to level up when a skill point is available.
    this.el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._canLevel && this._onLevel) {
        this._onLevel(this._abilityId);
      }
    });
  }

  /** Dim the slot when the ability is unlearned (rank 0). */
  setLocked(locked: boolean): void {
    if (this._locked === locked) return;
    this._locked = locked;
    this.el.style.background = locked ? 'rgba(20,20,20,0.7)' : 'rgba(20,18,10,0.85)';
    this._refreshIcon();
    this._refreshBorder();
  }

  /** Icon look: locked > on-cooldown (slightly desaturated/dark) > ready. */
  private _refreshIcon(): void {
    if (this._locked) {
      this._icon.style.color = '#444';
      this._icon.style.filter = 'none';
      this._icon.style.opacity = '0.6';
    } else if (this._onCd) {
      this._icon.style.color = '#cc9944';
      this._icon.style.filter = 'grayscale(0.6) brightness(0.7)';
      this._icon.style.opacity = '1';
    } else {
      this._icon.style.color = '#cc9944';
      this._icon.style.filter = 'none';
      this._icon.style.opacity = '1';
    }
  }

  /**
   * Radial wipe + countdown. `progress` is 0..1 (1 = ready); the mask
   * is revealed clockwise from the top as the cooldown elapses.
   */
  setCooldown(progress: number, remaining: number): void {
    if (progress >= 1) {
      this._cooldown.style.background = 'none';
      this._cdText.style.display = 'none';
      return;
    }
    const angle = progress * 360; // revealed portion (elapsed)
    this._cooldown.style.background =
      `conic-gradient(transparent ${angle}deg, rgba(0,0,0,0.6) ${angle}deg)`;
    this._cdText.style.display = 'flex';
    this._cdText.textContent = formatCooldown(remaining);
  }

  /** Track cooldown state; flashes the slot when it becomes ready. */
  setOnCooldown(onCd: boolean): void {
    if (this._onCd === onCd) return;
    const wasOnCd = this._onCd;
    this._onCd = onCd;
    this._refreshIcon();
    this._refreshBorder();
    if (wasOnCd && !onCd && !this._locked) this._playReadyFlash();
  }

  /** Brief bright pulse when the cooldown completes. */
  private _playReadyFlash(): void {
    this._flash.animate(
      [{ opacity: 0.9 }, { opacity: 0 }],
      { duration: 350, easing: 'ease-out' },
    );
    this.el.animate(
      [
        { boxShadow: '0 0 12px rgba(255,230,150,0.9)' },
        { boxShadow: '0 0 0 rgba(255,230,150,0)' },
      ],
      { duration: 450, easing: 'ease-out' },
    );
  }

  /** Highlight dots up to `level` (0 = none). */
  setLevel(level: number): void {
    this._level = level;
    const dots = this._levelDots.children;
    for (let i = 0; i < this._maxLevel; i++) {
      (dots[i] as HTMLElement).style.background = i < level ? '#cc9944' : '#444';
    }
  }

  /** Glow border when a skill point can be spent here (including learning from 0). */
  setCanLevel(can: boolean): void {
    this._canLevel = can;
    this._refreshBorder();
    this._refreshPointer();
  }

  /** Set cursor to pointer when the slot is clickable; pointer events stay on for tooltip hover. */
  private _refreshPointer(): void {
    this.el.style.pointerEvents = 'auto';
    this.el.style.cursor = (this._canLevel && this._onLevel) ? 'pointer' : '';
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
      // Border stays visible during cooldown — just slightly muted.
      this.el.style.borderColor = 'rgba(150,132,85,0.6)';
      this._keyLabel.style.color = '#997733';
    } else {
      // Ready: brightest border.
      this.el.style.borderColor = 'rgba(220,195,125,0.95)';
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
