/**
 * Per-player colours, shared by the 3D views and the DOM UI (scoreboard,
 * lobby roster, minimap) so a player reads as the same colour everywhere.
 *
 * Keyed by team id. The server runs free-for-all and assigns the lowest free
 * team on join (GameRoom `join`), so in practice team id *is* the player slot,
 * 0..MAX_PLAYERS-1. If real teams ever land, teammates would share a colour —
 * which is the right default for a team game, but the roster would then need
 * another way to tell teammates apart.
 *
 * Hue choices avoid the colours the HUD already uses for non-player things:
 * gold (#ffcc44, shops), mint (#66ff88, wards), olive (#999966, camps).
 */

/** Eight visually distinct colours, one per player slot. */
const PLAYER_COLORS = [
  0x4da6ff, // blue
  0xff4d4d, // red
  0xb06cff, // violet
  0xff8c1a, // orange
  0x2ee0d0, // cyan
  0xff6bd6, // pink
  0xa6e22e, // lime
  0xe8e8e8, // silver
] as const;

export const PLAYER_COLOR_COUNT = PLAYER_COLORS.length;

/** Player colour as a Three.js hex number. Wraps if team exceeds the palette. */
export function playerColor(team: number): number {
  const i = ((team % PLAYER_COLOR_COUNT) + PLAYER_COLOR_COUNT) % PLAYER_COLOR_COUNT;
  return PLAYER_COLORS[i];
}

/** Same colour as a CSS string, for DOM UI and canvas. */
export function playerColorCss(team: number): string {
  return `#${playerColor(team).toString(16).padStart(6, '0')}`;
}
