/**
 * Tracks elapsed time between frames and total elapsed time.
 */
export class Clock {
  private _elapsed = 0;
  private _delta = 0;
  private _lastTime = 0;
  private _started = false;

  get elapsed(): number {
    return this._elapsed;
  }

  get delta(): number {
    return this._delta;
  }

  start(currentTime: number): void {
    if (!this._started) {
      this._lastTime = currentTime;
      this._started = true;
    }
  }

  tick(currentTime: number): void {
    if (!this._started) return;
    this._delta = (currentTime - this._lastTime) / 1000;
    this._elapsed += this._delta;
    this._lastTime = currentTime;
  }
}
