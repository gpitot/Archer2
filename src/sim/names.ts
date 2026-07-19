/**
 * Display-name rules, shared by client and server.
 *
 * Lives here rather than next to the localStorage helpers because the server
 * needs it too: names arrive from untrusted clients and end up in every other
 * player's DOM and nameplate, so `join`/`setName` re-sanitize on arrival.
 */

export const MAX_NAME_LEN = 16;
export const DEFAULT_NAME = 'Player';

/** C0 controls + DEL — these render as nothing but break layout and logs. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Trim, strip control characters, collapse runs of whitespace, and clamp to
 * MAX_NAME_LEN. An empty result falls back to DEFAULT_NAME so no player is
 * ever nameless.
 */
export function sanitizeName(raw: string): string {
  const cleaned = (raw ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN);
  return cleaned.length > 0 ? cleaned : DEFAULT_NAME;
}
