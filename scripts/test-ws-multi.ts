/**
 * Two-client integration test: verifies that two WebSocket connections to
 * the same room see each other's heroes move, converge, and interact.
 *
 * Usage:
 *   1. pnpm dev:server
 *   2. pnpm tsx scripts/test-ws-multi.ts
 */
const PORT = process.env.PORT || '8787';
const ROOM = process.env.ROOM || 'MULTI';
const BASE = `ws://localhost:${PORT}/ws`;

function connect(playerName: string): Promise<{ ws: WebSocket; messages: any[]; ready: Promise<any> }> {
  const url = `${BASE}/${ROOM}`;
  const ws = new WebSocket(url);
  const messages: any[] = [];
  let resolveReady: (v: any) => void;
  const ready = new Promise<any>((r) => { resolveReady = r; });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string);
    messages.push(msg);
    if (msg.type === 'welcome') resolveReady(msg);
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name: playerName }));
  };

  ws.onerror = (err) => {
    console.error(`[${playerName}] ws error`);
  };

  return { ws, messages, ready };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('[multi] connecting two players...');

  // Connect both players.
  const p1 = await connect('Alice');
  const p2 = await connect('Bob');

  const welcome1: any = await p1.ready;
  const welcome2: any = await p2.ready;

  console.log(`[multi] Alice id=${welcome1.playerId}, Bob id=${welcome2.playerId}`);
  console.log(`  Alice sees ${welcome2.snapshot.heroes.length} heroes in initial snapshot`);
  console.log(`  Bob sees ${welcome2.snapshot.heroes.length} heroes in initial snapshot`);

  const aliceId = welcome1.playerId;
  const bobId = welcome2.playerId;

  // Wait for a snapshot that includes both players (Alice's welcome was
  // sent before Bob joined, so it only has Alice).
  console.log(`[multi] waiting for snapshot with both players...`);
  await sleep(500);

  const p1Snapshots = p1.messages.filter((m: any) => m.type === 'snapshot');
  const latestP1 = p1Snapshots[p1Snapshots.length - 1];
  const aliceSeesBob = latestP1.heroes.some((h: any) => h.id === bobId);

  const p2Snapshots = p2.messages.filter((m: any) => m.type === 'snapshot');
  const latestP2 = p2Snapshots[p2Snapshots.length - 1];
  const bobSeesAlice = latestP2.heroes.some((h: any) => h.id === aliceId);

  console.log(`  Alice sees Bob in snapshot: ${aliceSeesBob} (heroes: ${latestP1.heroes.length})`);
  console.log(`  Bob sees Alice in snapshot: ${bobSeesAlice} (heroes: ${latestP2.heroes.length})`);

  if (!aliceSeesBob || !bobSeesAlice) {
    console.error('❌ FAIL: players do not see each other');
    process.exit(1);
  }

  // Send move commands — Alice moves toward Bob.
  const bobHero = latestP2.heroes.find((h: any) => h.id === bobId);
  const bobPos = bobHero.pos;

  console.log(`[multi] Alice moves toward Bob at (${bobPos.x.toFixed(0)}, ${bobPos.z.toFixed(0)})...`);
  p1.ws.send(JSON.stringify({
    type: 'input',
    seq: 1,
    cmd: { type: 'moveTo', x: bobPos.x, z: bobPos.z },
  }));

  // Wait for snapshots and check convergence.
  await sleep(2000);

  // Check the latest snapshot from Bob's perspective.
  const bobSnapshotsAfter = p2.messages.filter((m: any) => m.type === 'snapshot');
  const lastSnapshot = bobSnapshotsAfter[bobSnapshotsAfter.length - 1];
  const aliceInBob = lastSnapshot?.heroes.find((h: any) => h.id === aliceId);

  if (!aliceInBob) {
    console.error('❌ FAIL: Alice not in Bob\'s latest snapshot');
    process.exit(1);
  }

  const dist = Math.hypot(aliceInBob.pos.x - bobPos.x, aliceInBob.pos.z - bobPos.z);
  console.log(`  Alice distance from Bob's start: ${dist.toFixed(0)} world units`);

  // Alice should have moved closer.
  const aliceHero = latestP1.heroes.find((h: any) => h.id === aliceId);
  const initialDist = Math.hypot(aliceHero.pos.x - bobPos.x, aliceHero.pos.z - bobPos.z);
  console.log(`  Initial distance: ${initialDist.toFixed(0)}`);

  if (dist >= initialDist * 0.9) {
    console.error('❌ FAIL: Alice did not move toward Bob');
    process.exit(1);
  }

  // Test peer join/leave notifications. Only the *existing* player gets
  // peerJoined when a new player joins; the new player learns about everyone
  // via their welcome snapshot.
  const p1PeerJoined = p1.messages.some((m: any) => m.type === 'peerJoined' && m.playerId === bobId);
  console.log(`  Alice got peerJoined for Bob: ${p1PeerJoined}`);

  if (!p1PeerJoined) {
    console.error('❌ FAIL: Alice did not receive peerJoined for Bob');
    process.exit(1);
  }

  // Disconnect Bob and check peerLeft.
  const p1MsgCountBefore = p1.messages.length;
  p2.ws.close();
  await sleep(500);

  const bobLeft = p1.messages
    .slice(p1MsgCountBefore)
    .some((m: any) => m.type === 'peerLeft' && m.playerId === bobId);
  console.log(`  Alice got peerLeft for Bob: ${bobLeft}`);

  if (!bobLeft) {
    console.error('❌ FAIL: peerLeft not received');
    process.exit(1);
  }

  // Clean up.
  p1.ws.close();

  console.log(`\n[multi] ✅ all checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
