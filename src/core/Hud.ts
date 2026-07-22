/**
 * HUD render: minimap markers, spell bar, hero portrait, item bar,
 * KD/gold/time panel, and shop overlay. Decoupled from Game.ts — receives all state via
 * method parameters so it can be driven by both offline and network update
 * paths identically.
 */
import { ABILITY_ORDER, ABILITIES } from '../sim/abilities';
import { DEFENDERS } from '../sim/buildingRules';
import { HERO, basicRankCap, ultimateRankCap } from '../sim/rules';
import { RUNE_TYPES } from '../sim/runeRules';
import { SHOP_ITEMS, SHOP_ITEMS_BY_ID } from '../sim/shopItems';
import { xpForLevel } from '../sim/stepMatch';
import type { HeroState, MatchState, WardState, CreepState, RuneState } from '../sim/state';
import type { SimWorld } from '../sim/world';
import type { Minimap } from '../rendering/Minimap';
import { playerColorCss } from '../ui/colors';
import type { SpellBar, SpellSlotInfo } from '../ui/SpellBar';
import type { ItemBar } from '../ui/ItemBar';
import type { KDDisplay } from '../ui/KDDisplay';
import type { ShopWindow } from '../ui/ShopWindow';
import type { ShopOverlay } from '../ui/ShopOverlay';
import type { ScoreWindow } from '../ui/ScoreWindow';
import type { HeroStatusBar } from '../ui/HeroStatusBar';
import type { ShopItem } from '../world/Shop';
import type { FogOfWar } from '../vision/FogOfWar';
import type { IsometricCamera } from '../rendering/Camera';
import type { Inventory } from '../sim/state';

export interface HudContext {
  state: MatchState;
  world: SimWorld;
  playerState: HeroState;
  fog: FogOfWar;
  minimap: Minimap;
  spellBar: SpellBar;
  itemBar: ItemBar;
  kdDisplay: KDDisplay;
  shopWindow: ShopWindow;
  shopOverlay: ShopOverlay;
  scoreWindow: ScoreWindow;
  statusBar: HeroStatusBar;
  camera: IsometricCamera;
  isPlayerNearShop: boolean;
  /** Game time in seconds (tick / tickRate). */
  gameTime: number;
  /** Defenders only: current wave number (1-based); absent in other modes. */
  wave?: number;
}

/** Update all HUD elements (minimap + bars) from current game state. */
export function updateHud(ctx: HudContext): void {
  const { state, world, playerState: p, fog, isPlayerNearShop } = ctx;

  const playerTeam = p.team;

  // ── Minimap markers ──────────────────────────────────────────────

  const markers: { x: number; z: number; color: string; radius: number }[] = [];
  for (const h of state.heroes) {
    if (!h.alive) continue;
    if (h.team !== playerTeam && h.invisTimer > 0) continue;
    const visible = h.team === playerTeam || fog.isVisible(playerTeam, h.pos.x, h.pos.z);
    if (!visible) continue;
    markers.push({
      x: h.pos.x, z: h.pos.z,
      color: playerColorCss(h.team),
      // Your own dot is drawn larger — with per-player colours it's no longer
      // the only blue one, so size is what makes it findable at a glance.
      radius: h.id === p.id ? 5 : 3,
    });
  }

  for (const w of state.wards) {
    if (w.team === playerTeam) {
      markers.push({ x: w.pos.x, z: w.pos.z, color: '#66ff88', radius: 2 });
    }
  }

  const camps = new Map<string, { x: number; z: number; alive: boolean }>();
  for (const c of state.creeps) {
    let camp = camps.get(c.campId);
    if (!camp) { camp = { x: c.spawnPos.x, z: c.spawnPos.z, alive: false }; camps.set(c.campId, camp); }
    if (c.alive) {
      camp.alive = true;
      if (fog.isVisible(playerTeam, c.pos.x, c.pos.z)) {
        markers.push({ x: c.pos.x, z: c.pos.z, color: '#c8b830', radius: 2 });
      }
    }
  }
  for (const camp of camps.values()) {
    markers.push({ x: camp.x, z: camp.z, color: camp.alive ? '#999966' : '#444444', radius: 3 });
  }

  for (const r of state.runes) {
    const up = r.active && fog.isVisible(playerTeam, r.pos.x, r.pos.z);
    markers.push({
      x: r.pos.x, z: r.pos.z,
      color: up ? `#${RUNE_TYPES[r.type].color.toString(16).padStart(6, '0')}` : '#555555',
      radius: up ? 3 : 2,
    });
  }

  for (const shop of world.shops) {
    markers.push({ x: shop.pos.x, z: shop.pos.z, color: '#ffcc44', radius: 4 });
  }

  for (const fountain of world.fountains) {
    const visible = fog.isVisible(playerTeam, fountain.pos.x, fountain.pos.z);
    markers.push({
      x: fountain.pos.x, z: fountain.pos.z,
      color: visible ? '#4488ff' : '#334466', radius: 3,
    });
  }

  ctx.minimap.draw(markers, {
    cx: ctx.camera.target.x,
    cz: ctx.camera.target.z,
    halfW: ctx.camera.viewHalfWidth(),
  });

  // ── Spell bar ────────────────────────────────────────────────────

  const basicCap = basicRankCap(p.level);
  const ultCap = ultimateRankCap(p.level);
  const hasPoint = p.skillPoints > 0;
  ctx.spellBar.update(ABILITY_ORDER.map((id) => {
    const def = ABILITIES[id];
    const { level, cooldown, charges } = p.abilities[id];
    const total = def.cooldownByLevel[Math.max(level, 1)];
    const cap = def.kind === 'ultimate' ? ultCap : basicCap;
    const info: SpellSlotInfo = {
      cooldownProgress: cooldown <= 0 ? 1 : 1 - cooldown / total,
      cooldownRemaining: Math.max(cooldown, 0),
      level,
      canLevel: hasPoint && level < Math.min(def.maxLevel, cap),
    };
    if (def.charges) {
      info.charges = charges ?? 0;
      info.maxCharges = def.charges.max;
    }
    return info;
  }));

  const charges: Record<string, number> = {};
  const cdProgress: Record<string, number> = {};
  const cdRemaining: Record<string, number> = {};
  if (p.inventory.includes('sentry_wards')) charges['sentry_wards'] = p.wardCharges;
  for (const itemId in p.itemCooldowns) {
    const remaining = p.itemCooldowns[itemId];
    cdRemaining[itemId] = Math.max(remaining, 0);
    const def = SHOP_ITEMS_BY_ID[itemId];
    const maxCd = def?.use?.cooldown;
    cdProgress[itemId] = remaining <= 0 || !maxCd ? 1 : 1 - remaining / maxCd;
  }
  ctx.itemBar.update(p.inventory, charges, cdProgress, cdRemaining);
  ctx.kdDisplay.update(p.kills, p.deaths, p.gold, ctx.gameTime);
  if (ctx.wave !== undefined) ctx.kdDisplay.setWave(ctx.wave, DEFENDERS.wavesToWin);
  ctx.statusBar.update(p.hp, p.level, p.xp, p.bonusHp);

  // ── Shop ─────────────────────────────────────────────────────────

  // Overlay: show when near any shop
  let nearAny = false;
  for (const shop of world.shops) {
    if (Math.hypot(shop.pos.x - p.pos.x, shop.pos.z - p.pos.z) <= shop.buyRadius) {
      nearAny = true;
      break;
    }
  }
  if (nearAny) {
    ctx.shopOverlay.show();
  } else {
    ctx.shopOverlay.hide();
  }
  if (ctx.shopWindow.visible) {
    ctx.shopWindow.refresh(p.gold, p.inventory, isPlayerNearShop);
  }

  // ── Scoreboard ───────────────────────────────────────────────────
  if (ctx.scoreWindow.visible) {
    ctx.scoreWindow.refresh(state.heroes);
  }
}
