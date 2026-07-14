/**
 * Hero portrait with circular XP bar — WC3-style bottom-left HUD element.
 *
 * Renders a circle showing the hero colour, a level number,
 * and a progress ring showing XP toward next level.
 */
export class HeroPortrait {
  readonly container: HTMLDivElement;
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;

  private _size = 88; // px diameter
  private _ringWidth = 6;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 24px;
      z-index: 200;
      pointer-events: none;
    `;

    this._canvas = document.createElement('canvas');
    this._canvas.width = this._size;
    this._canvas.height = this._size;
    this._canvas.style.display = 'block';
    this._ctx = this._canvas.getContext('2d')!;
    this.container.appendChild(this._canvas);

    document.body.appendChild(this.container);
  }

  /** Redraw the portrait. Call every frame. */
  update(xp: number, xpForNext: number, xpForCurrent: number, level: number, heroColor: string): void {
    const c = this._ctx;
    const s = this._size;
    const cx = s / 2;
    const cy = s / 2;
    const outerR = s / 2;
    const ringR = outerR - this._ringWidth / 2 - 2;
    const pr = ringR - this._ringWidth; // portrait radius

    c.clearRect(0, 0, s, s);

    // ── Outer metallic border ──
    const borderGrad = c.createLinearGradient(0, 0, s, s);
    borderGrad.addColorStop(0, '#665522');
    borderGrad.addColorStop(0.3, '#aa9944');
    borderGrad.addColorStop(0.5, '#887722');
    borderGrad.addColorStop(0.7, '#aa9944');
    borderGrad.addColorStop(1, '#553311');
    c.beginPath();
    c.arc(cx, cy, outerR - 1, 0, Math.PI * 2);
    c.strokeStyle = borderGrad;
    c.lineWidth = 3;
    c.stroke();

    // ── Dark gap ──
    c.beginPath();
    c.arc(cx, cy, ringR + this._ringWidth / 2, 0, Math.PI * 2);
    c.strokeStyle = '#111111';
    c.lineWidth = 2;
    c.stroke();

    // ── XP ring track (dark) ──
    c.beginPath();
    c.arc(cx, cy, ringR, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(30, 20, 5, 0.9)';
    c.lineWidth = this._ringWidth;
    c.stroke();

    // ── XP ring (progress, gold) ──
    const needed = xpForNext - xpForCurrent;
    const progress = needed > 0 ? (xp - xpForCurrent) / needed : 1;
    if (progress > 0) {
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + Math.PI * 2 * Math.min(progress, 1);
      c.beginPath();
      c.arc(cx, cy, ringR, startAngle, endAngle);
      c.strokeStyle = '#eebb44';
      c.lineWidth = this._ringWidth;
      c.stroke();
    }

    // ── Portrait disc ──
    c.beginPath();
    c.arc(cx, cy, pr, 0, Math.PI * 2);
    c.fillStyle = heroColor;
    c.fill();

    // ── Inner shadow rim ──
    c.beginPath();
    c.arc(cx, cy, pr, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    c.lineWidth = 2;
    c.stroke();

    // ── Level number ──
    c.fillStyle = '#ffffff';
    c.font = 'bold 28px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = 'rgba(0, 0, 0, 0.8)';
    c.shadowBlur = 4;
    c.fillText(String(level), cx, cy);
    c.shadowBlur = 0;
  }
}
