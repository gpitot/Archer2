/**
 * Horizontal HP + XP bars beneath the spell bar — WC3-style status panel.
 *
 * Shows the hero's level on the left, then two stacked progress bars:
 *   • Top: health (green → yellow → red gradient, current / max HP)
 *   • Bottom: XP toward next level (gold gradient)
 */
import { HERO, heroMaxHp } from '../sim/rules';
import { xpForLevel } from '../sim/stepMatch';

export class HeroStatusBar {
  readonly el: HTMLDivElement;

  private _levelLabel: HTMLDivElement;
  private _hpBar: HTMLDivElement;
  private _hpFill: HTMLDivElement;
  private _hpText: HTMLDivElement;
  private _xpBar: HTMLDivElement;
  private _xpFill: HTMLDivElement;
  private _xpText: HTMLDivElement;

  constructor() {
    // ── Container ──
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      bottom: 2px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: stretch;
      gap: 6px;
      z-index: 200;
      pointer-events: none;
    `;

    // ── Level badge (circle) ──
    this._levelLabel = document.createElement('div');
    this._levelLabel.style.cssText = `
      width: 28px; min-width: 28px;
      height: 28px;
      border-radius: 2px;
      background: rgba(20, 16, 8, 0.9);
      border: 1px solid #665533;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: sans-serif;
      font-size: 15px;
      font-weight: bold;
      color: #f0d060;
      text-shadow: 0 0 4px rgba(0,0,0,0.8);
      align-self: center;
    `;
    this.el.appendChild(this._levelLabel);

    // ── Bars panel (HP + XP stacked) ──
    const bars = document.createElement('div');
    bars.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 2px;
      width: 212px;
    `;

    // Health bar
    this._hpBar = document.createElement('div');
    this._hpBar.style.cssText = `
      height: 12px;
      background: #111;
      border: 1px solid #665533;
      border-radius: 2px;
      position: relative;
      overflow: hidden;
    `;
    this._hpFill = document.createElement('div');
    this._hpFill.style.cssText = `
      height: 100%;
      background: #44cc44;
      border-radius: 1px;
    `;
    this._hpBar.appendChild(this._hpFill);
    this._hpText = this._makeBarText('10px');
    this._hpBar.appendChild(this._hpText);
    bars.appendChild(this._hpBar);

    // XP bar
    this._xpBar = document.createElement('div');
    this._xpBar.style.cssText = `
      height: 12px;
      background: #111;
      border: 1px solid #665533;
      border-radius: 2px;
      position: relative;
      overflow: hidden;
    `;
    this._xpFill = document.createElement('div');
    this._xpFill.style.cssText = `
      height: 100%;
      background: #887711;
      border-radius: 1px;
    `;
    this._xpBar.appendChild(this._xpFill);
    this._xpText = this._makeBarText('10px');
    this._xpBar.appendChild(this._xpText);
    bars.appendChild(this._xpBar);

    this.el.appendChild(bars);
    document.body.appendChild(this.el);
  }

  /**
   * Redraw bars and level. Call every frame from `updateHud`.
   */
  update(hp: number, level: number, xp: number, bonusHp = 0): void {
    // ── Level ──
    this._levelLabel.textContent = String(level);

    // ── HP bar ──
    const maxHp = heroMaxHp(level, bonusHp);
    const hpFrac = Math.max(0, Math.min(1, hp / maxHp));
    this._hpFill.style.width = `${(hpFrac * 100).toFixed(1)}%`;
    this._hpFill.style.background = hpFrac > 0.5
      ? `linear-gradient(to bottom, #66ee66, #339933)`
      : hpFrac > 0.25
        ? `linear-gradient(to bottom, #eeee44, #aa8800)`
        : `linear-gradient(to bottom, #ee4444, #991111)`;
    this._hpText.textContent = `${Math.floor(hp)} / ${Math.floor(maxHp)}`;

    // ── XP bar ──
    const curXp = xpForLevel(level);
    const nextXp = xpForLevel(level + 1);
    const needed = nextXp - curXp;
    const xpFrac = needed > 0 ? Math.max(0, Math.min(1, (xp - curXp) / needed)) : 1;
    this._xpFill.style.width = `${(xpFrac * 100).toFixed(1)}%`;
    this._xpFill.style.background = `linear-gradient(to bottom, #ddbb44, #886600)`;
    this._xpText.textContent = level >= HERO.maxLevel ? 'MAX' : `${xp - curXp} / ${needed}`;
  }

  destroy(): void {
    this.el.remove();
  }

  private _makeBarText(fontSize: string): HTMLDivElement {
    const div = document.createElement('div');
    div.style.cssText = `
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: sans-serif;
      font-size: ${fontSize};
      font-weight: bold;
      color: #fff;
      text-shadow: 0 0 4px #000, 0 1px 2px #000;
    `;
    return div;
  }
}


