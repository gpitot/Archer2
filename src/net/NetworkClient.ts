/**
 * WebSocket client for the authenticating game server.
 *
 * Manages a connection to one GameRoom DO, sends sequenced inputs, and
 * buffers incoming snapshots + events for the game loop to consume each
 * frame. Designed to be ticked synchronously from the game update — no
 * internal timers or async callbacks beyond the raw WebSocket events.
 */
import { Command, SimEvent } from '../sim/state';
import {
  ClientMessage,
  ServerMessage,
  WelcomeMessage,
  SnapshotMessage,
  HeroMeta,
  LobbyPlayer,
  MatchInit,
  RoomPhase,
} from '../sim/protocol';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export class NetworkClient {
  private _ws: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private _playerId: string | null = null;
  private _seq = 0;
  private _snapshots: SnapshotMessage[] = [];
  private _events: SimEvent[] = [];
  /** Latest cold hero fields, merged per hero: each entry is absolute state,
   *  but a message may carry only the heroes that changed. */
  private _pendingMeta: HeroMeta[] | null = null;
  private _welcome: WelcomeMessage | null = null;
  private _pendingWelcome: ((w: WelcomeMessage) => void) | null = null;
  private _url: string = '';
  private _phase: RoomPhase = 'lobby';
  private _roster: LobbyPlayer[] = [];
  private _matchInit: MatchInit | null = null;
  private _pendingMatchStart: ((init: MatchInit) => void) | null = null;

  /** Fired whenever the room roster or phase changes (both phases). */
  onRoster: ((players: LobbyPlayer[], phase: RoomPhase) => void) | null = null;
  /**
   * Fired when the socket closes. The server rejects with close codes that
   * carry a human-readable reason ("room full", "room is on map 'x'"), which
   * the lobby surfaces instead of hanging.
   */
  onClosed: ((code: number, reason: string) => void) | null = null;

  // ── Public API ────────────────────────────────────────────────────

  get state(): ConnectionState { return this._state; }
  get playerId(): string | null { return this._playerId; }
  get welcome(): WelcomeMessage | null { return this._welcome; }
  get phase(): RoomPhase { return this._phase; }
  get roster(): readonly LobbyPlayer[] { return this._roster; }

  /** Display name for a player id, falling back to the raw id. */
  nameOf(playerId: string): string {
    return this._roster.find((p) => p.playerId === playerId)?.name ?? playerId;
  }

  /**
   * Connect to a room, send join, and wait for the welcome handshake. The
   * welcome tells you which phase you landed in: a lobby (wait for
   * `waitForMatchStart`) or a match already in progress (`welcome.init` is
   * populated and `waitForMatchStart` resolves immediately).
   */
  connect(roomCode: string, name: string, map?: string): Promise<WelcomeMessage> {
    this._url = `/ws/${roomCode}`;
    this._state = 'connecting';
    this._snapshots = [];
    this._events = [];
    this._pendingMeta = null;
    this._matchInit = null;
    this._roster = [];
    this._phase = 'lobby';
    this._seq = 0;

    return new Promise((resolve, reject) => {
      this._pendingWelcome = resolve;

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${location.host}${this._url}`;
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.onopen = () => {
        this._send({ type: 'join', name, map });
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

      ws.onclose = (ev) => {
        this._state = 'disconnected';
        this._ws = null;
        if (this._pendingWelcome) {
          reject(new Error(ev.reason || 'connection closed before welcome'));
          this._pendingWelcome = null;
        }
        this.onClosed?.(ev.code, ev.reason);
      };
    });
  }

  /** Send an input command with an auto-incrementing sequence number. */
  sendInput(cmd: Command): void {
    this._send({ type: 'input', seq: this._seq++, cmd });
  }

  // ── Lobby ─────────────────────────────────────────────────────────

  setName(name: string): void { this._send({ type: 'setName', name }); }

  setReady(ready: boolean): void { this._send({ type: 'setReady', ready }); }

  /** Ask the server to start. Ignored unless every player is ready. */
  startGame(): void { this._send({ type: 'startGame' }); }

  /**
   * Resolve once the match state is available — immediately if the welcome
   * already carried it (joined a match in progress), otherwise when
   * `matchStart` arrives.
   */
  waitForMatchStart(): Promise<MatchInit> {
    if (this._matchInit) return Promise.resolve(this._matchInit);
    return new Promise((resolve) => { this._pendingMatchStart = resolve; });
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

  /** Drain and return all buffered sim events (oldest first). */
  drainEvents(): SimEvent[] {
    const evts = this._events;
    this._events = [];
    return evts;
  }

  /** Take the latest cold hero fields, or null if none arrived since last take. */
  takeMeta(): HeroMeta[] | null {
    const meta = this._pendingMeta;
    this._pendingMeta = null;
    return meta;
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
        this._phase = msg.phase;
        this._roster = msg.roster ?? [];
        // Present only when we joined a match already in progress.
        if (msg.init) this._matchInit = msg.init;
        if (this._pendingWelcome) {
          this._pendingWelcome(msg);
          this._pendingWelcome = null;
        }
        break;

      case 'roster':
        this._roster = msg.players;
        this._phase = msg.phase;
        this.onRoster?.(this._roster, this._phase);
        break;

      case 'matchStart':
        this._matchInit = msg.init;
        this._phase = 'playing';
        if (this._pendingMatchStart) {
          this._pendingMatchStart(msg.init);
          this._pendingMatchStart = null;
        }
        break;

      case 'snapshot':
        this._snapshots.push(msg);
        if (msg.events) this._events.push(...msg.events);
        break;

      case 'heroMeta':
        // Merge per hero — messages may carry only changed heroes, and a
        // later message's entry supersedes an earlier one's.
        if (!this._pendingMeta) {
          this._pendingMeta = [...msg.heroes];
        } else {
          for (const h of msg.heroes) {
            const i = this._pendingMeta.findIndex((m) => m.id === h.id);
            if (i >= 0) this._pendingMeta[i] = h;
            else this._pendingMeta.push(h);
          }
        }
        break;

      default:
        break;
    }
  }
}
