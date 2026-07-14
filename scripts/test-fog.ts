/**
 * Verifies the fog-of-war system end-to-end:
 *  - enemy behind a hill is NOT visible from low ground (high-ground rule)
 *  - the same spot IS visible after climbing to the crest
 *  - visible cells decay to explored (terrain stays revealed, units hidden)
 *  - a placed ward grants remote vision after the hero walks away
 *  - the enemy hero mesh is hidden while fogged and shown in vision
 *
 * Usage: pnpm tsx scripts/test-fog.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

function check(name: string, ok: boolean): boolean {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  return ok;
}

async function main() {
  const server = await createServer({ root: ROOT, server: { port: 4176 } });
  await server.listen();
  const addr = server.resolvedUrls!.local[0];

  const browser = await chromium.launch({
    headless: true,
    // Allow overriding when the pinned Playwright build isn't downloaded
    // (e.g. sandboxed CI images that pre-install a system chromium).
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('[PAGE ERROR]', e.message));
  // tsx (esbuild keepNames) injects __name() calls into evaluate'd functions.
  await page.addInitScript('window.__name = (fn) => fn;');

  await page.goto(addr, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(800);

  let allPass = true;

  // ── 1. High-ground rule ──
  // Hill: center (650, 520), height 210, radius 640. Put the player at its
  // west base and the enemy just past the crest on the east side.
  const highGround = await page.evaluate(async () => {
    const g = (window as any).__game;
    const t = g._terrain;
    const hero = g._hero;
    const enemy = g._heroes[1];

    const place = (h: any, x: number, z: number) => {
      h.stop();
      h.mesh.position.set(x, t.heightAt(x, z) + 0.5, z);
    };
    place(hero, -150, 520);   // low ground, west of the hill
    place(enemy, 1100, 520);  // past the crest, on the far slope

    g._fog.recomputeNow();
    await new Promise((r) => setTimeout(r, 100)); // let a frame apply visibility
    const fromBelow = {
      enemyVisibleState: g._fog.isVisible(0, enemy.position.x, enemy.position.z),
      enemyMeshVisible: enemy.mesh.visible,
      heroH: hero.position.y.toFixed(0),
      enemyH: enemy.position.y.toFixed(0),
    };

    place(hero, 650, 520); // climb to the crest
    g._fog.recomputeNow();
    await new Promise((r) => setTimeout(r, 100));
    const fromCrest = {
      enemyVisibleState: g._fog.isVisible(0, enemy.position.x, enemy.position.z),
      enemyMeshVisible: enemy.mesh.visible,
    };

    return { fromBelow, fromCrest };
  });
  console.log('=== High ground ===');
  console.log(highGround);
  allPass = check('enemy uphill/behind crest hidden from low ground', !highGround.fromBelow.enemyVisibleState) && allPass;
  allPass = check('enemy mesh culled while fogged', !highGround.fromBelow.enemyMeshVisible) && allPass;
  allPass = check('enemy visible from the crest (high ground sees down)', highGround.fromCrest.enemyVisibleState) && allPass;
  allPass = check('enemy mesh shown while in vision', highGround.fromCrest.enemyMeshVisible) && allPass;

  // ── 2. Explored decay: leave an area → explored (not hidden, not visible) ──
  const explored = await page.evaluate(() => {
    const g = (window as any).__game;
    const t = g._terrain;
    const hero = g._hero;
    const spot = { x: 650, z: 520 }; // we were just standing here
    hero.mesh.position.set(-1500, t.heightAt(-1500, -1500) + 0.5, -1500);
    g._fog.recomputeNow();
    return {
      state: g._fog.stateAt(0, spot.x, spot.z), // expect 1 = explored
      farUnexplored: g._fog.stateAt(0, 1900, 1900), // never seen → 0
    };
  });
  console.log('\n=== Explored decay ===');
  console.log(explored);
  allPass = check('previously seen area decays to explored (1)', explored.state === 1) && allPass;
  allPass = check('never-visited corner still hidden (0)', explored.farUnexplored === 0) && allPass;

  // ── 3. Wards: place one, walk away, the warded area stays visible ──
  const wards = await page.evaluate(async () => {
    const g = (window as any).__game;
    const t = g._terrain;
    const hero = g._hero;

    hero.addWardCharges(5);
    const wardSpot = { x: -1500, z: -1500 }; // hero is standing here now
    (g as any)._placeWard();
    hero.mesh.position.set(1500, t.heightAt(1500, 1500) + 0.5, 1500); // walk far away
    g._fog.recomputeNow();
    await new Promise((r) => setTimeout(r, 100));
    return {
      wardCount: g._wards.length,
      chargesLeft: hero.wardCharges,
      hasWardItem: hero.inventory.includes('sentry_wards'),
      wardSpotVisible: g._fog.isVisible(0, wardSpot.x, wardSpot.z),
      wardMeshInScene: g._wards[0] ? g._scene.children.includes(g._wards[0].mesh) : false,
    };
  });
  console.log('\n=== Wards ===');
  console.log(wards);
  allPass = check('ward placed and charge consumed', wards.wardCount === 1 && wards.chargesLeft === 4) && allPass;
  allPass = check('warded area visible without the hero nearby', wards.wardSpotVisible) && allPass;
  allPass = check('ward mesh added to scene', wards.wardMeshInScene) && allPass;

  // ── 4. Shop item: buying Sentry Wards stacks charges ──
  const shop = await page.evaluate(() => {
    const g = (window as any).__game;
    const hero = g._hero;
    const t = g._terrain;
    hero.mesh.position.set(400, t.heightAt(400, -900) + 0.5, -900); // at the shop
    hero.addGold(100);
    const before = hero.wardCharges;
    g._shop.buy(hero, 1); // index 1 = Sentry Wards
    const mid = hero.wardCharges;
    g._shop.buy(hero, 1); // stackable re-buy
    return { before, mid, after: hero.wardCharges, hasItem: hero.hasItem('sentry_wards') };
  });
  console.log('\n=== Shop ===');
  console.log(shop);
  allPass = check('buying wards grants 5 charges and stacks', shop.mid === shop.before + 5 && shop.after === shop.before + 10) && allPass;
  allPass = check('ward item shown in inventory', shop.hasItem) && allPass;

  // ── 5. Screenshot for visual inspection ──
  await page.evaluate(() => {
    const g = (window as any).__game;
    const t = g._terrain;
    // Frame the hero near the big hill so fog, explored ground, and black mask all show.
    g._hero.mesh.position.set(-150, t.heightAt(-150, 520) + 0.5, 520);
    g._cameraLocked = true;
  });
  await page.waitForTimeout(1500); // let fog brightness ease in
  await page.screenshot({ path: resolve(ROOT, 'screenshot-fog.png') });
  console.log('\nSaved screenshot-fog.png');

  await browser.close();
  await server.close();

  if (!allPass) {
    console.error('\nSome fog-of-war checks FAILED');
    process.exit(1);
  }
  console.log('\nAll fog-of-war checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
