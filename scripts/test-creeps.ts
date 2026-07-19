/**
 * End-to-end verification of jungle creeps in the real offline client
 * (test map): spawn, fog gating, aggro/chase/melee, kill rewards, leash,
 * dragon fireballs. Screenshots + state probes at each step.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';
import { withAuto } from './autoUrl';

const ROOT = resolve(import.meta.dirname, '..');

const OUT = '/tmp';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4175, open: false } });
  await server.listen();
  const url = server.resolvedUrls!.local[0] + '?map=test';

  const browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('[console] ' + msg.text()); });

  await page.goto(withAuto(url), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 15000 });
  await sleep(2000);

  const snap = (label: string) => page.evaluate((l) => {
    const g = (window as any).__game;
    const p = g._playerState;
    return {
      label: l,
      creeps: g._state.creeps.map((c: any) => ({
        id: c.id, camp: c.campId, type: c.type, x: Math.round(c.pos.x), z: Math.round(c.pos.z),
        hp: c.hp, level: c.level, alive: c.alive, aggro: c.aggroTargetId,
        viewVisible: g._creepViews.get(c.id)?.mesh.visible ?? null,
      })),
      views: g._creepViews.size,
      player: { x: Math.round(p.pos.x), z: Math.round(p.pos.z), hp: p.hp, gold: p.gold, xp: p.xp, level: p.level },
      projectiles: g._state.projectiles.map((pr: any) => ({ id: pr.id, ownerKind: pr.ownerKind ?? 'hero', owner: pr.ownerId })),
      drawCalls: g._renderer._renderer?.info?.render?.calls ?? null,
    };
  }, label);

  const cmd = (c: any) => page.evaluate((cc) => (window as any).__game._enqueueCommand(cc), c);
  const log = (o: any) => console.log(JSON.stringify(o));

  // ── A: initial state ──
  log(await snap('A-initial'));
  await page.screenshot({ path: `${OUT}/creeps-A-spawn.png` });

  // ── B: walk to the west ghoul camp → aggro + melee ──
  const target = await page.evaluate(() => {
    const g = (window as any).__game;
    const c1 = g._state.creeps.find((c: any) => c.id === 'c1');
    return { x: c1.pos.x + 120, z: c1.pos.z + 120 };
  });
  await cmd({ type: 'moveTo', x: target.x, z: target.z });
  await page.waitForFunction(() => {
    const g = (window as any).__game;
    return g._state.creeps.some((c: any) => c.aggroTargetId === 'player');
  }, undefined, { timeout: 15000 });
  log(await snap('B-aggro'));
  // wait for a melee hit (player hp drops)
  await page.waitForFunction(() => (window as any).__game._playerState.hp < 625, undefined, { timeout: 15000 });
  await page.screenshot({ path: `${OUT}/creeps-B-melee.png` });
  log(await snap('B-melee-hit'));

  // ── C: kill a ghoul with two arrows → gold/xp bounty ──
  await cmd({ type: 'levelAbility', ability: 'arrow' });
  const before = await page.evaluate(() => {
    const p = (window as any).__game._playerState;
    return { gold: p.gold, xp: p.xp };
  });
  for (let shot = 0; shot < 6; shot++) {
    const aim = await page.evaluate(() => {
      const g = (window as any).__game;
      const c = g._state.creeps.filter((c: any) => c.alive && c.type === 'ghoul')
        .sort((a: any, b: any) => {
          const p = g._playerState.pos;
          const da = (a.pos.x - p.x) ** 2 + (a.pos.z - p.z) ** 2;
          const db = (b.pos.x - p.x) ** 2 + (b.pos.z - p.z) ** 2;
          return da - db;
        })[0];
      return c ? { x: c.pos.x, z: c.pos.z } : null;
    });
    if (!aim) break;
    await cmd({ type: 'cast', ability: 'arrow', x: aim.x, z: aim.z });
    await sleep(700);
    const dead = await page.evaluate(() => (window as any).__game._state.creeps.some((c: any) => !c.alive));
    if (dead) break;
  }
  await page.screenshot({ path: `${OUT}/creeps-C-kill.png` });
  const afterKill = await snap('C-after-kill');
  log(afterKill);
  log({ label: 'C-rewards', before, after: { gold: afterKill.player.gold, xp: afterKill.player.xp } });

  // ── D (probe): flee → leash breaks, survivor walks home and heals ──
  await cmd({ type: 'moveTo', x: 300, z: 500 });
  await page.waitForFunction(() => {
    const g = (window as any).__game;
    return g._state.creeps.every((c: any) => c.aggroTargetId === null);
  }, undefined, { timeout: 20000 });
  await sleep(4000); // let survivors walk home + heal
  log(await snap('D-after-leash'));

  // ── E: dragon camp → fireball visuals + ranged hit ──
  const dragonPos = await page.evaluate(() => {
    const g = (window as any).__game;
    const d = g._state.creeps.find((c: any) => c.type === 'dragon' && c.campId === 'camp_ne');
    return { x: d.pos.x, z: d.pos.z };
  });
  await cmd({ type: 'moveTo', x: dragonPos.x - 350, z: dragonPos.z + 350 });
  await page.waitForFunction(() => {
    const g = (window as any).__game;
    return g._state.projectiles.some((p: any) => p.ownerKind === 'creep');
  }, undefined, { timeout: 25000 });
  await sleep(350); // let the fireball get some air
  await page.screenshot({ path: `${OUT}/creeps-E-fireball.png` });
  log(await snap('E-fireball'));

  const hpBefore = (await snap('E2')).player.hp;
  await page.waitForFunction((hp) => (window as any).__game._playerState.hp < hp, hpBefore, { timeout: 15000 });
  log(await snap('E-fireball-hit'));
  await page.screenshot({ path: `${OUT}/creeps-E-hit.png` });

  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  else console.log('NO PAGE ERRORS');

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
