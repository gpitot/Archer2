/**
 * WebSocket client for the authenticating game server.
 *
 * Manages a connection to one GameRoom DO, sends sequenced inputs, and
 * buffers incoming snapshots + events for the game loop to consume each
 * frame. Designed to be ticked synchronously from the game update — no
 * internal timers or async callbacks beyond the raw WebSocket events.
 */
import { Command } from '../sim/state';
import {
  ClientMessage,
  ServerMessage,
  WelcomeMessage,
  SnapshotMessage,
  EventMessage,
} from '../sim/protocol';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export class NetworkClient {
  private _ws: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private _playerId: string | null = null;
  private _seq = 0;
  private _snapshots: SnapshotMessage[] = [];
  private _events: EventMessage[] = [];
  private _welcome: WelcomeMessage | null = null;
  private _pendingWelcome: ((w: WelcomeMessage) => void) | null = null;
  private _url: string = '';

  // ── Public API ────────────────────────────────────────────────────

  get state(): ConnectionState { return this._state; }
  get playerId(): string | null { return this._playerId; }
  get welcome(): WelcomeMessage | null { return this._welcome; }

  /** Connect to a room, send join, and wait for the welcome handshake. */
  connect(roomCode: string, name: string): Promise<WelcomeMessage> {
    this._url = `/ws/${roomCode}`;
    this._state = 'connecting';
    this._snapshots = [];
    this._events = [];
    this._seq = 0;

    return new Promise((resolve, reject) => {
      this._pendingWelcome = resolve;

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${location.host}${this._url}`;
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.onopen = () => {
        this._send({ type: 'join', name });
      };

      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        this._onMessage(msg);
      };

      ws.onerror = () => {
        if (this._pendingWelcome) {
          reject(new Error('WebSocket connection failed'));
          this._pendingWelcome = null;
        }
        this._state = 'disconnected';
      };

      ws.onclose = () => {
        this._state = 'disconnected';
        this._ws = null;
      };
    });
  }

  /** Send an input command with an auto-incrementing sequence number. */
  sendInput(cmd: Command): void {
    this._send({ type: 'input', seq: this._seq++, cmd });
  }

  /** True if the websocket is open and the welcome has been received. */
  get isReady(): boolean {
    return this._state === 'connected' && this._playerId !== null;
  }

  /** Drain and return all buffered snapshots (oldest first). */
  drainSnapshots(): SnapshotMessage[] {
    const snaps = this._snapshots;
    this._snapshots = [];
    return snaps;
  }

  /** Drain and return all buffered events (oldest first). */
  drainEvents(): EventMessage[] {
    const evts = this._events;
    this._events = [];
    return evts;
  }

  /** Return the most recent snapshot without draining. */
  get latestSnapshot(): SnapshotMessage | null {
    return this._snapshots.length > 0
      ? this._snapshots[this._snapshots.length - 1]
      : null;
  }

  disconnect(): void {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._state = 'disconnected';
    this._playerId = null;
  }

  // ── Internals ─────────────────────────────────────────────────────

  private _send(msg: ClientMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  private _onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this._playerId = msg.playerId;
        this._welcome = msg;
        this._state = 'connected';
        if (this._pendingWelcome) {
          this._pendingWelcome(msg);
          this._pendingWelcome = null;
        }
        break;

      case 'snapshot':
        this._snapshots.push(msg);
        break;

      case 'event':
        this._events.push(msg);
        break;

      // peerJoined / peerLeft are consumed via drainEvents if needed.
      default:
        break;
    }
  }
}
