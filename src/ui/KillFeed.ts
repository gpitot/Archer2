/**
 * Top-centre kill feed that shows "X killed Y", "First Blood", streak and
 * multi-kill announcements. Messages stack, fade in, then fade out after a
 * few seconds — WC3 / DotA-style.
 */
import { playerColorCss } from './colors';

const DISPLAY_DURATION = 3.5;
const FADE_OUT_DURATION = 0.6;

/** Streak count → announcement label. */
const STREAK_LABELS: Record<number, string> = {
  3: 'Killing Spree',
  4: 'Dominating',
  5: 'Mega Kill',
  6: 'Unstoppable',
  7: 'Wicked Sick',
  8: 'Monster Kill',
  9: 'Godlike',
};

/** Multi-kill count → announcement label. */
const MULTI_LABELS: Record<number, string> = {
  2: 'Double Kill',
  3: 'Triple Kill',
};

interface FeedEntry {
  el: HTMLDivElement;
  age: number;
}

export class KillFeed {
  private _container: HTMLDivElement;
  private _entries: FeedEntry[] = [];

  constructor() {
    this._container = document.createElement('div');
    this._container.style.cssText = `
      position: fixed;
      top: 40px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 600;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      pointer-events: none;
    `;
    document.body.appendChild(this._container);
  }

  /**
   * "X killed Y" with team-coloured names and a skinnier neutral "killed"
   * connector. Killer colour comes from `killerTeam`, victim from
   * `victimTeam`.
   */
  kill(killerName: string, killerTeam: number, victimName: string, victimTeam: number): void {
    const el = this._makeEntry();
    const kc = playerColorCss(killerTeam);
    const vc = playerColorCss(victimTeam);

    const killerSpan = document.createElement('span');
    killerSpan.textContent = killerName;
    killerSpan.style.cssText = `color:${kc}; font-weight:700;`;

    const mid = document.createElement('span');
    mid.textContent = ' killed ';
    mid.style.cssText = 'color:#aaaaaa; font-weight:400;';

    const victimSpan = document.createElement('span');
    victimSpan.textContent = victimName;
    victimSpan.style.cssText = `color:${vc}; font-weight:700;`;

    el.appendChild(killerSpan);
    el.appendChild(mid);
    el.appendChild(victimSpan);

    this._push(el);
  }

  /** "victimName died to jungle creeps" — neutral grey text with victim colour. */
  creepKill(victimName: string, victimTeam: number): void {
    const el = this._makeEntry();
    const vc = playerColorCss(victimTeam);

    const victimSpan = document.createElement('span');
    victimSpan.textContent = victimName;
    victimSpan.style.cssText = `color:${vc}; font-weight:700;`;

    const rest = document.createElement('span');
    rest.textContent = ' died to jungle creeps';
    rest.style.cssText = 'color:#999966; font-weight:500;';

    el.appendChild(victimSpan);
    el.appendChild(rest);
    this._push(el);
  }

  /** One-shot callout: "First Blood!", streak, multi-kill, etc. */
  announce(text: string, color = '#ffd700'): void {
    const el = this._makeEntry();
    el.textContent = text;
    el.style.color = color;
    el.style.fontWeight = '800';
    el.style.fontSize = '18px';
    el.style.textShadow = '0 0 8px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.6)';
    this._push(el);
  }

  /** Killer is on a streak — display the appropriate label. */
  streak(killerName: string, killerTeam: number, count: number): void {
    const label = STREAK_LABELS[count];
    if (!label) return;
    const el = this._makeEntry();
    const kc = playerColorCss(killerTeam);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = killerName;
    nameSpan.style.cssText = `color:${kc}; font-weight:700;`;

    const rest = document.createElement('span');
    rest.textContent = ` is on a ${label}`;
    rest.style.cssText = 'color:#ffcc44; font-weight:600;';

    el.appendChild(nameSpan);
    el.appendChild(rest);
    el.style.fontSize = '16px';
    this._push(el);
  }

  /** Multi-kill: "Double Kill", "Triple Kill" with the killer's colour. */
  multiKill(killerName: string, killerTeam: number, count: number): void {
    const label = MULTI_LABELS[count];
    if (!label) return;
    const el = this._makeEntry();
    const kc = playerColorCss(killerTeam);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = killerName;
    nameSpan.style.cssText = `color:${kc}; font-weight:700;`;

    const rest = document.createElement('span');
    rest.textContent = ` — ${label}`;
    rest.style.cssText = 'color:#ff8844; font-weight:800;';

    el.appendChild(nameSpan);
    el.appendChild(rest);
    el.style.fontSize = '18px';
    el.style.textShadow = '0 0 8px rgba(0,0,0,0.8), 0 2px 4px rgba(0,0,0,0.5)';
    this._push(el);
  }

  /** Advance timers and fade out expired entries. */
  update(dt: number): void {
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const entry = this._entries[i];
      entry.age += dt;
      const remaining = Math.max(0, DISPLAY_DURATION - entry.age);
      if (remaining <= 0) {
        this._remove(entry, i);
        continue;
      }
      // Fade out during the last FADE_OUT_DURATION seconds.
      const fade = remaining < FADE_OUT_DURATION ? remaining / FADE_OUT_DURATION : 1;
      entry.el.style.opacity = String(fade);
    }
  }

  dispose(): void {
    for (let i = this._entries.length - 1; i >= 0; i--) {
      this._remove(this._entries[i], i);
    }
    this._container.remove();
  }

  // ── internals ──────────────────────────────────────────────────────

  private _makeEntry(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = `
      font-family: sans-serif;
      font-size: 15px;
      text-shadow: 0 0 6px rgba(0,0,0,0.7), 0 1px 3px rgba(0,0,0,0.5);
      white-space: nowrap;
      transition: none;
    `;
    return el;
  }

  private _push(el: HTMLDivElement): void {
    // Newest entry on top — insert as first child.
    this._container.insertBefore(el, this._container.firstChild);
    this._entries.push({ el, age: 0 });

    // Cap visible entries at 5 so the feed never overflows the screen.
    while (this._entries.length > 5) {
      const oldest = this._entries[0];
      this._remove(oldest, 0);
    }
  }

  private _remove(entry: FeedEntry, index: number): void {
    entry.el.remove();
    this._entries.splice(index, 1);
  }
}
