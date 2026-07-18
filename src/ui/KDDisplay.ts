/**
 * League of Legends style score display — top-right corner, single row.
 *
 * Three sections: kills / deaths | gold | game time, in a dark panel.
 */

// ── Clock ──
const CLOCK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#c8aa6e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

// ── Crosshair / target (kills) ──
const KILL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ddbb66" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`;

// ── Skull (deaths) ──
const DEATH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ff7766" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M12 3a7 7 0 0 0-7 7c0 2.5 1 4 2 5h10c1-1 2-2.5 2-5a7 7 0 0 0-7-7z"/><path d="M9 16v3h6v-3"/><line x1="8" y1="21" x2="16" y2="21"/></svg>`;

// ── Coin (gold) ──
const GOLD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ffcc44" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 7v10"/><path d="M15 9.5c0-1-1.3-2-3-2s-3 1-3 2 1 1.8 3 2.3 3 1.3 3 2.2c0 1-1.3 2-3 2s-3-1-3-2"/></svg>`;

function formatGameTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function makeDivider(): HTMLDivElement {
  const divider = document.createElement('div');
  divider.style.cssText = `
    width: 1px;
    height: 18px;
    background: rgba(200,170,110,0.3);
  `;
  return divider;
}

export class KDDisplay {
  readonly el: HTMLDivElement;
  private _timeLabel: HTMLDivElement;
  private _killsLabel: HTMLSpanElement;
  private _deathsLabel: HTMLSpanElement;
  private _goldLabel: HTMLSpanElement;

  constructor() {
    // ── Panel wrapper ──
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 200;
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(1, 10, 19, 0.85);
      border: 1px solid rgba(200, 170, 110, 0.25);
      border-radius: 4px;
      padding: 5px 10px;
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    `;

    // ── Section 1: kills / deaths ──
    const killGroup = document.createElement('div');
    killGroup.style.cssText = 'display: flex; align-items: center; gap: 3px;';
    const killIcon = document.createElement('span');
    killIcon.innerHTML = KILL_ICON;
    killIcon.style.cssText = 'display: flex; align-items: center;';

    this._killsLabel = document.createElement('span');
    this._killsLabel.style.cssText = `
      font-size: 14px;
      font-weight: 700;
      color: #ddbb66;
      font-variant-numeric: tabular-nums;
      min-width: 10px;
      text-align: center;
    `;
    this._killsLabel.textContent = '0';
    killGroup.appendChild(killIcon);
    killGroup.appendChild(this._killsLabel);
    this.el.appendChild(killGroup);

    // ── Slash ──
    const slash = document.createElement('span');
    slash.style.cssText = `
      font-size: 13px;
      color: rgba(200,170,110,0.4);
      font-weight: 600;
      margin: 0 -4px;
    `;
    slash.textContent = '/';
    this.el.appendChild(slash);

    // ── Deaths ──
    const deathGroup = document.createElement('div');
    deathGroup.style.cssText = 'display: flex; align-items: center; gap: 3px;';
    const deathIcon = document.createElement('span');
    deathIcon.innerHTML = DEATH_ICON;
    deathIcon.style.cssText = 'display: flex; align-items: center;';

    this._deathsLabel = document.createElement('span');
    this._deathsLabel.style.cssText = `
      font-size: 14px;
      font-weight: 700;
      color: #ff7766;
      font-variant-numeric: tabular-nums;
      min-width: 10px;
      text-align: center;
    `;
    this._deathsLabel.textContent = '0';
    deathGroup.appendChild(deathIcon);
    deathGroup.appendChild(this._deathsLabel);
    this.el.appendChild(deathGroup);

    this.el.appendChild(makeDivider());

    // ── Section 2: gold ──
    const goldGroup = document.createElement('div');
    goldGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
    const goldIcon = document.createElement('span');
    goldIcon.innerHTML = GOLD_ICON;
    goldIcon.style.cssText = 'display: flex; align-items: center;';

    this._goldLabel = document.createElement('span');
    this._goldLabel.style.cssText = `
      font-size: 14px;
      font-weight: 700;
      color: #ffcc44;
      font-variant-numeric: tabular-nums;
      min-width: 10px;
      text-align: center;
    `;
    this._goldLabel.textContent = '0';
    goldGroup.appendChild(goldIcon);
    goldGroup.appendChild(this._goldLabel);
    this.el.appendChild(goldGroup);

    this.el.appendChild(makeDivider());

    // ── Section 3: game time ──
    const timeGroup = document.createElement('div');
    timeGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
    const clockIcon = document.createElement('span');
    clockIcon.innerHTML = CLOCK_ICON;
    clockIcon.style.cssText = 'display: flex; align-items: center;';

    this._timeLabel = document.createElement('div');
    this._timeLabel.style.cssText = `
      font-size: 12px;
      font-weight: 700;
      color: #c8aa6e;
      letter-spacing: 0.5px;
      font-variant-numeric: tabular-nums;
    `;
    this._timeLabel.textContent = '0:00';
    timeGroup.appendChild(clockIcon);
    timeGroup.appendChild(this._timeLabel);
    this.el.appendChild(timeGroup);

    document.body.appendChild(this.el);
  }

  update(kills: number, deaths: number, gold: number, gameTimeSeconds: number): void {
    this._killsLabel.textContent = String(kills);
    this._deathsLabel.textContent = String(deaths);
    this._goldLabel.textContent = String(Math.floor(gold));
    this._timeLabel.textContent = formatGameTime(gameTimeSeconds);
  }
}
