/**
 * Melee creep lifecycle: a ghoul ignores a distant hero, aggros when the
 * hero comes close, chases and claws, dies to arrows for exact gold/XP,
 * then respawns 60s later at level 2 with level-2 stats.
 */
import { SimHarness, expectEvent, expectTrue } from '../scripts/harness/SimHarness';
import { CREEP, CREEP_TYPES, creepGold, creepMaxHp, creepXp } from '../src/sim/creepRules';

export const name = 'creep-melee';
export const map = 'test';

export function run(h: SimHarness): void {
  const heroPos = h.findWalkableNear(-350, 420);
  const hero = h.spawnHero('p1', 0, heroPos);
  const [ghoul] = h.spawnCamp('camp_test', h.findWalkableNear(250, 420), ['ghoul']);
  const def = CREEP_TYPES.ghoul;

  // Well outside aggro range: the ghoul stays put and stays idle.
  h.tick(30);
  expectTrue(ghoul.aggroTargetId === null, 'ghoul idle beyond aggro range');
  expectTrue(
    ghoul.pos.x === ghoul.spawnPos.x && ghoul.pos.z === ghoul.spawnPos.z,
    'idle ghoul stays at spawn',
  );

  // Walk within aggro range → the ghoul locks on and chases.
  h.issue('p1', {
    type: 'moveTo',
    x: ghoul.pos.x - def.aggroRange + 100,
    z: ghoul.pos.z,
  });
  h.runUntil(() => ghoul.aggroTargetId === 'p1', h.seconds(5), 'ghoul aggro');

  // The stationary hero gets clawed for exact melee damage.
  const events = h.runUntil((_s, evs) => evs.some((e) => e.type === 'hit'), h.seconds(5), 'melee hit');
  const hit = expectEvent(events, 'hit');
  expectTrue(hit.type === 'hit' && hit.sourceId === 'c1', 'hit came from the ghoul');
  expectTrue(hit.type === 'hit' && hit.damage === def.baseDamage, 'level-1 ghoul damage');
  expectTrue(hero.hp === 625 - def.baseDamage, `hero hp after claw: ${hero.hp}`);

  // Two level-1 arrows (200 each vs 250 hp) kill it; the last-hitter gets
  // the exact level-1 bounty.
  h.issue('p1', { type: 'levelAbility', ability: 'arrow' });
  h.tick();
  h.issue('p1', { type: 'cast', ability: 'arrow', x: ghoul.pos.x, z: ghoul.pos.z });
  h.runUntil((_s, evs) => evs.some((e) => e.type === 'creepHit'), h.seconds(2), 'first arrow');
  expectTrue(ghoul.hp === def.baseHp - 200, `ghoul hp after first arrow: ${ghoul.hp}`);

  h.tick(7); // let the 0.2s fire recoil clear so the second shot isn't dropped
  h.issue('p1', { type: 'cast', ability: 'arrow', x: ghoul.pos.x, z: ghoul.pos.z });
  const killEvents = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'creepKill'),
    h.seconds(2),
    'creep kill',
  );
  const kill = expectEvent(killEvents, 'creepKill');
  expectTrue(kill.type === 'creepKill' && kill.killerId === 'p1', 'kill credited to p1');
  expectTrue(kill.type === 'creepKill' && kill.gold === creepGold('ghoul', 1), 'level-1 gold bounty');
  expectTrue(kill.type === 'creepKill' && kill.xp === creepXp('ghoul', 1), 'level-1 xp bounty');
  expectTrue(hero.xp === creepXp('ghoul', 1), `hero xp is exactly the creep bounty: ${hero.xp}`);
  expectTrue(!ghoul.alive, 'ghoul dead');

  // 60 seconds later it respawns at level 2 with level-2 max hp.
  const respawnEvents = h.runUntil(
    (_s, evs) => evs.some((e) => e.type === 'creepRespawn'),
    h.seconds(CREEP.respawnInterval + 1),
    'creep respawn',
  );
  const respawn = expectEvent(respawnEvents, 'creepRespawn');
  expectTrue(respawn.type === 'creepRespawn' && respawn.level === 2, 'respawned at level 2');
  expectTrue(ghoul.alive, 'ghoul alive after respawn');
  expectTrue(ghoul.hp === creepMaxHp('ghoul', 2), `level-2 hp: ${ghoul.hp}`);
  expectTrue(
    ghoul.pos.x === ghoul.spawnPos.x && ghoul.pos.z === ghoul.spawnPos.z,
    'respawned at camp',
  );
}
