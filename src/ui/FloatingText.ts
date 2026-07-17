import * as THREE from 'three';

/**
 * Floating damage numbers that appear briefly above heroes.
 * Uses DOM overlays positioned via world→screen projection.
 */
export class FloatingText {
  private _el: HTMLDivElement;
  private _coin?: HTMLSpanElement;

  constructor(worldPos: THREE.Vector3, text: string, color = '#ff4444', private _crit = false, coin = false) {
    this._el = document.createElement('div');
    this._el.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 500;
      font-family: sans-serif;
      font-size: 16px;
      font-weight: bold;
      color: ${color};
      text-shadow: 0 0 4px rgba(0,0,0,0.7), 0 2px 4px rgba(0,0,0,0.5);
      white-space: nowrap;
      transition: none;
      display: flex;
      align-items: center;
      gap: 4px;
    `;

    if (coin) {
      // LoL-style gold coin: a small radial-gradient disc with a darker rim.
      this._coin = document.createElement('span');
      this._coin.style.cssText = `
        display: inline-block;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: radial-gradient(circle at 35% 30%, #ffe98a 0%, #ffd747 45%, #d99a1b 80%, #a86f0e 100%);
        border: 1.5px solid #8a5a08;
        box-shadow: 0 0 4px rgba(255, 200, 60, 0.8), inset 0 0 2px rgba(255, 255, 255, 0.6);
        flex: none;
      `;
      this._el.appendChild(this._coin);
    }

    const label = document.createElement('span');
    label.textContent = text;
    this._el.appendChild(label);

    document.body.appendChild(this._el);

    this._updatePosition(worldPos, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  /** Update screen position from world coordinates. */
  update(worldPos: THREE.Vector3, camera: THREE.Camera, alpha: number): void {
    const vec = worldPos.clone();
    vec.y += 2; // float above head
    vec.project(camera);
    const sx = (vec.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-vec.y * 0.5 + 0.5) * window.innerHeight;

    this._el.style.left = `${sx}px`;
    this._el.style.top = `${sy - 20 * (1 - alpha)}px`;
    this._el.style.opacity = String(Math.max(0, alpha));
    const base = this._crit ? 18 : 14;
    const grow = this._crit ? 8 : 4;
    const size = base + grow * alpha;
    this._el.style.fontSize = `${size}px`;
    if (this._coin) {
      const coinSize = size * 0.85;
      this._coin.style.width = `${coinSize}px`;
      this._coin.style.height = `${coinSize}px`;
    }
  }

  _updatePosition(worldPos: THREE.Vector3, center: { x: number; y: number }): void {
    this._el.style.left = `${center.x}px`;
    this._el.style.top = `${center.y}px`;
  }

  destroy(): void {
    this._el.remove();
  }
}

/**
 * Pooled manager for floating texts.
 */
export class FloatingTextManager {
  private _texts: { ft: FloatingText; worldPos: THREE.Vector3; elapsed: number; duration: number }[] = [];

  /**
   * Spawn a damage number at world position. Lives for ~1 second.
   * Crits render larger, gold, and with an exclamation mark.
   */
  spawn(worldPos: THREE.Vector3, amount: number, color?: string, crit = false): void {
    const text = crit ? `${Math.round(amount)}!` : String(Math.round(amount));
    const ft = new FloatingText(worldPos, text, crit ? '#ffb020' : color, crit);
    this._texts.push({ ft, worldPos: worldPos.clone(), elapsed: 0, duration: crit ? 1.3 : 1.0 });
  }

  /**
   * Spawn a LoL-style gold gain indicator: coin icon + "+N" in gold.
   */
  spawnGold(worldPos: THREE.Vector3, amount: number): void {
    const ft = new FloatingText(worldPos, `+${Math.round(amount)}`, '#ffd747', false, true);
    this._texts.push({ ft, worldPos: worldPos.clone(), elapsed: 0, duration: 1.3 });
  }
  
  /** Spawn an arbitrary text banner (rune pickups etc.). Lives ~1.5 s. */
  spawnText(worldPos: THREE.Vector3, text: string, color = '#ffffff'): void {
    const ft = new FloatingText(worldPos, text, color, true);
    this._texts.push({ ft, worldPos: worldPos.clone(), elapsed: 0, duration: 1.5 });
  }

  update(delta: number, camera: THREE.Camera): void {
    for (let i = this._texts.length - 1; i >= 0; i--) {
      const t = this._texts[i];
      t.elapsed += delta;
      const alpha = 1 - t.elapsed / t.duration;
      if (alpha <= 0) {
        t.ft.destroy();
        this._texts.splice(i, 1);
      } else {
        t.ft.update(t.worldPos, camera, alpha);
      }
    }
  }

  clear(): void {
    for (const t of this._texts) t.ft.destroy();
    this._texts.length = 0;
  }
}
