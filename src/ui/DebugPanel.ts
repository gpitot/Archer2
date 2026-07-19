/**
 * Debug panel — only shown in local/dev mode.
 * Buttons for toggling fog, levelling up, adding gold, and swapping maps.
 */
export class DebugPanel {
  readonly el: HTMLDivElement;

  private _btnFog: HTMLButtonElement;
  private _btnLevel: HTMLButtonElement;
  private _btnGold: HTMLButtonElement;
  private _btnMap: HTMLButtonElement;
  private _btnAI: HTMLButtonElement;

  constructor(
    private _onFogToggle: () => void,
    private _onLevelUp: () => void,
    private _onAddGold: () => void,
    otherMapName: string,
    private _onSwapMap: () => void,
    private _onToggleAI: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 600;
      display: flex;
      flex-direction: column;
      gap: 6px;
      pointer-events: auto;
      font-family: sans-serif;
    `;

    this._btnFog = this._makeButton('Toggle Fog', () => this._onFogToggle());
    this._btnLevel = this._makeButton('Level Up', () => this._onLevelUp());
    this._btnGold = this._makeButton('+100 Gold', () => this._onAddGold());
    this._btnMap = this._makeButton(`Map: ${otherMapName}`, () => this._onSwapMap());
    this._btnAI = this._makeButton('AI: OFF', () => this._onToggleAI());

    this.el.appendChild(this._btnFog);
    this.el.appendChild(this._btnLevel);
    this.el.appendChild(this._btnGold);
    this.el.appendChild(this._btnMap);
    this.el.appendChild(this._btnAI);

    document.body.appendChild(this.el);
  }

  /** Update the fog button label to reflect current state. */
  setFogLabel(enabled: boolean): void {
    this._btnFog.textContent = enabled ? 'Fog: ON' : 'Fog: OFF';
    this._btnFog.style.background = enabled
      ? 'rgba(30,30,30,0.85)'
      : 'rgba(20,50,20,0.85)';
  }

  /** Update the AI button label to reflect current state. */
  setAILabel(enabled: boolean): void {
    this._btnAI.textContent = enabled ? 'AI: ON' : 'AI: OFF';
    this._btnAI.style.background = enabled
      ? 'rgba(30,30,30,0.85)'
      : 'rgba(50,20,20,0.85)';
  }

  destroy(): void {
    this.el.remove();
  }

  private _makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      background: rgba(30,30,30,0.85);
      color: #ccc;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 4px;
      padding: 6px 14px;
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.1s;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(60,60,60,0.85)';
      btn.style.color = '#fff';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(30,30,30,0.85)';
      btn.style.color = '#ccc';
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't send a move-to command on the canvas
      onClick();
    });
    return btn;
  }
}
