/**
 * Durable Object: one instance = one match room.
 *
 * Uses the hibernation WebSocket API. The DO builds a SimWorld from compact
 * navdata on first instantiation, then runs a 30 Hz tick loop while players
 * are connected. All gameplay is authoritative — clients send commands, the
 * server simulates, and snapshots + events are broadcast back.
 */
import { DurableObject, WebSocket } from 'cloudflare:workers';
import { MatchState, HeroInput, HeroState, createMatchState, createHeroState } from '../src/sim/state';
import { stepMatch } from '../src/sim/stepMatch';
import { SimWorld, ObstacleAABB, Rect, Shop, findRespawnPosition } from '../src/sim/world';
import { SHOP_ITEMS } from '../src/sim/shopItems';
import { NavGrid } from '../src/navigation/NavGrid';
import { Pathfinder } from '../src/navigation/Pathfinder';
import { HERO } from '../src/sim/rules';
import {
  ClientMessage, ServerMessage, WelcomeMessage, SnapshotMessage,
  EventMessage, PeerJoinedMessage, PeerLeftMessage,
} from '../src/sim/protocol';

// ── Compact navdata (auto-generated) ─────────────────────────────────
import { NAVDATA } from './navdata';

// ── Env interface for the DO ─────────────────────────────────────────
export interface Env {
  GAME_ROOM: DurableObjectNamespace<typeof import('./GameRoom').GameRoom>;
}

// ── Per-socket attachment ────────────────────────────────────────────
interface PlayerInfo {
  playerId: string;
  name: string;
}

const TICK_RATE = 30;
const TICK_INTERVAL = 1000 / TICK_RATE;
const SNAPSHOT_EVERY = 2; // broadcast every Nth tick (15 Hz)
const MAX_PLAYERS = 8;

export class GameRoom extends DurableObject<Env> {
  private _world!: SimWorld;
  private _state!: MatchState;
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _pendingInputs: HeroInput[] = [];
  private _players = new Map<WebSocket, PlayerInfo>();
  /** playerId → WebSocket for targeted messages. */
  private _playerSockets = new Map<string, WebSocket>();
  private _nextPlayerId = 1;

  /**
   * Called once when the DO is first created or woken from hibernation.
   * Build the shared world from compact navdata.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this._buildWorld();
    this._state = createMatchState();
  }

  // ── HTTP / WebSocket upgrade ──────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade — GET /ws/:roomCode hits the DO directly via the
    // router proxy, so the path here is just "/".
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('GameRoom — use WebSocket', { status: 426 });
  }

  // ── WebSocket lifecycle (hibernation API) ─────────────────────────

  async webSocketMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed JSON
    }

    switch (msg.type) {
      case 'join': {
        if (this._players.size >= MAX_PLAYERS) {
          ws.close(1013, 'room full');
          return;
        }
        const playerId = `p${this._nextPlayerId++}`;
        const info: PlayerInfo = { playerId, name: msg.name };
        this._players.set(ws, info);
        this._playerSockets.set(playerId, ws);

        // Spawn hero on a random walkable position.
        const spawn = findRespawnPosition(this._world);
        const hero = createHeroState(playerId, this._players.size - 1, spawn);
        this._state.heroes.push(hero);

        // Start the tick loop if this is the first player.
        if (!this._tickTimer) this._startTick();

        // Send welcome with initial snapshot.
        const welcome: WelcomeMessage = {
          type: 'welcome',
          playerId,
          tickRate: TICK_RATE,
          snapshot: this._currentSnapshot(),
        };
        ws.send(JSON.stringify(welcome));

        // Notify others.
        const peerMsg: PeerJoinedMessage = { type: 'peerJoined', playerId, name: msg.name };
        this._broadcast(peerMsg, ws);
        break;
      }

      case 'input': {
        const info = this._players.get(ws);
        console.log('[GameRoom] input from', info?.playerId ?? 'unknown', 'cmd:', msg.cmd?.type);
        if (!info) return;
        this._pendingInputs.push({ heroId: info.playerId, cmd: msg.cmd });
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const info = this._players.get(ws);
    if (!info) return;

    this._players.delete(ws);
    this._playerSockets.delete(info.playerId);

    // Mark hero as dead / despawned (removed from state).
    this._state.heroes = this._state.heroes.filter((h) => h.id !== info.playerId);

    // Notify remaining players.
    const peerMsg: PeerLeftMessage = { type: 'peerLeft', playerId: info.playerId };
    this._broadcast(peerMsg);

    // Stop tick if room is empty.
    if (this._players.size === 0) this._stopTick();
  }

  async webSocketError(_ws: WebSocket, err: Error): Promise<void> {
    console.error('[GameRoom] ws error:', err.message);
  }

  // ── Tick loop ─────────────────────────────────────────────────────

  private _startTick(): void {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => this._tick(), TICK_INTERVAL);
  }

  private _stopTick(): void {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  private _tick(): void {
    // Drain pending inputs.
    const inputs = this._pendingInputs;
    this._pendingInputs = [];
    if (inputs.length > 0) {
      console.log('[GameRoom] tick', this._state.tick, 'processing', inputs.length, 'inputs');
    }

    // Step the simulation.
    const events = stepMatch(this._state, inputs, 1 / TICK_RATE, this._world);

    // Broadcast snapshot every 2nd tick.
    if (this._state.tick % SNAPSHOT_EVERY === 0) {
      const snapshot: SnapshotMessage = {
        type: 'snapshot',
        tick: this._state.tick,
        heroes: this._state.heroes,
        projectiles: this._state.projectiles,
        wards: this._state.wards,
      };
      this._broadcast(snapshot);
    }

    // Broadcast discrete events immediately.
    for (const ev of events) {
      const evMsg: EventMessage = { type: 'event', event: ev };
      this._broadcast(evMsg);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private _currentSnapshot() {
    return {
      tick: this._state.tick,
      heroes: this._state.heroes,
      projectiles: this._state.projectiles,
      wards: this._state.wards,
    };
  }

  private _broadcast(msg: ServerMessage, exclude?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const ws of this._players.keys()) {
      if (ws !== exclude) {
        try { ws.send(data); } catch { /* socket may be closing */ }
      }
    }
  }

  // ── World construction (compact navdata) ──────────────────────────

  private _buildWorld(): void {
    const ng = NAVDATA.navGrid;

    // Decode bit-packed walkable cells.
    const cellsBase64 = ng.cellsBase64;
    const bytes = Uint8Array.from(atob(cellsBase64), (c) => c.charCodeAt(0));
    const numCells = ng.width * ng.height;

    const navGrid = new NavGrid(ng.width, ng.height, ng.cellSize, ng.originX, ng.originZ);
    // Navdata stores cells south-to-north (WPM order); NavGrid stores north-to-south.
    for (let gz = 0; gz < ng.height; gz++) {
      const srcRow = ng.height - 1 - gz;
      for (let gx = 0; gx < ng.width; gx++) {
        const srcIdx = srcRow * ng.width + gx;
        const walkable = (bytes[srcIdx >> 3] >> (srcIdx & 7)) & 1;
        navGrid.setWalkable(gx, gz, walkable === 1);
      }
    }
    const pathfinder = new Pathfinder(navGrid);

    // Obstacles.
    const obstacles: ObstacleAABB[] = NAVDATA.obstacles.map((o) => ({ ...o }));

    // Arena.
    const arena: Rect = { ...NAVDATA.arenas.terrain1 };

    // Shop.
    const shop: Shop = {
      pos: { x: NAVDATA.shopPos.x, z: NAVDATA.shopPos.z },
      interactRadius: 120,
      items: SHOP_ITEMS,
    };

    this._world = { navGrid, pathfinder, obstacles, arena, shop };
  }
}
