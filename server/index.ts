/**
 * Worker entry point — routes WebSocket upgrades to the GameRoom DO and
 * serves static assets for everything else.
 */
// `DurableObjectNamespace`, `Request`, and `Response` are Worker runtime
// globals (see server/worker-configuration.d.ts) — not module exports.
import type { GameRoom as GameRoomClass } from './GameRoom';

// Re-export the DO class so Wrangler can bind it.
export { GameRoom } from './GameRoom';

interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoomClass>;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade to a room: /ws/ABCD
    const match = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/);
    if (match) {
      const roomCode = match[1].toUpperCase();
      const doId = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(doId);
      return stub.fetch(request);
    }

    // Everything else → static assets (Workers Assets).
    return env.ASSETS.fetch(request);
  },
};
