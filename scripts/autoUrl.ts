/**
 * The game normally opens on a start screen and a lobby, which a headless
 * harness has no way to click through. `?auto=1` tells `main.ts` to take the
 * straight-to-game path instead (join, ready, start, play).
 */
export function withAuto(url: string): string {
  if (/[?&]auto=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'auto=1';
}
