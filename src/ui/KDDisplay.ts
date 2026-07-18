/**
 * League of Legends style score display — top-right corner, single row.
 *
 * Shows game time | kills / deaths with icons in a dark panel.
 */

// ── Clock ──
const CLOCK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#c8aa6e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

// ── Crosshair / target (kills) ──
const KILL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ddbb66" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`;

// ── Skull (deaths) ──
const DEATH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ff7766" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M12 3a7 7 0 0 0-7 7c0 2.5 1 4 2 5h10c1-1 2-2.5 2-5a7 7 0 0 0-7-7z"/><path d="M9 16v3h6v-3"/><line x1="8" y1="21" x2="16" y2="21"/></svg>`;

function formatGameTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export class KDDisplay {
  readonly el: HTMLDivElement;
  private _timeLabel: HTMLDivElement;
  private _killsLabel: HTMLSpanElement;
  private _deathsLabel: HTMLSpanElement;

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

    // ── Game time ──
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

    // ── Divider ──
    const divider = document.createElement('div');
    divider.style.cssText = `
      width: 1px;
      height: 18px;
      background: rgba(200,170,110,0.3);
    `;
    this.el.appendChild(divider);

    // ── Kills ──
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

    document.body.appendChild(this.el);
  }

  update(kills: number, deaths: number, gameTimeSeconds: number): void {
    this._timeLabel.textContent = formatGameTime(gameTimeSeconds);
    this._killsLabel.textContent = String(kills);
    this._deathsLabel.textContent = String(deaths);
  }
}
