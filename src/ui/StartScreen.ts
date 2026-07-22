/**
 * First screen the player sees: pick a display name, then create a room, join
 * one by code, or play offline against the practice bot.
 *
 * Follows the same imperative-DOM pattern as the rest of `src/ui` (see
 * ScoreWindow), at a higher z-index so it covers the game canvas entirely.
 */
import { MAX_NAME_LEN, sanitizeName } from '../core/playerPrefs';
import { normalizeRoomCode } from '../core/roomCode';

export type StartMode = 'create' | 'join' | 'offline';

/** Maps offered in the create-room dropdown. First entry is the default. */
const MAP_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'pentad', label: 'Pentad (5 players)' },
  { value: '2pv1', label: '2p v 1' },
];

export interface StartChoice {
  mode: StartMode;
  name: string;
  /** Present for 'join'; the caller generates one for 'create'. */
  roomCode?: string;
  /** Chosen map for 'create' (from the dropdown); absent for join/offline. */
  map?: string;
}

interface StartScreenOpts {
  /** Remembered name from localStorage, if any. */
  prefill: string | null;
  /** Room code already in the URL — collapses the UI to a single Join button. */
  room: string | null;
}

const PANEL_CSS = `
  background: rgba(10, 8, 5, 0.95);
  border: 2px solid #886622;
  border-radius: 8px;
  padding: 24px;
  min-width: 340px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.6);
`;

const INPUT_CSS = `
  width: 100%; box-sizing: border-box;
  padding: 8px 10px; margin-bottom: 4px;
  background: rgba(0,0,0,0.5);
  border: 1px solid #886622; border-radius: 4px;
  color: #ffe9b0; font-size: 15px; font-family: inherit;
  outline: none;
`;

function button(label: string, primary: boolean): HTMLButtonElement {
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

export class StartScreen {
  private _overlay: HTMLDivElement;
  private _panel: HTMLDivElement;
  private _nameInput!: HTMLInputElement;
  private _mapSelect: HTMLSelectElement | null = null;
  private _error!: HTMLDivElement;
  private _resolve: ((c: StartChoice) => void) | null = null;

  constructor(private _opts: StartScreenOpts) {
    this._overlay = document.createElement('div');
    this._overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 500;
      background: rgba(0,0,0,0.75);
      display: flex; align-items: center; justify-content: center;
      font-family: sans-serif;
    `;

    this._panel = document.createElement('div');
    this._panel.style.cssText = PANEL_CSS;
    this._overlay.appendChild(this._panel);

    this._build();
  }

  /** Show the screen and resolve once the player picks how to play. */
  show(): Promise<StartChoice> {
    document.body.appendChild(this._overlay);
    // Focus after insertion, and select so a remembered name is easy to replace.
    this._nameInput.focus();
    this._nameInput.select();
    return new Promise((resolve) => { this._resolve = resolve; });
  }

  close(): void {
    this._overlay.remove();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private _build(): void {
    const title = document.createElement('div');
    title.textContent = 'Archer';
    title.style.cssText = `
      color: #ffcc44; font-size: 24px; font-weight: bold;
      text-align: center; margin-bottom: 16px;
      text-shadow: 0 0 8px rgba(0,0,0,0.6);
    `;
    this._panel.appendChild(title);

    const label = document.createElement('div');
    label.textContent = 'Display name';
    label.style.cssText = 'color:#998866; font-size:11px; font-weight:bold; margin-bottom:4px;';
    this._panel.appendChild(label);

    this._nameInput = document.createElement('input');
    this._nameInput.type = 'text';
    this._nameInput.maxLength = MAX_NAME_LEN;
    this._nameInput.value = this._opts.prefill ?? '';
    this._nameInput.placeholder = 'Your name';
    this._nameInput.style.cssText = INPUT_CSS;
    this._panel.appendChild(this._nameInput);

    this._error = document.createElement('div');
    this._error.style.cssText = 'color:#ff8866; font-size:11px; min-height:14px; margin-bottom:8px;';
    this._panel.appendChild(this._error);

    if (this._opts.room) {
      this._buildInvited(this._opts.room);
    } else {
      this._buildDefault();
    }
  }

  /** Arrived via a shared link — joining that room is the obvious action. */
  private _buildInvited(room: string): void {
    const join = button(`Join room ${room}`, true);
    join.onclick = () => this._pick('join', room);
    this._panel.appendChild(join);
    this._nameInput.onkeydown = (e) => { if (e.key === 'Enter') join.click(); };

    const create = button('Create a new room instead', false);
    create.onclick = () => this._pick('create');
    this._panel.appendChild(create);

    const offline = button('Practice offline', false);
    offline.onclick = () => this._pick('offline');
    this._panel.appendChild(offline);
  }

  private _buildDefault(): void {
    // Map picker — only relevant when creating a room (the first joiner sets
    // the room's map). Its value rides the 'create' choice.
    const mapLabel = document.createElement('div');
    mapLabel.textContent = 'Map';
    mapLabel.style.cssText = 'color:#998866; font-size:11px; font-weight:bold; margin-bottom:4px;';
    this._panel.appendChild(mapLabel);

    const mapSelect = document.createElement('select');
    mapSelect.style.cssText = INPUT_CSS + 'margin-bottom:12px; cursor:pointer;';
    for (const opt of MAP_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      o.style.cssText = 'background:#1a140a; color:#ffe9b0;';
      mapSelect.appendChild(o);
    }
    this._mapSelect = mapSelect;
    this._panel.appendChild(mapSelect);

    const create = button('Create room', true);
    create.onclick = () => this._pick('create');
    this._panel.appendChild(create);
    this._nameInput.onkeydown = (e) => { if (e.key === 'Enter') create.click(); };

    // "Join room" swaps itself for a code field rather than opening a second
    // screen — one less step for the common paste-a-code case.
    const joinBtn = button('Join room', false);
    const codeRow = document.createElement('div');
    codeRow.style.cssText = 'display:none; margin-top:8px;';

    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.maxLength = 8;
    codeInput.placeholder = 'Room code';
    codeInput.style.cssText = INPUT_CSS + 'text-transform: uppercase; letter-spacing: 2px;';
    codeInput.oninput = () => { codeInput.value = normalizeRoomCode(codeInput.value); };
    codeRow.appendChild(codeInput);

    const confirm = button('Join', true);
    const doJoin = () => {
      const code = normalizeRoomCode(codeInput.value);
      if (!code) { this._error.textContent = 'Enter a room code.'; return; }
      this._pick('join', code);
    };
    confirm.onclick = doJoin;
    codeInput.onkeydown = (e) => { if (e.key === 'Enter') doJoin(); };
    codeRow.appendChild(confirm);

    joinBtn.onclick = () => {
      codeRow.style.display = 'block';
      joinBtn.style.display = 'none';
      codeInput.focus();
    };
    this._panel.appendChild(joinBtn);
    this._panel.appendChild(codeRow);

    const offline = button('Practice offline', false);
    offline.onclick = () => this._pick('offline');
    this._panel.appendChild(offline);
  }

  private _pick(mode: StartMode, roomCode?: string): void {
    const raw = this._nameInput.value.trim();
    if (!raw) {
      this._error.textContent = 'Pick a display name first.';
      this._nameInput.focus();
      return;
    }
    const map = mode === 'create' ? (this._mapSelect?.value ?? undefined) : undefined;
    this._resolve?.({ mode, name: sanitizeName(raw), roomCode, map });
    this._resolve = null;
    this.close();
  }
}
