/**
 * Bandwidth measurement: connects N bot clients to one room, drives them
 * (move + fire) to generate realistic traffic, and reports per-client
 * downstream KB/s with a per-message-type breakdown.
 *
 * Usage:
 *   1. pnpm dev:server
 *   2. pnpm tsx scripts/measure-ws.ts            # 4 players, 15 s
 *      PLAYERS=8 DURATION=30 pnpm tsx scripts/measure-ws.ts
 */
const PORT = process.env.PORT || '8787';
const ROOM = process.env.ROOM || 'MEASURE';
const PLAYERS = Number(process.env.PLAYERS || 4);
const DURATION = Number(process.env.DURATION || 15); // seconds
const BASE = `ws://localhost:${PORT}/ws`;

interface Bot {
  ws: WebSocket;
  name: string;
  seq: number;
  bytes: number;
  messages: number;
  byType: Map<string, { count: number; bytes: number }>;
  ready: Promise<any>;
}

function connect(name: string): Bot {
  const ws = new WebSocket(`${BASE}/${ROOM}`);
  let resolveReady: (v: any) => void;
  const bot: Bot = {
    ws, name, seq: 0, bytes: 0, messages: 0,
    byType: new Map(),
    ready: new Promise((r) => { resolveReady = r; }),
  };

  ws.onmessage = (event) => {
    const raw = event.data as string;
    bot.bytes += raw.length;
    bot.messages++;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const rec = bot.byType.get(msg.type) ?? { count: 0, bytes: 0 };
    rec.count++;
    rec.bytes += raw.length;
    bot.byType.set(msg.type, rec);
    if (msg.type === 'welcome') resolveReady(msg);
  };

  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onerror = () => console.error(`[${name}] ws error`);
  return bot;
}

function send(bot: Bot, cmd: any) {
  bot.ws.send(JSON.stringify({ type: 'input', seq: bot.seq++, cmd }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`[measure] ${PLAYERS} players, ${DURATION}s, room=${ROOM}`);

  const bots: Bot[] = [];
  for (let i = 0; i < PLAYERS; i++) {
    const bot = connect(`Bot${i + 1}`);
    bots.push(bot);
    await bot.ready;
  }
  console.log(`[measure] all connected`);

  // Spend the starting skill point on the arrow so bots can fire.
  for (const bot of bots) send(bot, { type: 'levelAbility', ability: 'arrow' });
  await sleep(200);

  // Reset counters — measure steady-state only, not the join burst.
  for (const bot of bots) {
    bot.bytes = 0;
    bot.messages = 0;
    bot.byType.clear();
  }

  const start = Date.now();
  const driver = setInterval(() => {
    for (const bot of bots) {
      // Wander and fire: enough to keep heroes moving and 1-2 arrows/s/bot
      // in flight, approximating active combat.
      send(bot, { type: 'moveTo', x: 500 + Math.random() * 2000, z: 500 + Math.random() * 2000 });
      send(bot, { type: 'fire', aimX: 500 + Math.random() * 2000, aimZ: 500 + Math.random() * 2000 });
    }
  }, 500);

  await sleep(DURATION * 1000);
  clearInterval(driver);
  const elapsed = (Date.now() - start) / 1000;

  console.log(`\n[measure] results over ${elapsed.toFixed(1)}s:`);
  let totalBytes = 0;
  for (const bot of bots) {
    totalBytes += bot.bytes;
    console.log(`  ${bot.name}: ${(bot.bytes / elapsed / 1024).toFixed(1)} KB/s down, ${(bot.messages / elapsed).toFixed(0)} msg/s`);
  }
  const b0 = bots[0];
  console.log(`  breakdown (${b0.name}):`);
  for (const [type, rec] of b0.byType) {
    console.log(`    ${type.padEnd(10)} ${String(rec.count).padStart(5)} msgs  ${(rec.bytes / elapsed / 1024).toFixed(2).padStart(8)} KB/s  avg ${(rec.bytes / rec.count).toFixed(0)} B`);
  }
  console.log(`  TOTAL server egress: ${(totalBytes / elapsed / 1024).toFixed(1)} KB/s across ${PLAYERS} clients`);

  for (const bot of bots) bot.ws.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
