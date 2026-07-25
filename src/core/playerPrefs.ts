/**
 * Client-side player preferences, persisted in localStorage.
 *
 * The display name and the graphics-quality tier live here. The name *rules*
 * live in `src/sim/names.ts` because the server applies them too, and the
 * server program has no DOM — this module is the browser-only storage half,
 * and re-exports the rules for convenience.
 */
import { sanitizeName } from '../sim/names';

export { sanitizeName, MAX_NAME_LEN, DEFAULT_NAME } from '../sim/names';

const NAME_KEY = 'archer-player-name';

export function loadPlayerName(): string | null {
  try {
    const stored = localStorage.getItem(NAME_KEY);
    return stored ? sanitizeName(stored) : null;
  } catch {
    return null; // private mode etc.
  }
}

export function savePlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, sanitizeName(name));
  } catch { /* private mode etc. */ }
}

// ── Generic string prefs ────────────────────────────────────────────────

/** Read a raw string pref, or null when absent/unreadable (private mode). */
export function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode etc.
  }
}

/** Write a raw string pref; silently a no-op when storage is unavailable. */
export function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* private mode etc. */ }
}
