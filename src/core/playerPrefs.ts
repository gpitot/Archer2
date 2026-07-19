/**
 * Client-side player preferences, persisted in localStorage.
 *
 * Only the display name lives here for now. The name *rules* live in
 * `src/sim/names.ts` because the server applies them too, and the server
 * program has no DOM — this module is the browser-only storage half, and
 * re-exports the rules for convenience.
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
