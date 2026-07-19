import { SHOP_ITEMS_BY_ID } from '../sim/shopItems';
import type { HeroState } from '../sim/state';
import { playerColorCss } from './colors';

/**
 * Display name for a hero. `names` comes from the room roster, so it's
 * populated for every real player; the fallbacks cover offline heroes and any
 * id that outlives its roster entry.
 */
function heroLabel(id: string, index: number, names?: ReadonlyMap<string, string>): string {
  const known = names?.get(id);
  if (known) return known;
  if (id === 'player') return 'Player';
  if (id === 'dummy') return 'Bot';
  if (id.length <= 12) return id;
  return `Player ${index + 1}`;
}

// ── Item icons ──────────────────────────────────────────────────────

/** An item icon sourced from the item's own `icon` + `color` fields. */
function buildItemIcon(itemId: string): HTMLSpanElement {
  const def = SHOP_ITEMS_BY_ID[itemId];
  const el = document.createElement('span');
  el.title = def?.name ?? itemId;
  el.textContent = def?.icon ?? '●';
  el.style.cssText = `
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px;
    background: ${def?.color ?? '#888'};
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 3px;
    vertical-align: middle;
    margin-right: 3px;
    font-size: 12px;
    box-shadow: 0 0 4px rgba(0,0,0,0.4);
  `;
  return el;
}

// ── Row slots we reference during refresh ──────────────────────────

interface HeroRowEls {
  killsEl: HTMLSpanElement;
  deathsEl: HTMLSpanElement;
  itemsEl: HTMLSpanElement;
}

// ────────────────────────────────────────────────────────────────────

interface ScoreCallbacks {
  onClose: () => void;
}

/**
 * Scoreboard modal — opens with Tab. Shows every hero sorted by kills
 * descending, colour-coded by their per-player colour, with item icons.
 */
export class ScoreWindow {
  readonly el: HTMLDivElement;
  private _overlay: HTMLDivElement;
  private _cb: ScoreCallbacks;
  private _visible = false;
  /** Live-update targets keyed by hero id. */
  private _rowEls = new Map<string, HeroRowEls>();

  constructor(cb: ScoreCallbacks) {
    this._cb = cb;

    // Backdrop
    this._overlay = document.createElement('div');
    this._overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 400;
      background: rgba(0,0,0,0.5);
      pointer-events: auto;
      display: none;
    `;
    this._overlay.addEventListener('click', () => this.close());
    document.body.appendChild(this._overlay);

    // Panel
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 401;
      pointer-events: auto;
      display: none;
      font-family: sans-serif;
    `;
    document.body.appendChild(this.el);
  }

  /** Build the full modal. Call once when first opened. */
  open(heroes: readonly HeroState[], playerId?: string, names?: ReadonlyMap<string, string>): void {
    // Sort: most kills descending, then deaths ascending (tie-breaker).
    const sorted = [...heroes].sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });

    this._rowEls.clear();
    this.el.innerHTML = '';

    const panel = document.createElement('div');
    panel.style.cssText = `
      background: rgba(10, 8, 5, 0.95);
      border: 2px solid #886622;
      border-radius: 8px;
      padding: 16px;
      min-width: 420px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'Scoreboard';
    title.style.cssText = `
      color: #ffcc44; font-size: 18px; font-weight: bold;
      text-align: center; margin-bottom: 12px;
      text-shadow: 0 0 6px rgba(0,0,0,0.5);
    `;
    panel.appendChild(title);

    // Header row
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      padding: 4px 8px; margin-bottom: 4px;
      color: #888; font-size: 11px; font-weight: bold;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    `;
    header.innerHTML = `
      <span style="width:20px;flex-shrink:0;"></span>
      <span style="flex:1;">Hero</span>
      <span style="width:60px;text-align:center;">Kills</span>
      <span style="width:60px;text-align:center;">Deaths</span>
      <span style="width:140px;">Items</span>
    `;
    panel.appendChild(header);

    // Rows
    for (let i = 0; i < sorted.length; i++) {
      const h = sorted[i];
      // Colour matches the 3D mesh and minimap dot.
      const color = playerColorCss(h.team);
      const isSelf = playerId !== undefined && h.id === playerId;

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px; margin-bottom: 2px;
        border-radius: 4px;
        background: ${isSelf ? 'rgba(255,255,200,0.08)' : 'rgba(20,15,5,0.4)'};
        border: 1px solid ${isSelf ? 'rgba(255,200,60,0.2)' : 'rgba(40,30,15,0.3)'};
      `;

      // Colour swatch
      const swatch = document.createElement('span');
      swatch.style.cssText = `
        display: inline-block;
        width: 14px; height: 14px;
        border-radius: 50%;
        background: ${color};
        border: 1px solid rgba(255,255,255,0.3);
        flex-shrink: 0;
      `;
      row.appendChild(swatch);

      // Name
      const nameEl = document.createElement('span');
      const label = heroLabel(h.id, heroes.indexOf(h), names);
      nameEl.textContent = isSelf ? `${label} (you)` : label;
      nameEl.style.cssText = `
        flex: 1;
        color: ${color};
        font-size: 13px;
        font-weight: bold;
        text-shadow: 0 0 4px rgba(0,0,0,0.5);
      `;
      row.appendChild(nameEl);

      // Kills (live-updated)
      const killsEl = document.createElement('span');
      killsEl.textContent = String(h.kills);
      killsEl.style.cssText = `
        width: 60px; text-align: center;
        color: #ffcc44; font-size: 13px; font-weight: bold;
      `;
      row.appendChild(killsEl);

      // Deaths (live-updated)
      const deathsEl = document.createElement('span');
      deathsEl.textContent = String(h.deaths);
      deathsEl.style.cssText = `
        width: 60px; text-align: center;
        color: #ff6666; font-size: 13px; font-weight: bold;
      `;
      row.appendChild(deathsEl);

      // Items (live-updated)
      const itemsEl = document.createElement('span');
      itemsEl.style.cssText = 'width: 140px; display: flex; align-items: center;';
      row.appendChild(itemsEl);

      this._rowEls.set(h.id, { killsEl, deathsEl, itemsEl });
      panel.appendChild(row);
    }

    // Footer hint
    const hint = document.createElement('div');
    hint.textContent = 'Press Tab or click outside to close';
    hint.style.cssText = `
      color: #666; font-size: 10px; text-align: center; margin-top: 10px;
    `;
    panel.appendChild(hint);

    this.el.appendChild(panel);

    this._overlay.style.display = 'block';
    this.el.style.display = 'block';
    this._visible = true;
  }

  /** Lightweight per-frame update — syncs kills, deaths, and items. */
  refresh(heroes: readonly HeroState[]): void {
    if (!this._visible) return;
    for (const h of heroes) {
      const els = this._rowEls.get(h.id);
      if (!els) continue;
      // Kills / Deaths
      els.killsEl.textContent = String(h.kills);
      els.deathsEl.textContent = String(h.deaths);
      // Items
      els.itemsEl.innerHTML = '';
      for (const itemId of h.inventory) {
        if (itemId) {
          els.itemsEl.appendChild(buildItemIcon(itemId));
        }
      }
      if (h.inventory.every((s) => s === null)) {
        const empty = document.createElement('span');
        empty.textContent = '—';
        empty.style.cssText = 'color:#555;font-size:11px;';
        els.itemsEl.appendChild(empty);
      }
    }
  }

  close(): void {
    if (!this._visible) return;
    this._overlay.style.display = 'none';
    this.el.style.display = 'none';
    this.el.innerHTML = '';
    this._rowEls.clear();
    this._visible = false;
    this._cb.onClose();
  }

  get visible(): boolean {
    return this._visible;
  }
}
