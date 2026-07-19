/**
 * Startup flow: start screen → lobby → match.
 *
 * The lobby doubles as the loading screen. `Game.preload()` is kicked off as
 * soon as the lobby is on screen and runs while players wait for each other,
 * so the slow terrain build overlaps with the part of startup that was always
 * going to involve waiting.
 */
import { Game } from './core/Game';
import { NetworkClient } from './net/NetworkClient';
import { loadPlayerName, savePlayerName } from './core/playerPrefs';
import { generateRoomCode, normalizeRoomCode } from './core/roomCode';
import { StartScreen } from './ui/StartScreen';
import { LobbyScreen } from './ui/LobbyScreen';

/** Let the browser paint before we hand it a long synchronous task. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Put the room code in the URL so the tab can be shared and reloaded. */
function setRoomInUrl(code: string | null): void {
  const params = new URLSearchParams(location.search);
  if (code) params.set('room', code);
  else params.delete('room');
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const game = new Game();

  // Automated harnesses drive the page directly and can't click through a
  // lobby — `?auto=1` keeps the old straight-to-game behaviour.
  if (params.has('auto')) {
    await game.init();
    return;
  }

  // ── Start screen ──
  const urlRoom = normalizeRoomCode(params.get('room') ?? '') || null;
  const choice = await new StartScreen({ prefill: loadPlayerName(), room: urlRoom }).show();
  savePlayerName(choice.name);

  const online = choice.mode !== 'offline';
  const roomCode = choice.mode === 'create'
    ? generateRoomCode()
    : choice.mode === 'join'
      ? (choice.roomCode ?? urlRoom!)
      : null;
  setRoomInUrl(roomCode);

  // ── Lobby (also the loading screen) ──
  const net = online ? new NetworkClient() : null;
  const lobby = new LobbyScreen({
    room: roomCode,
    // Nobody to wait for offline, so readying up is just an extra click.
    showReady: online,
    cb: {
      onToggleReady: (ready) => net?.setReady(ready),
      onStart: () => net?.startGame(),
      onLeave: () => { net?.disconnect(); location.reload(); },
    },
  });
  lobby.open();

  // Paint the lobby before preload blocks the main thread building terrain.
  await nextPaint();
  const preloading = game.preload().then(() => lobby.setLocalLoaded(true));

  // Register the start listener up front, so a Start pressed while we're
  // still setting up isn't missed.
  const started = net ? net.waitForMatchStart() : lobby.waitForLocalStart();

  let names = new Map<string, string>();

  if (net) {
    net.onClosed = (_code, reason) => {
      lobby.setStatus(reason ? `Disconnected: ${reason}` : 'Disconnected from the server.');
    };
    const welcome = await net.connect(roomCode!, choice.name, game.mapName);
    names = new Map(welcome.roster.map((p) => [p.playerId, p.name]));
    lobby.setRoster(welcome.roster, welcome.playerId);
    net.onRoster = (players) => {
      names = new Map(players.map((p) => [p.playerId, p.name]));
      lobby.setRoster(players, net.playerId);
    };
    // A match already in progress skips the lobby entirely.
    if (welcome.phase === 'playing') lobby.setStatus('Joining match in progress…');
  } else {
    // Offline: a one-row roster that's ready as soon as the map is loaded.
    lobby.setRoster([{ playerId: 'player', name: choice.name, ready: true, team: 0 }], 'player');
  }

  // ── Wait for the match, then hand over ──
  const init = await started;
  await preloading;
  lobby.close();
  lobby.dispose();

  if (net && init) game.startNetworkMatch(net, init, names);
  else game.startOfflineMatch(choice.name);

  game.finish();
}

boot().catch((err) => {
  console.error('failed to start game:', err);
  const el = document.createElement('pre');
  el.style.cssText = 'color:#f66;padding:16px;font-size:14px;position:fixed;top:0;left:0;z-index:600;';
  el.textContent = `Failed to start: ${err?.message ?? err}`;
  document.body.appendChild(el);
});
