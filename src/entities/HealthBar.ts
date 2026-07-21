import * as THREE from 'three';

/**
 * Billboard health bar rendered above a hero.
 * Uses a canvas texture on a Sprite so it always faces the camera.
 * When the hero owns a Null Barrier, a grey shield segment extends to the
 * right past the HP fill so enemies can see it too.
 */
export class HealthBar {
  readonly sprite: THREE.Sprite;

  private _canvas: HTMLCanvasElement;
  private _texture: THREE.CanvasTexture;
  private _width = 128;
  private _height = 16;

  private _maxHP = 0;
  private _currentHP = 0;
  private _shieldHp = 0;
  private _shieldMax = 0;

  constructor(maxHP: number) {
    this._maxHP = maxHP;
    this._currentHP = maxHP;

    this._canvas = document.createElement('canvas');
    this._canvas.width = this._width;
    this._canvas.height = this._height;

    this._texture = new THREE.CanvasTexture(this._canvas);
    this._texture.minFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: this._texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.sprite = new THREE.Sprite(material);
    this.sprite.scale.set(1.5, 0.2, 1);
    this.sprite.position.y = 2.2;

    this._draw();
  }

  /** Update HP and shield values. Repaints only when something changed. */
  setHP(current: number, max: number, shieldHp = 0, shieldMax = 0): void {
    if (
      current === this._currentHP &&
      max === this._maxHP &&
      shieldHp === this._shieldHp &&
      shieldMax === this._shieldMax
    )
      return;
    this._currentHP = current;
    this._maxHP = max;
    this._shieldHp = shieldHp;
    this._shieldMax = shieldMax;
    this._draw();
  }

  show(): void { this.sprite.visible = true; }
  hide(): void { this.sprite.visible = false; }

  private _draw(): void {
    const ctx = this._canvas.getContext('2d')!;
    const w = this._width;
    const h = this._height;

    ctx.clearRect(0, 0, w, h);

    const effectiveShield = this._shieldHp > 0 ? this._shieldHp : 0;
    const total = this._maxHP + effectiveShield;
    const barLeft = 1;
    const barWidth = w - 2;

    // Background (dark)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, h);

    // HP fill width — fraction of total capacity so the bar doesn't overflow
    // when shield is active.
    const hpWidth = total > 0 ? Math.max(0, (this._currentHP / total) * barWidth) : 0;

    if (this._shieldMax > 0) {
      // Grey shield segment extends past HP.  It fills from the end of HP
      // to (HP + shield) / total — the rightward "extra HP" segment.
      const shieldEnd = total > 0
        ? Math.max(0, ((this._currentHP + this._shieldHp) / total) * barWidth)
        : 0;
      const shieldWidth = Math.max(0, shieldEnd - hpWidth);

      if (shieldWidth > 0.5) {
        ctx.fillStyle = '#2a2727ff';
        ctx.fillRect(barLeft + hpWidth, 1, shieldWidth, h - 2);
        
      }
    }

    // HP fill behind the shield (z-order: HP first, then shield on top).
    if (hpWidth > 0) {
      const ratio = this._maxHP > 0 ? this._currentHP / this._maxHP : 0;
      if (ratio > 0.5) {
        ctx.fillStyle = '#44cc44';
      } else if (ratio > 0.25) {
        ctx.fillStyle = '#cccc44';
      } else {
        ctx.fillStyle = '#cc4444';
      }
      ctx.fillRect(barLeft, 1, hpWidth, h - 2);
    }

    // Segment dividers — thin dark line every 100 HP, scaled to total.
    if (total > 0) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      for (let mark = 100; mark < total; mark += 100) {
        const segX = Math.round(barLeft + (mark / total) * barWidth);
        ctx.fillRect(segX, 1, 2, h - 2);
      }
    }

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    this._texture.needsUpdate = true;
  }
}
