/**
 * Headless scenario runner. Runs sim scenarios with no browser and writes a
 * per-tick JSONL trace for each to traces/<name>.jsonl.
 *
 * Usage:
 *   pnpm sim                 # run every scenario in scenarios/
 *   pnpm sim arrow-hit       # run one (or more) by name
 *   pnpm trace traces/arrow-hit.jsonl --events   # inspect the trace
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SimHarness } from './harness/SimHarness';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, '..', 'scenarios');

interface Scenario {
  name: string;
  run: (h: SimHarness) => void | Promise<void>;
}

async function loadScenarios(filter: string[]): Promise<Scenario[]> {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.ts')).sort();
  const scenarios: Scenario[] = [];
  for (const f of files) {
    const stem = f.replace(/\.ts$/, '');
    if (filter.length > 0 && !filter.includes(stem)) continue;
    const mod = await import(path.resolve(SCENARIOS_DIR, f));
    scenarios.push({ name: mod.name ?? stem, run: mod.run });
  }
  return scenarios;
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2);
  const scenarios = await loadScenarios(filter);
  if (scenarios.length === 0) {
    console.error(`[sim] no scenarios matched [${filter.join(', ')}] in ${SCENARIOS_DIR}`);
    process.exit(1);
  }

  let failed = 0;
  for (const s of scenarios) {
    const h = new SimHarness();
    const started = performance.now();
    try {
      await s.run(h);
      const ms = (performance.now() - started).toFixed(0);
      const trace = h.writeTrace(s.name);
      console.log(`✓ ${s.name}  (${h.ticks} ticks, ${ms}ms)  trace: ${path.relative(process.cwd(), trace)}`);
    } catch (err) {
      failed++;
      const trace = h.writeTrace(s.name);
      console.error(`✗ ${s.name}  — ${(err as Error).message}`);
      console.error(`    trace: ${path.relative(process.cwd(), trace)}`);
    }
  }

  console.log(`\n[sim] ${scenarios.length - failed}/${scenarios.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
