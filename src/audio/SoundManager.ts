/**
 * Web Audio API – based sound manager for gameplay announcements
 * (First Blood, kill streaks, multi-kills).
 *
 * Every sound is pre-decoded at init so playback is instant and gapless.
 * Multiple sounds can overlap (e.g., a multi-kill finishing during a
 * streak announcement).
 */

/** Maps logical sound names to their MP3 filenames under /sounds/. */
const SOUND_FILES: Record<string, string> = {
  firstBlood:     'FirstBlood.mp3',
  doubleKill:     'DoubleKill.mp3',
  tripleKill:     'TripleKill.mp3',
  killingSpree:   'KillingSpree.mp3',
  monsterKill:    'MonsterKill.mp3',
  megaKill:       'MegaKill.mp3',
  dominating:     'Dominating.mp3',
  unstoppable:    'Unstoppable.mp3',
  godLike:        'GodLike.mp3',
  whickedSick:    'WhickedSick.mp3',
};

export type SoundName = keyof typeof SOUND_FILES;

/** Kill-streak sound to play for each streak length (index = streak count). */
export const STREAK_SOUNDS: (SoundName | null)[] = [
  null,           // 0
  null,           // 1
  null,           // 2
  'killingSpree', // 3
  'dominating',   // 4
  'megaKill',     // 5
  'unstoppable',  // 6
  'whickedSick',  // 7
  'monsterKill',  // 8
  'godLike',      // 9
];

/** Multi-kill sound to play (index = consecutive kills in the window). */
export const MULTI_KILL_SOUNDS: (SoundName | null)[] = [
  null,          // 0
  null,          // 1
  'doubleKill',  // 2
  'tripleKill',  // 3
];

export class SoundManager {
  private _ctx: AudioContext | null = null;
  private _buffers = new Map<SoundName, AudioBuffer>();
  private _ready = false;
  private _muted = false;
  private _volume = 0.7;

  /** Must be called from a user-gesture callback (click, keydown) to unlock. */
  async init(): Promise<void> {
    if (this._ready) return;
    try {
      this._ctx = new AudioContext();
    } catch {
      console.warn('[SoundManager] Web Audio API not available');
      return;
    }

    const entries = Object.entries(SOUND_FILES) as [SoundName, string][];
    const results = await Promise.allSettled(
      entries.map(async ([name, file]) => {
        const resp = await fetch(`/sounds/${file}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const audio = await this._ctx!.decodeAudioData(buf);
        this._buffers.set(name, audio);
      }),
    );

    const failed = results
      .map((r, i) => (r.status === 'rejected' ? `${entries[i][0]} — ${r.reason}` : null))
      .filter((m): m is string => m !== null);
    if (failed.length > 0) {
      console.warn('[SoundManager] failed to load some sounds:', failed);
    }

    this._ready = true;
    console.log(`[SoundManager] ready — ${this._buffers.size}/${entries.length} sounds loaded`);
  }

  /** Play a named sound. No-op while muted or before init. */
  play(name: SoundName): void {
    if (this._muted || !this._ctx || !this._ready) return;
    const buf = this._buffers.get(name);
    if (!buf) return;

    // Resume the context if it's suspended (autoplay policy).
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }

    const src = this._ctx.createBufferSource();
    src.buffer = buf;

    const gain = this._ctx.createGain();
    gain.gain.value = this._volume;
    src.connect(gain).connect(this._ctx.destination);
    src.start(0);
  }

  get muted(): boolean { return this._muted; }
  set muted(v: boolean) { this._muted = v; }

  get volume(): number { return this._volume; }
  set volume(v: number) { this._volume = Math.max(0, Math.min(1, v)); }

  /** Clean up — call on page unload if needed. */
  dispose(): void {
    this._buffers.clear();
    this._ctx?.close();
    this._ctx = null;
    this._ready = false;
  }
}
