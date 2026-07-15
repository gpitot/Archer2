/**
 * Trace inspector for JSONL traces written by the sim harness
 * (scripts/harness/SimHarness.ts) and the client debug hook
 * (src/testing/ClientTrace.ts).
 *
 * Usage:
 *   pnpm trace traces/arrow-hit.jsonl                    # summary
 *   pnpm trace traces/arrow-hit.jsonl --events           # event timeline
 *   pnpm trace t.jsonl --entity p1 --fields x,z,hp       # per-line values
 *   pnpm trace t.jsonl --entity p1 --diff                # only changed lines
 *   pnpm trace t.jsonl --motion proj_1                   # per-frame movement
 *   pnpm trace t.jsonl --range 100:200                   # limit tick range
 *
 * --motion uses view coordinates (vx/vz, what's actually on screen) when the
 * trace has them, else sim coordinates. It flags FREEZE (no movement), JUMP
 * (step far above the median), and BACKWARD (moved against direction of
 * travel) frames — exactly the artifacts a "stutter" is made of.
 */
import * as fs from 'fs';

interface Entity {
  id: string;
  [k: string]: unknown;
}

interface Line {
  tick?: number;
  frame?: number;
  t: number;
  heroes?: Entity[];
  projectiles?: Entity[];
  cosmetic?: Entity[];
  events?: { type: string; [k: string]: unknown }[];
  snapTicks?: number[];
  [k: string]: unknown;
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const has = (flag: string): boolean => process.argv.includes(flag);

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: pnpm trace <file.jsonl> [--events] [--entity id [--fields a,b] [--diff]] [--motion id] [--range a:b]');
  process.exit(1);
}

const lines: Line[] = fs
  .readFileSync(file, 'utf-8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

const range = arg('--range');
let view = lines;
if (range) {
  const [a, b] = range.split(':').map(Number);
  view = lines.filter((l) => key(l) >= a && key(l) <= b);
}

/** Line ordering key: frame for client traces, tick for sim traces. */
function key(l: Line): number {
  return l.frame ?? l.tick ?? 0;
}
const keyName = lines[0]?.frame !== undefined ? 'frame' : 'tick';

/**
 * Look up an entity by id. Projectile ids can collide with hero ids (both use
 * a `p<N>` scheme), so ids may be prefixed to disambiguate: "hero:p1",
 * "proj:p1", "cosmetic:0". Unprefixed ids search heroes → projectiles → cosmetic.
 */
function findEntity(l: Line, id: string): Entity | undefined {
  const kinds: Record<string, (Entity[] | undefined)[]> = {
    hero: [l.heroes],
    proj: [l.projectiles],
    cosmetic: [l.cosmetic],
  };
  const m = id.match(/^(hero|proj|cosmetic):(.+)$/);
  const lists = m ? kinds[m[1]] : [l.heroes, l.projectiles, l.cosmetic];
  const bareId = m ? m[2] : id;
  for (const list of lists) {
    const e = list?.find((e) => e.id === bareId);
    if (e) return e;
  }
  return undefined;
}

// ── --events ───────────────────────────────────────────────────────────
if (has('--events')) {
  for (const l of view) {
    for (const ev of l.events ?? []) {
      const { type, ...rest } = ev;
      console.log(`${keyName} ${key(l)}  t=${l.t}  ${type}  ${JSON.stringify(rest)}`);
    }
  }
  process.exit(0);
}

// ── --entity ───────────────────────────────────────────────────────────
const entityId = arg('--entity');
if (entityId) {
  const fields = (arg('--fields') ?? 'x,z').split(',');
  const diff = has('--diff');
  let last: string | null = null;
  for (const l of view) {
    const e = findEntity(l, entityId);
    if (!e) continue;
    const vals = fields.map((f) => `${f}=${JSON.stringify(e[f])}`).join('  ');
    if (diff && vals === last) continue;
    last = vals;
    console.log(`${keyName} ${key(l)}  t=${l.t}  ${vals}`);
  }
  process.exit(0);
}

// ── --motion ───────────────────────────────────────────────────────────
const motionId = arg('--motion');
if (motionId) {
  // Prefer view coordinates (vx/vz) — that's what the player sees.
  const pts: { k: number; t: number; x: number; z: number }[] = [];
  for (const l of view) {
    const e = findEntity(l, motionId);
    if (!e) continue;
    const x = (e.vx ?? e.x) as number;
    const z = (e.vz ?? e.z) as number;
    pts.push({ k: key(l), t: l.t, x, z });
  }
  if (pts.length < 2) {
    console.error(`[trace] entity '${motionId}' present in <2 lines`);
    process.exit(1);
  }

  const steps: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    steps.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const median = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)];

  let freezes = 0, jumps = 0, backwards = 0;
  let lastDir: { x: number; z: number } | null = null;
  console.log(`motion of '${motionId}' over ${pts.length} lines (median step ${median.toFixed(2)}):`);
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    const step = steps[i - 1];
    const flags: string[] = [];
    if (step < Math.max(0.01, median * 0.1)) { flags.push('FREEZE'); freezes++; }
    else if (median > 0 && step > median * 2) { flags.push('JUMP'); jumps++; }
    if (lastDir && step > 0.01 && dx * lastDir.x + dz * lastDir.z < 0) { flags.push('BACKWARD'); backwards++; }
    if (step > 0.01) lastDir = { x: dx / step, z: dz / step };
    console.log(
      `${keyName} ${String(pts[i].k).padStart(5)}  t=${pts[i].t.toFixed(3)}  step=${step.toFixed(2).padStart(8)}  ` +
      `pos=(${pts[i].x.toFixed(1)}, ${pts[i].z.toFixed(1)})  ${flags.join(' ')}`,
    );
  }
  console.log(`\nsummary: ${freezes} FREEZE, ${jumps} JUMP, ${backwards} BACKWARD out of ${steps.length} steps`);
  process.exit(freezes + jumps + backwards > 0 ? 2 : 0);
}

// ── default: summary ───────────────────────────────────────────────────
const first = view[0];
const lastL = view[view.length - 1];
const entityIds = new Set<string>();
const eventCounts = new Map<string, number>();
for (const l of view) {
  for (const list of [l.heroes, l.projectiles, l.cosmetic]) {
    for (const e of list ?? []) entityIds.add(e.id);
  }
  for (const ev of l.events ?? []) eventCounts.set(ev.type, (eventCounts.get(ev.type) ?? 0) + 1);
}
console.log(`${view.length} lines, ${keyName} ${key(first)}..${key(lastL)}, t=${first.t}..${lastL.t}s`);
console.log(`entities: ${[...entityIds].join(', ')}`);
console.log(`events: ${[...eventCounts].map(([t, n]) => `${t}×${n}`).join(', ') || 'none'}`);
