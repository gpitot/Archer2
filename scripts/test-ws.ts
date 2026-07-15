/**
 * Quick smoke test: connects to a GameRoom DO via WebSocket, sends a join
 * and a move command, then verifies snapshot broadcasts.
 *
 * Usage:
 *   1. pnpm dev:server       (start wrangler dev in one terminal)
 *   2. pnpm tsx scripts/test-ws.ts   (run this)
 */
const ROOM = 'TEST';
const WS_URL = `ws://localhost:8787/ws/${ROOM}`;

async function main() {
  console.log(`[test-ws] connecting to ${WS_URL}...`);
  const ws = new WebSocket(WS_URL);

  const messages: any[] = [];
  let welcomeReceived = false;
  let snapshotCount = 0;

  ws.onopen = () => {
    console.log('[test-ws] connected, sending join...');
    ws.send(JSON.stringify({ type: 'join', name: 'TestPlayer' }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string);
    messages.push(msg);

    if (msg.type === 'welcome') {
      welcomeReceived = true;
      console.log(`[test-ws] welcome received, playerId=${msg.playerId}, tickRate=${msg.tickRate}`);
      console.log(`  heroes in snapshot: ${msg.snapshot.heroes.length}`);
      console.log(`  tick: ${msg.snapshot.tick}`);

      // Send a move command.
      const hero = msg.snapshot.heroes[0];
      if (hero) {
        ws.send(JSON.stringify({
          type: 'input',
          seq: 1,
          cmd: { type: 'moveTo', x: hero.pos.x + 200, z: hero.pos.z + 200 },
        }));
        console.log(`[test-ws] sent moveTo(${hero.pos.x + 200}, ${hero.pos.z + 200})`);
      }
    }

    if (msg.type === 'snapshot') {
      snapshotCount++;
    }
  };

  ws.onerror = (err) => {
    console.error('[test-ws] error:', err);
  };

  ws.onclose = (event) => {
    console.log(`[test-ws] closed, code=${event.code}`);
    printResults();
  };

  // Wait for snapshots, then close.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  ws.close();

  function printResults() {
    console.log(`\n[test-ws] results:`);
    console.log(`  welcome received: ${welcomeReceived}`);
    console.log(`  snapshots received: ${snapshotCount}`);
    console.log(`  total messages: ${messages.length}`);
    console.log('  message types:', messages.map((m: any) => m.type).join(', '));

    if (!welcomeReceived) {
      console.error('❌ FAIL: welcome not received');
      process.exit(1);
    }
    if (snapshotCount === 0) {
      console.error('❌ FAIL: no snapshots received');
      process.exit(1);
    }
    console.log('✅ PASS');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
