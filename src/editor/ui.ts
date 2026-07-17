/**
 * Editor chrome (plain DOM): top bar (map lifecycle), left tool palette
 * with a per-tool context row, bottom status bar, and the hotkey help
 * overlay. Styling lives in editor.html.
 */
import {
  TOOLS, ToolId, TEXTURES, CAMP_PRESETS, campPresetLabel, DECO_KINDS,
} from './tools';

export interface UiCallbacks {
  onSelectTool(id: ToolId): void;
  onSelectTexture(index: number): void;
  onSelectCampPreset(index: number): void;
  onSelectDeco(index: number): void;
  onNewMap(name: string, tilesX: number, tilesZ: number): void;
  onLoadMap(name: string): void;
  onRename(name: string): void;
  onSave(): void;
  onPlaytest(): void;
  onUndo(): void;
  onRedo(): void;
  onTogglePathing(): void;
}

export class EditorUI {
  private _toolButtons = new Map<ToolId, HTMLButtonElement>();
  private _textureButtons: HTMLButtonElement[] = [];
  private _campButtons: HTMLButtonElement[] = [];
  private _decoButtons: HTMLButtonElement[] = [];
  private _contextRows = new Map<string, HTMLElement>();
  private _status: HTMLElement;
  private _mapLabel: HTMLElement;
  private _nameInput: HTMLInputElement;
  private _mapSelect: HTMLSelectElement;
  private _help: HTMLElement;

  constructor(private _cb: UiCallbacks) {
    this._buildTopbar();
    this._buildPalette();
    this._status = document.getElementById('status')!;
    this._mapLabel = document.getElementById('map-label')!;
    this._nameInput = document.getElementById('map-name') as HTMLInputElement;
    this._mapSelect = document.getElementById('map-select') as HTMLSelectElement;
    this._help = this._buildHelp();
  }

  // ── Top bar ───────────────────────────────────────────────────

  private _buildTopbar(): void {
    const bar = document.getElementById('topbar')!;
    bar.innerHTML = `
      <span class="brand">archer map editor</span>
      <input id="map-name" title="map name" spellcheck="false" />
      <span id="map-label"></span>
      <span class="sep"></span>
      <button id="btn-new">New</button>
      <select id="map-select" title="open a saved map"><option value="">Open…</option></select>
      <button id="btn-save" title="Ctrl+S — writes .map.json + .amap">Save</button>
      <button id="btn-play" title="save + open the game on this map">Playtest</button>
      <span class="sep"></span>
      <button id="btn-undo" title="Ctrl+Z">Undo</button>
      <button id="btn-redo" title="Ctrl+Shift+Z">Redo</button>
      <button id="btn-pathing" title="O — derived pathing overlay">Pathing</button>
      <button id="btn-help" title="?">Keys</button>
    `;
    document.getElementById('btn-new')!.onclick = () => this.showNewDialog();
    document.getElementById('btn-save')!.onclick = () => this._cb.onSave();
    document.getElementById('btn-play')!.onclick = () => this._cb.onPlaytest();
    document.getElementById('btn-undo')!.onclick = () => this._cb.onUndo();
    document.getElementById('btn-redo')!.onclick = () => this._cb.onRedo();
    document.getElementById('btn-pathing')!.onclick = () => this._cb.onTogglePathing();
    document.getElementById('btn-help')!.onclick = () => this.toggleHelp();

    const select = document.getElementById('map-select') as HTMLSelectElement;
    select.onchange = () => {
      if (select.value) this._cb.onLoadMap(select.value);
      select.value = '';
    };
    const name = document.getElementById('map-name') as HTMLInputElement;
    name.onchange = () => this._cb.onRename(name.value);
    name.onkeydown = (e) => e.stopPropagation();
  }

  setMapList(names: string[]): void {
    this._mapSelect.innerHTML =
      '<option value="">Open…</option>' +
      names.map((n) => `<option value="${n}">${n}</option>`).join('');
  }

  setMapInfo(name: string, tilesX: number, tilesZ: number, dirty: boolean): void {
    if (document.activeElement !== this._nameInput) this._nameInput.value = name;
    this._mapLabel.textContent = `${tilesX}×${tilesZ}${dirty ? ' •' : ''}`;
    this._mapLabel.classList.toggle('dirty', dirty);
  }

  setPathingActive(on: boolean): void {
    document.getElementById('btn-pathing')!.classList.toggle('active', on);
  }

  // ── Palette + context rows ────────────────────────────────────

  private _buildPalette(): void {
    const pal = document.getElementById('palette')!;
    for (const tool of TOOLS) {
      const btn = document.createElement('button');
      btn.className = 'tool';
      btn.innerHTML = `<kbd>${tool.key}</kbd>${tool.label}`;
      btn.title = tool.hint;
      btn.onclick = () => this._cb.onSelectTool(tool.id);
      pal.appendChild(btn);
      this._toolButtons.set(tool.id, btn);
    }

    // Texture swatches (visible with the texture tool).
    const texRow = document.createElement('div');
    texRow.className = 'context-row';
    for (const tex of TEXTURES) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = tex.color;
      b.title = `${tex.label} (${tex.id})`;
      b.onclick = () => this._cb.onSelectTexture(tex.index);
      texRow.appendChild(b);
      this._textureButtons.push(b);
    }
    pal.appendChild(texRow);
    this._contextRows.set('paint', texRow);

    // Camp compositions.
    const campRow = document.createElement('div');
    campRow.className = 'context-row column';
    CAMP_PRESETS.forEach((preset, i) => {
      const b = document.createElement('button');
      b.textContent = campPresetLabel(preset);
      b.onclick = () => this._cb.onSelectCampPreset(i);
      campRow.appendChild(b);
      this._campButtons.push(b);
    });
    pal.appendChild(campRow);
    this._contextRows.set('camp', campRow);

    // Decoration variants.
    const decoRow = document.createElement('div');
    decoRow.className = 'context-row';
    DECO_KINDS.forEach((kind, i) => {
      const b = document.createElement('button');
      b.textContent = kind;
      b.onclick = () => this._cb.onSelectDeco(i);
      decoRow.appendChild(b);
      this._decoButtons.push(b);
    });
    pal.appendChild(decoRow);
    this._contextRows.set('deco', decoRow);
  }

  setActiveTool(id: ToolId): void {
    for (const [tid, btn] of this._toolButtons) btn.classList.toggle('active', tid === id);
    for (const [key, row] of this._contextRows) row.style.display = key === id ? 'flex' : 'none';
  }

  setActiveTexture(index: number): void {
    this._textureButtons.forEach((b, i) => b.classList.toggle('active', i === index));
  }

  setActiveCampPreset(index: number): void {
    this._campButtons.forEach((b, i) => b.classList.toggle('active', i === index));
  }

  setActiveDeco(index: number): void {
    this._decoButtons.forEach((b, i) => b.classList.toggle('active', i === index));
  }

  // ── Status bar / dialogs ──────────────────────────────────────

  setStatus(text: string): void {
    this._status.textContent = text;
  }

  flash(text: string): void {
    this.setStatus(text);
    this._status.classList.remove('flash');
    void this._status.offsetWidth; // restart the CSS animation
    this._status.classList.add('flash');
  }

  showNewDialog(): void {
    const dlg = document.getElementById('new-dialog') as HTMLDialogElement;
    const form = dlg.querySelector('form')!;
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = (document.getElementById('new-name') as HTMLInputElement).value.trim();
      const tilesX = Number((document.getElementById('new-x') as HTMLInputElement).value);
      const tilesZ = Number((document.getElementById('new-z') as HTMLInputElement).value);
      dlg.close();
      this._cb.onNewMap(name, tilesX, tilesZ);
    };
    dlg.showModal();
  }

  toggleHelp(): void {
    this._help.style.display = this._help.style.display === 'none' ? 'block' : 'none';
  }

  private _buildHelp(): HTMLElement {
    const el = document.getElementById('help')!;
    const rows = TOOLS.map((t) => `<tr><td><kbd>${t.key}</kbd></td><td>${t.label}</td><td>${t.hint}</td></tr>`);
    rows.push(
      '<tr><td><kbd>[ ]</kbd></td><td>Cycle option</td><td>texture / camp composition / decoration</td></tr>',
      '<tr><td><kbd>, .</kbd></td><td>Rotate</td><td>placement angle (doodad tools)</td></tr>',
      '<tr><td><kbd>- =</kbd></td><td>Size</td><td>doodad scale, or brush size for terrain tools</td></tr>',
      '<tr><td><kbd>Alt</kbd></td><td>Erase modifier</td><td>flag tools erase; doodad tools delete nearest</td></tr>',
      '<tr><td><kbd>O</kbd></td><td>Pathing overlay</td><td>toggle derived walkability</td></tr>',
      '<tr><td><kbd>Ctrl+S</kbd></td><td>Save</td><td>writes maps/*.map.json + *.amap</td></tr>',
      '<tr><td><kbd>Ctrl+Z / Ctrl+Shift+Z</kbd></td><td>Undo / redo</td><td></td></tr>',
      '<tr><td><kbd>WASD / arrows / MMB</kbd></td><td>Pan</td><td>mouse wheel zooms</td></tr>',
    );
    el.innerHTML = `<h2>Hotkeys</h2><table>${rows.join('')}</table><p>(click anywhere to close)</p>`;
    el.onclick = () => (el.style.display = 'none');
    el.style.display = 'none';
    return el;
  }
}
