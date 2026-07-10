import * as THREE from 'three';

/**
 * Billboard health bar rendered above a hero.
 * Uses a canvas texture on a Sprite so it always faces the camera.
 */
export class HealthBar {
  readonly sprite: THREE.Sprite;

  private _canvas: HTMLCanvasElement;
  private _texture: THREE.CanvasTexture;
  private _width = 64;
  private _height = 8;

  private _maxHP: number;
  private _currentHP: number;

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

  /** Update the displayed HP value. */
  setHP(current: number, max: number): void {
    this._currentHP = current;
    this._maxHP = max;
    this._draw();
  }

  show(): void { this.sprite.visible = true; }
  hide(): void { this.sprite.visible = false; }

  private _draw(): void {
    const ctx = this._canvas.getContext('2d')!;
    const w = this._width;
    const h = this._height;

    ctx.clearRect(0, 0, w, h);

    // Background (dark)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, h);

    // HP fill
    const ratio = Math.max(0, this._currentHP / this._maxHP);
    const fillWidth = Math.max(0, (w - 2) * ratio);

    if (ratio > 0.5) {
      ctx.fillStyle = '#44cc44'; // green
    } else if (ratio > 0.25) {
      ctx.fillStyle = '#cccc44'; // yellow
    } else {
      ctx.fillStyle = '#cc4444'; // red
    }

    ctx.fillRect(1, 1, fillWidth, h - 2);

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    this._texture.needsUpdate = true;
  }
}
