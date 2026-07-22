/**
 * Pre-game lobby: who's in the room, who's ready, and the Start button.
 *
 * Shown while the map is still loading in the background, so it doubles as the
 * loading screen — hence `setLocalLoaded`, which gates Ready until this client
 * actually has a world to play in.
 *
 * Offline mode reuses the same screen with a one-row roster and no socket;
 * `waitForLocalStart` stands in for the server's `matchStart`.
 */
import type { LobbyPlayer } from '../sim/protocol';
import type { AiDifficulty } from '../sim/ai/AiController';
import { playerColorCss } from './colors';

export interface LobbyCallbacks {
  onToggleReady: (ready: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
  /** Add an AI bot at the given difficulty (online rooms only). */
  onAddBot?: (difficulty: AiDifficulty) => void;
  /** Remove a bot by its roster player id (online rooms only). */
  onRemoveBot?: (playerId: string) => void;
}

interface LobbyOpts {
  /** Room code, or null for offline practice. */
  room: string | null;
  /** Offline has nobody to wait for, so it hides the Ready toggle. */
  showReady: boolean;
  /** Whether to offer the "add AI bot" control (online rooms only). */
  showBots?: boolean;
  cb: LobbyCallbacks;
}

const DIFFICULTIES: readonly AiDifficulty[] = ['easy', 'medium', 'hard'];

export class LobbyScreen {
  private _overlay: HTMLDivElement;
  private _rows: HTMLDivElement;
  private _status: HTMLDivElement;
  private _readyBtn: HTMLButtonElement;
  private _startBtn: HTMLButtonElement;
  private _botRow: HTMLDivElement | null = null;
  private _modeLine: HTMLDivElement;
  private _visible = false;
  private _loaded = false;
  private _ready = false;
  private _canStart = false;
  private _resolveLocalStart: (() => void) | null = null;

  constructor(private _opts: LobbyOpts) {
    this._overlay = document.createElement('div');
    this._overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 500;
      background: rgba(0,0,0,0.75);
      display: none; align-items: center; justify-content: center;
      font-family: sans-serif;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      background: rgba(10, 8, 5, 0.95);
      border: 2px solid #886622;
      border-radius: 8px;
      padding: 20px;
      min-width: 380px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    `;
    this._overlay.appendChild(panel);

    panel.appendChild(this._buildHeader());

    // Mode line — filled via setMode once the room's mode is known.
    this._modeLine = document.createElement('div');
    this._modeLine.style.cssText = 'color:#cc9944; font-size:12px; font-weight:bold; min-height:0;';
    panel.appendChild(this._modeLine);

    this._rows = document.createElement('div');
    this._rows.style.cssText = 'margin: 12px 0; min-height: 40px;';
    panel.appendChild(this._rows);

    this._status = document.createElement('div');
    this._status.style.cssText = 'color:#998866; font-size:11px; min-height:14px; margin-bottom:8px;';
    panel.appendChild(this._status);

    if (_opts.showBots) {
      this._botRow = this._buildBotControl();
      panel.appendChild(this._botRow);
    }

    this._readyBtn = this._button('Ready', false);
    this._readyBtn.onclick = () => {
      if (!this._loaded) return;
      this._ready = !this._ready;
      this._opts.cb.onToggleReady(this._ready);
      this._syncButtons();
    };
    if (_opts.showReady) panel.appendChild(this._readyBtn);

    this._startBtn = this._button('Start game', true);
    this._startBtn.onclick = () => {
      if (!this._canStart) return;
      this._opts.cb.onStart();
      this._resolveLocalStart?.();
      this._resolveLocalStart = null;
    };
    panel.appendChild(this._startBtn);

    const leave = this._button('Leave', false);
    leave.onclick = () => this._opts.cb.onLeave();
    panel.appendChild(leave);

    document.body.appendChild(this._overlay);
    this.setStatus('Loading map…');
    this._syncButtons();
  }

  get visible(): boolean { return this._visible; }

  open(): void {
    this._visible = true;
    this._overlay.style.display = 'flex';
  }

  close(): void {
    this._visible = false;
    this._overlay.style.display = 'none';
  }

  dispose(): void {
    this._overlay.remove();
  }

  /** Free-text line under the roster: loading, errors, disconnects. */
  setStatus(text: string): void {
    this._status.textContent = text;
  }

  /**
   * Show which game mode the room runs, once known (creator: immediately;
   * joiner: from the welcome). Defenders also hides the bot control — the
   * server rejects bots there (the AI only knows how to hunt heroes).
   */
  setMode(mode: string): void {
    this._modeLine.textContent = mode === 'defenders' ? 'Defenders — defend your castle together' : '';
    if (this._botRow) this._botRow.style.display = mode === 'defenders' ? 'none' : 'flex';
  }

  /** The local world finished building — Ready becomes available. */
  setLocalLoaded(loaded: boolean): void {
    this._loaded = loaded;
    if (loaded && this._status.textContent === 'Loading map…') this.setStatus('');
    this._syncButtons();
  }

  /** Redraw the roster. `selfId` gets the "(you)" suffix and highlight. */
  setRoster(players: readonly LobbyPlayer[], selfId: string | null): void {
    this._rows.textContent = '';

    for (const p of players) {
      const isSelf = p.playerId === selfId;
      const color = playerColorCss(p.team);

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px; margin-bottom: 4px;
        border-radius: 4px;
        background: ${isSelf ? 'rgba(255,255,200,0.08)' : 'rgba(20,15,5,0.4)'};
        border: 1px solid ${isSelf ? 'rgba(255,200,60,0.2)' : 'rgba(40,30,15,0.3)'};
      `;

      const swatch = document.createElement('span');
      swatch.style.cssText = `
        display: inline-block; width: 14px; height: 14px;
        border-radius: 50%; background: ${color};
        border: 1px solid rgba(255,255,255,0.3); flex-shrink: 0;
      `;
      row.appendChild(swatch);

      const name = document.createElement('span');
      // textContent, never innerHTML — names come from other players.
      name.textContent = isSelf ? `${p.name} (you)` : p.name;
      name.style.cssText = `
        flex: 1; color: ${color}; font-size: 13px; font-weight: bold;
        text-shadow: 0 0 4px rgba(0,0,0,0.5);
      `;
      row.appendChild(name);

      if (p.isBot) {
        const pill = document.createElement('span');
        pill.textContent = `Bot · ${p.difficulty ?? 'medium'}`;
        pill.style.cssText = 'font-size:11px; font-weight:bold; color:#88aacc;';
        row.appendChild(pill);

        // Any player may drop a bot, mirroring the server (which only gates on
        // being a real player in the lobby). Hidden when no handler is wired.
        if (this._opts.cb.onRemoveBot) {
          const remove = document.createElement('button');
          remove.textContent = '✕';
          remove.title = 'Remove bot';
          remove.style.cssText = `
            padding: 2px 7px; background: rgba(120,40,30,0.5);
            border: 1px solid #aa5544; border-radius: 4px;
            color: #ffbbaa; font-size: 12px; font-weight: bold;
            font-family: inherit; cursor: pointer; flex-shrink: 0;
          `;
          remove.onclick = () => this._opts.cb.onRemoveBot?.(p.playerId);
          row.appendChild(remove);
        }
      } else {
        const pill = document.createElement('span');
        pill.textContent = p.ready ? '✓ Ready' : 'Waiting…';
        pill.style.cssText = `
          font-size: 11px; font-weight: bold;
          color: ${p.ready ? '#66dd88' : '#887766'};
        `;
        row.appendChild(pill);
      }

      this._rows.appendChild(row);
    }

    // The server re-validates this; the button state is only a hint.
    this._canStart = players.length > 0 && players.every((p) => p.ready);
    this._syncButtons();
  }

  /**
   * Offline stand-in for the server's `matchStart` — resolves when the local
   * player presses Start.
   */
  waitForLocalStart(): Promise<void> {
    return new Promise((resolve) => { this._resolveLocalStart = resolve; });
  }

  // ── Internals ─────────────────────────────────────────────────────

  private _buildHeader(): HTMLDivElement {
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:4px;';

    const title = document.createElement('div');
    title.textContent = this._opts.room ? `Room ${this._opts.room}` : 'Practice (offline)';
    title.style.cssText = `
      flex: 1; color: #ffcc44; font-size: 18px; font-weight: bold;
      text-shadow: 0 0 6px rgba(0,0,0,0.5);
    `;
    header.appendChild(title);

    if (this._opts.room) {
      const copy = this._button('Copy link', false);
      copy.style.cssText += 'width:auto; margin-top:0; padding:6px 10px; font-size:11px;';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(location.href);
          copy.textContent = 'Copied!';
          setTimeout(() => { copy.textContent = 'Copy link'; }, 1500);
        } catch {
          // Clipboard needs a secure context / permission; the URL bar works too.
          this.setStatus(`Share this link: ${location.href}`);
        }
      };
      header.appendChild(copy);
    }

    return header;
  }

  /** A difficulty dropdown + "Add bot" button, side by side. */
  private _buildBotControl(): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; margin-bottom:8px;';

    const select = document.createElement('select');
    select.style.cssText = `
      flex: 1; box-sizing: border-box; padding: 8px 10px;
      background: rgba(0,0,0,0.5); border: 1px solid #886622; border-radius: 4px;
      color: #ffe9b0; font-size: 13px; font-family: inherit; cursor: pointer;
    `;
    for (const d of DIFFICULTIES) {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = `${d[0].toUpperCase()}${d.slice(1)}`;
      o.style.cssText = 'background:#1a140a; color:#ffe9b0;';
      if (d === 'medium') o.selected = true;
      select.appendChild(o);
    }
    row.appendChild(select);

    const add = this._button('Add bot', false);
    add.style.cssText += 'width:auto; margin-top:0; padding:8px 14px;';
    add.onclick = () => this._opts.cb.onAddBot?.(select.value as AiDifficulty);
    row.appendChild(add);

    return row;
  }

  private _button(label: string, primary: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `
      display: block; width: 100%;
      padding: 10px; margin-top: 8px;
      background: ${primary ? 'rgba(136,102,34,0.5)' : 'rgba(40,30,15,0.5)'};
      border: 1px solid ${primary ? '#ffcc44' : '#886622'};
      border-radius: 4px;
      color: ${primary ? '#ffcc44' : '#ccb888'};
      font-size: 14px; font-weight: bold; font-family: inherit;
      cursor: pointer;
    `;
    return b;
  }

  private _syncButtons(): void {
    this._readyBtn.textContent = this._ready ? 'Not ready' : 'Ready';
    this._setEnabled(this._readyBtn, this._loaded);
    this._setEnabled(this._startBtn, this._canStart && this._loaded);
  }

  private _setEnabled(btn: HTMLButtonElement, enabled: boolean): void {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1' : '0.4';
    btn.style.cursor = enabled ? 'pointer' : 'default';
  }
}
