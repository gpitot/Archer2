/**
 * Two-client integration test: verifies the lobby handshake (roster, ready
 * gating, start) and that two WebSocket connections to the same room then see
 * each other's heroes move and converge.
 *
 * Usage:
 *   1. pnpm dev:server
 *   2. pnpm tsx scripts/test-ws-multi.ts
 */
const PORT = process.env.PORT || '8787';
const ROOM = process.env.ROOM || 'MULTI';
const BASE = `ws://localhost:${PORT}/ws`;

interface Client {
  ws: WebSocket;
  messages: any[];
  welcome: Promise<any>;
  matchStart: Promise<any>;
}

function connect(playerName: string): Client {
  const ws = new WebSocket(`${BASE}/${ROOM}`);
  const messages: any[] = [];
  let resolveWelcome: (v: any) => void;
  let resolveMatch: (v: any) => void;
  const welcome = new Promise<any>((r) => { resolveWelcome = r; });
  const matchStart = new Promise<any>((r) => { resolveMatch = r; });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string);
    messages.push(msg);
    if (msg.type === 'welcome') {
      resolveWelcome(msg);
      // A late joiner gets the world on the welcome instead of matchStart.
      if (msg.init) resolveMatch(msg.init);
    }
    if (msg.type === 'matchStart') resolveMatch(msg.init);
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name: playerName }));
  };

  ws.onerror = () => {
    console.error(`[${playerName}] ws error`);
  };

  return { ws, messages, welcome, matchStart };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Latest roster message a client has seen. */
function latestRoster(c: Client): any[] | null {
  const rosters = c.messages.filter((m: any) => m.type === 'roster');
  return rosters.length > 0 ? rosters[rosters.length - 1].players : null;
}

function fail(msg: string): never {
  console.error(`❌ FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log('[multi] connecting two players...');

  const p1 = connect('Alice');
  const welcome1: any = await p1.welcome;
  const p2 = connect('Bob');
  const welcome2: any = await p2.welcome;

  const aliceId = welcome1.playerId;
  const bobId = welcome2.playerId;
  console.log(`[multi] Alice id=${aliceId}, Bob id=${bobId}`);

  // ── Lobby ──
  if (welcome1.phase !== 'lobby') fail(`Alice expected to land in a lobby, got '${welcome1.phase}'`);
  if (welcome1.init) fail('lobby welcome should not carry match state');
  if (welcome2.roster.length !== 2) fail(`Bob's welcome roster has ${welcome2.roster.length} players, expected 2`);

  await sleep(200);
  const aliceRoster = latestRoster(p1);
  if (!aliceRoster) fail('Alice never received a roster for Bob joining');
  const bobRow = aliceRoster.find((p: any) => p.playerId === bobId);
  if (!bobRow) fail('Bob missing from Alice\'s roster');
  if (bobRow.name !== 'Bob') fail(`roster name is '${bobRow.name}', expected 'Bob'`);
  console.log(`  roster seen by Alice: ${aliceRoster.map((p: any) => p.name).join(', ')}`);

  // Start must be refused while anyone is unready.
  console.log('[multi] trying to start with nobody ready (should be ignored)...');
  p1.ws.send(JSON.stringify({ type: 'startGame' }));
  await sleep(300);
  if (p1.messages.some((m: any) => m.type === 'matchStart')) {
    fail('match started with unready players');
  }
  console.log('  correctly ignored');

  // Ready both, then start.
  console.log('[multi] readying both players and starting...');
  p1.ws.send(JSON.stringify({ type: 'setReady', ready: true }));
  p2.ws.send(JSON.stringify({ type: 'setReady', ready: true }));
  await sleep(300);
  p2.ws.send(JSON.stringify({ type: 'startGame' }));

  const init1: any = await p1.matchStart;
  const init2: any = await p2.matchStart;
  console.log(`  Alice sees ${init1.snapshot.heroes.length} heroes at match start`);
  console.log(`  Bob sees ${init2.snapshot.heroes.length} heroes at match start`);
  if (init1.snapshot.heroes.length !== 2) fail('match did not start with both heroes');

  // ── In-match ──
  await sleep(500);

  const p1Snapshots = p1.messages.filter((m: any) => m.type === 'snapshot');
  const latestP1 = p1Snapshots[p1Snapshots.length - 1];
  const p2Snapshots = p2.messages.filter((m: any) => m.type === 'snapshot');
  const latestP2 = p2Snapshots[p2Snapshots.length - 1];
  if (!latestP1 || !latestP2) fail('no snapshots after match start');

  const aliceSeesBob = latestP1.heroes.some((h: any) => h.id === bobId);
  const bobSeesAlice = latestP2.heroes.some((h: any) => h.id === aliceId);
  console.log(`  Alice sees Bob in snapshot: ${aliceSeesBob} (heroes: ${latestP1.heroes.length})`);
  console.log(`  Bob sees Alice in snapshot: ${bobSeesAlice} (heroes: ${latestP2.heroes.length})`);
  if (!aliceSeesBob || !bobSeesAlice) fail('players do not see each other');

  // Send move commands — Alice moves toward Bob.
  const bobHero = latestP2.heroes.find((h: any) => h.id === bobId);
  const bobPos = bobHero.pos;

  console.log(`[multi] Alice moves toward Bob at (${bobPos.x.toFixed(0)}, ${bobPos.z.toFixed(0)})...`);
  p1.ws.send(JSON.stringify({
    type: 'input',
    seq: 1,
    cmd: { type: 'moveTo', x: bobPos.x, z: bobPos.z },
  }));

  await sleep(2000);

  const bobSnapshotsAfter = p2.messages.filter((m: any) => m.type === 'snapshot');
  const lastSnapshot = bobSnapshotsAfter[bobSnapshotsAfter.length - 1];
  const aliceInBob = lastSnapshot?.heroes.find((h: any) => h.id === aliceId);
  if (!aliceInBob) fail('Alice not in Bob\'s latest snapshot');

  const dist = Math.hypot(aliceInBob.pos.x - bobPos.x, aliceInBob.pos.z - bobPos.z);
  const aliceHero = latestP1.heroes.find((h: any) => h.id === aliceId);
  const initialDist = Math.hypot(aliceHero.pos.x - bobPos.x, aliceHero.pos.z - bobPos.z);
  console.log(`  Alice distance from Bob's start: ${dist.toFixed(0)} (was ${initialDist.toFixed(0)})`);
  if (dist >= initialDist * 0.9) fail('Alice did not move toward Bob');

  // ── Departure ──
  const p1MsgCountBefore = p1.messages.length;
  p2.ws.close();
  await sleep(500);

  const dropped = p1.messages
    .slice(p1MsgCountBefore)
    .filter((m: any) => m.type === 'roster')
    .pop();
  if (!dropped) fail('no roster update after Bob left');
  if (dropped.players.some((p: any) => p.playerId === bobId)) {
    fail('Bob still in the roster after leaving');
  }
  console.log(`  roster after Bob left: ${dropped.players.map((p: any) => p.name).join(', ')}`);

  p1.ws.close();

  console.log(`\n[multi] ✅ all checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
