/**
 * Durable Object: one instance = one match room.
 *
 * Uses the hibernation WebSocket API. The DO builds a SimWorld from compact
 * navdata on first instantiation, then runs a 60 Hz tick loop while players
 * are connected. All gameplay is authoritative — clients send commands, the
 * server simulates, and snapshots + events are broadcast back.
 *
 * The sim ticks at 60 Hz; every SNAPSHOT_EVERY-th tick broadcasts a quantized
 * "hot" snapshot (positions, hp, flags, projectiles, wards) with the events
 * accumulated since the previous snapshot piggybacked. The "cold" hero fields
 * (economy, progression, inventory) go out as a separate `heroMeta` message
 * at a low rate, and immediately when an event changes them.
 */
// `WebSocket`, `WebSocketPair`, `Request`, and `Response` are Worker runtime
// globals (see server/worker-configuration.d.ts) — only DurableObject is a
// module export.
import { DurableObject } from 'cloudflare:workers';
import { MatchState, HeroInput, HeroState, SimEvent, ProjectileState, WardState, BlastState, AbilityRuntime, createMatchState, createHeroState } from '../src/sim/state';
import { ABILITY_ORDER, AbilityId } from '../src/sim/abilities';
import { stepMatch } from '../src/sim/stepMatch';
import { spawnCamps } from '../src/sim/stepCreeps';
import { spawnRunes } from '../src/sim/stepRunes';
import { CREEP } from '../src/sim/creepRules';
import { SimWorld, ObstacleAABB, Rect, Shop, FountainDef, findRespawnPosition, findWalkableNear, findWalkableNearOnGrid } from '../src/sim/world';
import { SHOP_ITEMS } from '../src/sim/shopItems';
import { NavGrid } from '../src/navigation/NavGrid';
import { Pathfinder } from '../src/navigation/Pathfinder';
import { HERO } from '../src/sim/rules';
import {
  ClientMessage, ServerMessage, WelcomeMessage, SnapshotMessage,
  HeroMetaMessage, SnapshotHero, HeroMeta, SnapshotCreep, CreepMeta, RuneMeta, Snapshot,
  RosterMessage, MatchStartMessage, MatchInit, LobbyPlayer, RoomPhase,
} from '../src/sim/protocol';
import { sanitizeName } from '../src/sim/names';

// ── Compact navdata (auto-generated) ─────────────────────────────────
import { NAVDATA, NavdataMap, NavdataMapName } from './navdata';

// ── Env interface for the DO ─────────────────────────────────────────
// The namespace is parameterised by the DO's *instance* type, not the class
// constructor — that's what carries the stub's RPC surface.
export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
}

// ── Per-socket attachment ────────────────────────────────────────────
// Mirrored into `ws.serializeAttachment` on every mutation so the room can
// rebuild `_players` if the DO is evicted while a lobby sits idle.
interface PlayerInfo {
  playerId: string;
  name: string;
  ready: boolean;
  team: number;
}

const TICK_RATE = 60;
const TICK_INTERVAL = 1000 / TICK_RATE;
// The sim steps at TICK_RATE but snapshots go out every Nth tick (20 Hz):
// clients interpolate between snapshots anyway, and 60 Hz broadcasts cost 3×
// the bandwidth for no visible gain. Events from skipped ticks accumulate and
// ride the next snapshot.
const SNAPSHOT_EVERY = 3;
const SNAPSHOT_RATE = TICK_RATE / SNAPSHOT_EVERY;
const META_EVERY = 15; // cold hero fields every Nth tick (4 Hz)
const MAX_PLAYERS = 8;
// A lobby has no tick loop, so nothing would keep the DO resident and an idle
// lobby could be hibernated out from under its players. This timer is the
// cheapest way to pin the room for as long as someone is waiting in it.
const LOBBY_KEEPALIVE_MS = 1000;

/** Events whose effects live in the cold fields — flush meta immediately. */
const META_EVENTS = new Set(['kill', 'respawn', 'purchase', 'levelUp', 'creepKill', 'runePickup']);

// Quantize floats before JSON serialization: raw doubles stringify to 15+
// chars each; 2 decimals is far below any visible threshold at world scale.
const q = (n: number) => Math.round(n * 100) / 100;
// Unit vectors need more precision (2dp ≈ 0.6° of heading error).
const q4 = (n: number) => Math.round(n * 10000) / 10000;

export class GameRoom extends DurableObject<Env> {
  private _world!: SimWorld;
  private _mapName: NavdataMapName = 'arena';
  private _state!: MatchState;
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _pendingInputs: HeroInput[] = [];
  /** Events from ticks since the last snapshot broadcast. */
  private _pendingEvents: SimEvent[] = [];
  private _players = new Map<WebSocket, PlayerInfo>();
  /** playerId → WebSocket for targeted messages. */
  private _playerSockets = new Map<string, WebSocket>();
  /** Last-broadcast serialized meta per hero, so scheduled sends can skip
   *  heroes whose cold fields haven't changed. */
  private _lastMetaJson = new Map<string, string>();
  private _nextPlayerId = 1;
  /**
   * Rooms open in a lobby and flip to 'playing' when someone starts the match.
   * Deliberately in-memory only: `_state` can't survive hibernation either, so
   * a persisted 'playing' would be a lie. A woken room returns to its lobby.
   */
  private _phase: RoomPhase = 'lobby';
  private _lobbyTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Called once when the DO is first created or woken from hibernation.
   * Build the shared world from compact navdata.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this._buildWorld('arena');
    this._resetMatch();
  }

  /** Fresh match state for the current world — including creep camps and runes. */
  private _resetMatch(): void {
    this._state = createMatchState();
    spawnCamps(this._state, this._world, NAVDATA[this._mapName].camps);
    spawnRunes(this._state, this._world, NAVDATA[this._mapName].runes);
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
    this._rehydrate();

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed JSON
    }

    switch (msg.type) {
      case 'join': {
        if (this._players.has(ws)) return; // duplicate join on one socket
        if (this._players.size >= MAX_PLAYERS) {
          ws.close(1013, 'room full');
          return;
        }
        // The first joiner picks the room's map; later joiners must match.
        // Any map baked into navdata is joinable ('arena', 'test', customs).
        const requestedMap: NavdataMapName =
          msg.map && msg.map in NAVDATA ? (msg.map as NavdataMapName) : 'arena';
        if (this._phase === 'lobby' && this._players.size === 0) {
          if (requestedMap !== this._mapName) {
            this._buildWorld(requestedMap);
            this._resetMatch();
          }
        } else if (requestedMap !== this._mapName) {
          ws.close(1013, `room is on map '${this._mapName}'`);
          return;
        }

        // Assign the lowest free team id (FFA = one team per player) so a
        // leave-then-join never hands a newcomer a team that's still in use.
        // Read it off `_players`, not `_state.heroes` — in a lobby no heroes
        // exist yet.
        const used = new Set([...this._players.values()].map((p) => p.team));
        let team = 0;
        while (used.has(team)) team++;

        const playerId = `p${this._nextPlayerId++}`;
        const info: PlayerInfo = {
          playerId,
          // Names are untrusted input that lands in other players' DOM.
          name: sanitizeName(msg.name),
          // Someone dropping into a running match is implicitly "ready", so
          // the roster reads sanely and a later lobby isn't blocked by them.
          ready: this._phase === 'playing',
          team,
        };
        this._setPlayer(ws, info);

        if (this._phase === 'lobby') {
          // No hero and no tick loop until the match actually starts — just
          // park them in the lobby and keep the room resident.
          this._startLobbyKeepalive();
          const welcome: WelcomeMessage = {
            type: 'welcome',
            playerId,
            tickRate: TICK_RATE,
            snapshotRate: SNAPSHOT_RATE,
            map: this._mapName,
            phase: 'lobby',
            roster: this._roster(),
          };
          ws.send(JSON.stringify(welcome));
          this._broadcastRoster();
          break;
        }

        // Match in progress — spawn straight in, skipping the lobby.
        this._state.heroes.push(createHeroState(playerId, team, this._spawnPosFor(team)));
        if (!this._tickTimer) this._startTick();

        const welcome: WelcomeMessage = {
          type: 'welcome',
          playerId,
          tickRate: TICK_RATE,
          snapshotRate: SNAPSHOT_RATE,
          map: this._mapName,
          phase: 'playing',
          roster: this._roster(),
          init: this._matchInit(),
        };
        ws.send(JSON.stringify(welcome));

        // Notify others, and flush cold fields so everyone has the new
        // hero's meta without waiting for the next scheduled heroMeta.
        this._broadcastRoster(ws);
        this._broadcastHeroMeta(false, ws);
        break;
      }

      case 'input': {
        const info = this._players.get(ws);
        if (!info) return;
        this._pendingInputs.push({ heroId: info.playerId, cmd: msg.cmd });
        break;
      }

      case 'setName': {
        const info = this._players.get(ws);
        if (!info) return;
        this._setPlayer(ws, { ...info, name: sanitizeName(msg.name) });
        this._broadcastRoster();
        break;
      }

      case 'setReady': {
        const info = this._players.get(ws);
        if (!info || this._phase !== 'lobby') return;
        this._setPlayer(ws, { ...info, ready: !!msg.ready });
        this._broadcastRoster();
        break;
      }

      case 'startGame': {
        // Re-validated here because the client's disabled-button state is
        // only advisory: a player can un-ready in the gap before this lands,
        // and two clients can press Start at the same instant (the second
        // finds the phase already flipped and no-ops).
        if (!this._players.has(ws)) return;
        if (this._phase !== 'lobby') return;
        if (this._players.size === 0) return;
        if (![...this._players.values()].every((p) => p.ready)) return;
        this._startMatch();
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }

  /** Store player info and mirror it into the socket attachment. */
  private _setPlayer(ws: WebSocket, info: PlayerInfo): void {
    this._players.set(ws, info);
    this._playerSockets.set(info.playerId, ws);
    ws.serializeAttachment(info);
  }

  /**
   * Rebuild `_players` from socket attachments after a hibernation wake.
   * The keepalive timer makes this rare, but a dropped room would otherwise
   * silently ignore every message from its still-connected players.
   */
  private _rehydrate(): void {
    const sockets = this.ctx.getWebSockets();
    if (this._players.size === sockets.length) return;
    for (const ws of sockets) {
      if (this._players.has(ws)) continue;
      const info = ws.deserializeAttachment() as PlayerInfo | null;
      if (!info) continue;
      this._players.set(ws, info);
      this._playerSockets.set(info.playerId, ws);
      const n = Number(info.playerId.slice(1));
      if (Number.isFinite(n)) this._nextPlayerId = Math.max(this._nextPlayerId, n + 1);
    }
    if (this._phase === 'lobby' && this._players.size > 0) this._startLobbyKeepalive();
  }

  // ── Lobby ─────────────────────────────────────────────────────────

  private _roster(): LobbyPlayer[] {
    return [...this._players.values()]
      .map((p) => ({ playerId: p.playerId, name: p.name, ready: p.ready, team: p.team }))
      .sort((a, b) => a.playerId.localeCompare(b.playerId, undefined, { numeric: true }));
  }

  private _broadcastRoster(exclude?: WebSocket): void {
    const msg: RosterMessage = { type: 'roster', phase: this._phase, players: this._roster() };
    this._broadcast(msg, exclude);
  }

  private _startLobbyKeepalive(): void {
    if (this._lobbyTimer) return;
    this._lobbyTimer = setInterval(() => { /* pin the DO while players wait */ }, LOBBY_KEEPALIVE_MS);
  }

  private _stopLobbyKeepalive(): void {
    if (!this._lobbyTimer) return;
    clearInterval(this._lobbyTimer);
    this._lobbyTimer = null;
  }

  /** Everyone readied up — build the match and hand it to every client. */
  private _startMatch(): void {
    this._phase = 'playing';
    this._resetMatch();

    for (const info of this._roster()) {
      this._state.heroes.push(
        createHeroState(info.playerId, info.team, this._spawnPosFor(info.team)),
      );
    }

    this._stopLobbyKeepalive();
    this._startTick();

    const msg: MatchStartMessage = { type: 'matchStart', init: this._matchInit() };
    this._broadcast(msg);
    this._broadcastHeroMeta(false);
  }

  /**
   * Maps with authored spawns place heroes there (by team, wrapping);
   * otherwise spawn on random walkable ground.
   */
  private _spawnPosFor(team: number): { x: number; z: number } {
    const fixed = NAVDATA[this._mapName].spawns;
    if (!fixed) return findRespawnPosition(this._world);
    const spot = fixed[team % fixed.length];
    return findWalkableNear(this._world, spot.x, spot.z);
  }

  /** Bootstrap payload for a starting match or a mid-match joiner. */
  private _matchInit(): MatchInit {
    return {
      map: this._mapName,
      snapshot: this._currentSnapshot(),
      meta: this._heroMetas(),
      creepMeta: this._creepMetas(),
      runeMeta: this._runeMetas(),
    };
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this._rehydrate();

    const info = this._players.get(ws);
    if (!info) return;

    this._players.delete(ws);
    this._playerSockets.delete(info.playerId);
    this._lastMetaJson.delete(info.playerId);

    // Mark hero as dead / despawned (removed from state). A no-op in a lobby,
    // where no heroes exist yet.
    this._state.heroes = this._state.heroes.filter((h) => h.id !== info.playerId);

    // Notify remaining players — a departure can also unblock Start, since
    // the leaver's ready flag no longer counts.
    this._broadcastRoster();

    // Last one out resets the room. The DO id is derived from the room code
    // and therefore permanent, so without this a code could never host a
    // second match.
    if (this._players.size === 0) {
      this._stopTick();
      this._stopLobbyKeepalive();
      this._phase = 'lobby';
      this._nextPlayerId = 1;
      this._lastMetaJson.clear();
      this._resetMatch();
    }
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
    this._pendingEvents = [];
  }

  private _tick(): void {
    // Drain pending inputs.
    const inputs = this._pendingInputs;
    this._pendingInputs = [];

    // Step the simulation.
    const events = stepMatch(this._state, inputs, 1 / TICK_RATE, this._world);
    this._pendingEvents.push(...events);

    // Broadcast the hot snapshot every SNAPSHOT_EVERY ticks, with all events
    // accumulated since the previous snapshot aboard. Projectiles ride their
    // `fire` events instead of the snapshot — clients simulate the flight.
    if (this._state.tick % SNAPSHOT_EVERY === 0) {
      const snapshot: SnapshotMessage = {
        type: 'snapshot',
        tick: this._state.tick,
        heroes: this._state.heroes.map((h) => this._wireHero(h)),
        wards: this._wireWards(),
        blasts: this._wireBlasts(),
        creeps: this._wireCreeps(),
      };
      if (this._pendingEvents.length > 0) {
        snapshot.events = this._pendingEvents.map((ev) =>
          ev.type === 'fire' ? { ...ev, projectile: this._wireProjectile(ev.projectile) } : ev,
        );
      }
      this._broadcast(snapshot);
      this._pendingEvents = [];
    }

    // Cold fields: on schedule (changed heroes only), or a full flush
    // immediately when an event changed them.
    if (events.some((ev) => META_EVENTS.has(ev.type))) {
      this._broadcastHeroMeta(false);
    } else if (this._state.tick % META_EVERY === 0) {
      this._broadcastHeroMeta(true);
    }
  }

  /**
   * Broadcast cold hero fields. With `changedOnly`, heroes whose serialized
   * meta matches the last broadcast are skipped (idle heroes stop costing
   * ~450 B × 4 Hz each); without it, everyone goes out as a full baseline.
   */
  private _broadcastHeroMeta(changedOnly: boolean, exclude?: WebSocket): void {
    const heroes: HeroMeta[] = [];
    for (const meta of this._heroMetas()) {
      const json = JSON.stringify(meta);
      if (changedOnly && this._lastMetaJson.get(meta.id) === json) continue;
      this._lastMetaJson.set(meta.id, json);
      heroes.push(meta);
    }
    if (heroes.length === 0) return;
    this._broadcast({ type: 'heroMeta', heroes } satisfies HeroMetaMessage, exclude);
  }

  // ── Wire encoding ─────────────────────────────────────────────────

  /** Full state for the welcome handshake, including in-flight projectiles. */
  private _currentSnapshot(): Snapshot {
    return {
      tick: this._state.tick,
      heroes: this._state.heroes.map((h) => this._wireHero(h)),
      projectiles: this._state.projectiles.map((p) => this._wireProjectile(p)),
      wards: this._wireWards(),
      blasts: this._wireBlasts(),
      creeps: this._wireCreeps(),
    };
  }

  private _wireProjectile(p: ProjectileState): ProjectileState {
    return {
      ...p,
      pos: { x: q(p.pos.x), z: q(p.pos.z) },
      dir: { x: q4(p.dir.x), z: q4(p.dir.z) },
      traveled: q(p.traveled),
    };
  }

  private _wireWards(): WardState[] {
    return this._state.wards.map((w) => ({
      ...w,
      pos: { x: q(w.pos.x), z: q(w.pos.z) },
      life: q(w.life),
    }));
  }

  private _wireBlasts(): BlastState[] {
    return this._state.blasts.map((b) => ({
      ...b,
      pos: { x: q(b.pos.x), z: q(b.pos.z) },
      timer: q(b.timer),
    }));
  }

  // Only "active" creeps ship per snapshot: at-rest creeps (at spawn, full
  // hp — the sim guarantees this via the leash heal) cost zero bytes.
  // The linger window flushes the final resting pos/hp before a creep
  // goes silent; death/respawn/level travel as events.
  private _wireCreeps(): SnapshotCreep[] {
    return this._state.creeps
      .filter((c) => c.alive && this._state.tick - c.lastActiveTick < CREEP.activeLingerTicks)
      .map((c) => ({
        id: c.id,
        pos: { x: q(c.pos.x), z: q(c.pos.z) },
        facing: q(c.facing),
        hp: q(c.hp),
      }));
  }

  /** Cold creep registry for the welcome handshake. */
  private _creepMetas(): CreepMeta[] {
    return this._state.creeps.map((c) => ({
      id: c.id,
      campId: c.campId,
      type: c.type,
      level: c.level,
      alive: c.alive,
      hp: q(c.hp),
      pos: { x: q(c.pos.x), z: q(c.pos.z) },
      spawnPos: { x: q(c.spawnPos.x), z: q(c.spawnPos.z) },
    }));
  }

  /** Rune registry for the welcome handshake. */
  private _runeMetas(): RuneMeta[] {
    return this._state.runes.map((r) => ({
      id: r.id,
      pos: { x: q(r.pos.x), z: q(r.pos.z) },
      type: r.type,
      active: r.active,
    }));
  }

  private _wireHero(h: HeroState): SnapshotHero {
    const wire: SnapshotHero = {
      id: h.id,
      team: h.team,
      pos: { x: q(h.pos.x), z: q(h.pos.z) },
      facing: q(h.facing),
      hp: q(h.hp),
      alive: h.alive,
      moving: h.moving,
      blinkCastTimer: q(h.blinkCastTimer),
    };
    if (h.moving && h.path.length > 0) {
      const dest = h.path[h.path.length - 1];
      wire.dest = { x: q(dest.x), z: q(dest.z) };
    }
    return wire;
  }

  private _heroMetas(): HeroMeta[] {
    return this._state.heroes.map((h) => ({
      id: h.id,
      invulnerable: h.invulnerable,
      invulnerableTimer: q(h.invulnerableTimer),
      respawnTimer: q(h.respawnTimer),
      xp: h.xp,
      level: h.level,
      skillPoints: h.skillPoints,
      gold: h.gold,
      kills: h.kills,
      deaths: h.deaths,
      killStreak: h.killStreak,
      multiKillCount: h.multiKillCount,
      multiKillTimer: q(h.multiKillTimer),
      speedBonus: h.speedBonus,
      bonusHp: h.bonusHp,
      bonusDamage: h.bonusDamage,
      critChance: h.critChance,
      inventory: [...h.inventory],
      wardCharges: h.wardCharges,
      ddTimer: q(h.ddTimer),
      hasteTimer: q(h.hasteTimer),
      invisTimer: q(h.invisTimer),
      slowTimer: q(h.slowTimer),
      abilities: this._wireAbilities(h),
      itemCooldowns: this._wireItemCooldowns(h),
    }));
  }

  /**
   * Quantized copy of the per-ability runtime record. Generic over abilities
   * — a new spell rides ABILITY_ORDER with no wire-encoding change.
   */
  private _wireAbilities(h: HeroState): Record<AbilityId, AbilityRuntime> {
    const out = {} as Record<AbilityId, AbilityRuntime>;
    for (const id of ABILITY_ORDER) {
      const a = h.abilities[id];
      const wire: AbilityRuntime = { level: a.level, cooldown: q(a.cooldown) };
      if (a.charges !== undefined) wire.charges = a.charges;
      if (a.recoil !== undefined) wire.recoil = q(a.recoil);
      if (a.active !== undefined) wire.active = a.active;
      if (a.activeTimer !== undefined) wire.activeTimer = q(a.activeTimer);
      out[id] = wire;
    }
    return out;
  }

  private _wireItemCooldowns(h: HeroState): Record<string, number> {
    const out: Record<string, number> = {};
    for (const itemId in h.itemCooldowns) out[itemId] = q(h.itemCooldowns[itemId]);
    return out;
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

  private _buildWorld(mapName: NavdataMapName): void {
    // Annotated rather than inferred: NAVDATA is `as const`, so a field that
    // is null for every currently-baked map would narrow to `null` and make
    // `data.fountains ?? []` a `never[]`.
    const data: NavdataMap = NAVDATA[mapName];
    const ng = data.navGrid;

    // Decode bit-packed walkable cells.
    const cellsBase64 = ng.cellsBase64;
    const bytes = Uint8Array.from(atob(cellsBase64), (c) => c.charCodeAt(0));

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
    const obstacles: ObstacleAABB[] = data.obstacles.map((o) => ({ ...o }));

    // Arena.
    const arena: Rect = { ...data.arena };

    // Shops. Custom maps author a list; built-in maps get the single baked
    // spot. Radii and walkable-snapping must match the client's own shop
    // construction (Game.preload) or buy-range checks disagree.
    const shopSpots = data.shops && data.shops.length > 0
      ? data.shops
      : [data.shopPos];
    const shops: Shop[] = shopSpots.map((s) => {
      const pos = findWalkableNearOnGrid(navGrid, s.x, s.z);
      return {
        pos: { x: pos.x, z: pos.z },
        interactRadius: 85,
        buyRadius: 400,
        items: SHOP_ITEMS,
      };
    });

    // Fountains: use authored positions or built-in defaults (empty).
    const fountains: FountainDef[] = (data.fountains ?? []).map((f) => ({
      pos: { x: f.x, z: f.z },
      healRadius: 200,
      healPerSecond: 100,
    }));

    this._mapName = mapName;
    this._world = { navGrid, pathfinder, obstacles, arena, shops, fountains };
  }
}
