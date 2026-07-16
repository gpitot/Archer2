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
import { DurableObject, WebSocket } from 'cloudflare:workers';
import { MatchState, HeroInput, HeroState, SimEvent, ProjectileState, WardState, BlastState, createMatchState, createHeroState } from '../src/sim/state';
import { stepMatch } from '../src/sim/stepMatch';
import { spawnCamps } from '../src/sim/stepCreeps';
import { CREEP } from '../src/sim/creepRules';
import { SimWorld, ObstacleAABB, Rect, Shop, findRespawnPosition } from '../src/sim/world';
import { SHOP_ITEMS } from '../src/sim/shopItems';
import { NavGrid } from '../src/navigation/NavGrid';
import { Pathfinder } from '../src/navigation/Pathfinder';
import { HERO } from '../src/sim/rules';
import {
  ClientMessage, ServerMessage, WelcomeMessage, SnapshotMessage,
  HeroMetaMessage, SnapshotHero, HeroMeta, SnapshotCreep, CreepMeta, Snapshot,
  PeerJoinedMessage, PeerLeftMessage,
} from '../src/sim/protocol';

// ── Compact navdata (auto-generated) ─────────────────────────────────
import { NAVDATA, NavdataMapName } from './navdata';

// ── Env interface for the DO ─────────────────────────────────────────
export interface Env {
  GAME_ROOM: DurableObjectNamespace<typeof import('./GameRoom').GameRoom>;
}

// ── Per-socket attachment ────────────────────────────────────────────
interface PlayerInfo {
  playerId: string;
  name: string;
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

/** Events whose effects live in the cold fields — flush meta immediately. */
const META_EVENTS = new Set(['kill', 'respawn', 'purchase', 'levelUp', 'creepKill']);

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
   * Called once when the DO is first created or woken from hibernation.
   * Build the shared world from compact navdata.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this._buildWorld('arena');
    this._resetMatch();
  }

  /** Fresh match state for the current world — including creep camps. */
  private _resetMatch(): void {
    this._state = createMatchState();
    spawnCamps(this._state, this._world);
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
        // The first joiner picks the room's map; later joiners must match.
        const requestedMap: NavdataMapName = msg.map === 'test' ? 'test' : 'arena';
        if (this._players.size === 0) {
          if (requestedMap !== this._mapName) {
            this._buildWorld(requestedMap);
            this._resetMatch();
          }
        } else if (requestedMap !== this._mapName) {
          ws.close(1013, `room is on map '${this._mapName}'`);
          return;
        }
        const playerId = `p${this._nextPlayerId++}`;
        const info: PlayerInfo = { playerId, name: msg.name };
        this._players.set(ws, info);
        this._playerSockets.set(playerId, ws);

        // Spawn hero on a random walkable position. Assign the lowest free
        // team id (FFA = one team per player) so a leave-then-join never hands
        // a newcomer a team that's still in use by an existing player.
        const spawn = findRespawnPosition(this._world);
        const used = new Set(this._state.heroes.map((h) => h.team));
        let team = 0;
        while (used.has(team)) team++;
        const hero = createHeroState(playerId, team, spawn);
        this._state.heroes.push(hero);

        // Start the tick loop if this is the first player.
        if (!this._tickTimer) this._startTick();

        // Send welcome with initial snapshot + cold fields.
        const welcome: WelcomeMessage = {
          type: 'welcome',
          playerId,
          tickRate: TICK_RATE,
          snapshotRate: SNAPSHOT_RATE,
          map: this._mapName,
          snapshot: this._currentSnapshot(),
          meta: this._heroMetas(),
          creepMeta: this._creepMetas(),
        };
        ws.send(JSON.stringify(welcome));

        // Notify others, and flush cold fields so everyone has the new
        // hero's meta without waiting for the next scheduled heroMeta.
        const peerMsg: PeerJoinedMessage = { type: 'peerJoined', playerId, name: msg.name };
        this._broadcast(peerMsg, ws);
        this._broadcastHeroMeta(false, ws);
        break;
      }

      case 'input': {
        const info = this._players.get(ws);
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
    this._lastMetaJson.delete(info.playerId);

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

  private _wireHero(h: HeroState): SnapshotHero {
    const wire: SnapshotHero = {
      id: h.id,
      team: h.team,
      pos: { x: q(h.pos.x), z: q(h.pos.z) },
      facing: q(h.facing),
      hp: q(h.hp),
      alive: h.alive,
      moving: h.moving,
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
      inventory: [...h.inventory],
      wardCharges: h.wardCharges,
      abilityLevel: h.abilityLevel,
      abilityCooldown: q(h.abilityCooldown),
      abilityCharges: h.abilityCharges,
      abilityRecoilTimer: q(h.abilityRecoilTimer),
      dodgeActive: h.dodgeActive,
      dodgeTimer: q(h.dodgeTimer),
      dodgeCooldown: q(h.dodgeCooldown),
      dodgeLevel: h.dodgeLevel,
      blinkCooldown: q(h.blinkCooldown),
      blastCooldown: q(h.blastCooldown),
    }));
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
    const data = NAVDATA[mapName];
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

    // Shop.
    const shop: Shop = {
      pos: { x: data.shopPos.x, z: data.shopPos.z },
      interactRadius: 120,
      items: SHOP_ITEMS,
    };

    this._mapName = mapName;
    this._world = { navGrid, pathfinder, obstacles, arena, shop };
  }
}
