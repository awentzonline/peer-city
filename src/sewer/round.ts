import { Singleton, type NetWorld } from '@engine/index';
import { WATER_START, type SewerContext, type SewerEntity } from './context';
import { Feed, Goblin, Lord, LordMode, Loot, LootKind, LootWhere, Noise, Phase, Result, Sewer, Sound, VALVE_FIELDS, VALVES, type LootKind as Kind } from './defs';
import { stuckSpots } from './fatberg';
import { alive, spawnGoblin } from './goblins';
import { LOOT, buriedKind, pickBurials } from './loot';

/** How long Lordz gather at the ladder before a dive, once anyone's there, s. */
export const GATHER_SECONDS = 15;
/** How long the result shows before the next dive, s. */
export const OVER_SECONDS = 12;
/** Loot buried in the silt each dive, and stuck in the fatberg. */
export const BURIED = 14;
export const STUCK = 2;
/** The sewage never drops below this, or rises over this, m. */
export const WATER_MIN = 0.3;
export const WATER_MAX = 2.6;
/** How fast the sewage rises, m/s: always, and on top of that while a surge comes down. Each open valve drains it. */
export const RISE = 0.0045;
export const SURGE_RISE = 0.03;
export const DRAIN = 0.0045;
/** Valves creep shut on their own: this much a second. */
export const VALVE_CLOSE = 1 / 45;
const SURGE_SECONDS = 12;
const SURGE_GAP = [60, 100] as const;
/** How often a goblin might come out of a drain, ms, and how many there can be. */
const GOBLIN_MS = 5000;
export function goblinCap(lords: number): number {
  return Math.min(14, 3 + lords * 2);
}
/** Seeds each dive's fatberg. */
export const FAT_SEED = 7321;
/** How long a new owner listens for the fatberg's chunks before making its own, ms. */
const CHUNK_WAIT_MS = 2500;

export function fatSeed(dive: number): number {
  return FAT_SEED + dive * 7919;
}

/** The Lordz on a dive, by what's become of them. */
export interface Tally {
  active: number;
  downed: number;
  dead: number;
  surfaced: number;
}

export function tally(world: NetWorld, dive: number): Tally {
  const t: Tally = { active: 0, downed: 0, dead: 0, surfaced: 0 };
  for (const lord of world.all(Lord)) {
    const s = lord.render;
    if (s.dive !== dive) continue;
    if (s.mode === LordMode.Active) t.active++;
    else if (s.mode === LordMode.Downed) t.downed++;
    else if (s.mode === LordMode.Dead) t.dead++;
    else t.surfaced++;
  }
  return t;
}

/**
 * The dive: one migratable entity for the whole sewer, run by whoever owns it. Lordz gather at the foot of the ladder
 * while the clock runs down; then the dive: loot's buried, a fresh fatberg plugs the vault, goblins come out of the
 * drains, and the sewage rises unless the relief valves are kept open. It's over once nobody's left down there but
 * the dead: rich if anyone climbed out, lost if nobody did.
 */
export class DiveKeeper {
  private readonly one: Singleton<typeof Sewer>;
  private nextSurge = 0;
  private surgeUntil = 0;
  private nextGoblin = 0;
  private nextBreach = 0;
  private chunkWait = 0;

  constructor(private readonly ctx: SewerContext) {
    const { start } = ctx.map;
    this.one = new Singleton(ctx.world, Sewer, { init: () => ({ x: start.cx, y: start.cy, phase: Phase.Gather, dive: 1, timer: GATHER_SECONDS, water: WATER_START }) });
  }

  get sewer(): SewerEntity | null {
    return this.one.entity;
  }

  update(dt: number, now: number): void {
    const e = this.one.update(now);
    if (!e?.mine) {
      this.chunkWait = now + CHUNK_WAIT_MS;
      return;
    }
    this.run(e, dt, now);
  }

  private run(e: SewerEntity, dt: number, now: number): void {
    const { world, plug } = this.ctx;
    const s = e.state;
    if (s.phase !== Phase.Over && !plug.chunks.some((c) => c) && now >= this.chunkWait) plug.spawn(world, s.dive, fatSeed(s.dive));
    switch (s.phase) {
      case Phase.Gather: {
        s.water += (WATER_START - s.water) * Math.min(1, dt);
        if (!world.all(Lord).size) {
          s.timer = GATHER_SECONDS;
          break;
        }
        s.timer = Math.max(0, s.timer - dt);
        if (s.timer <= 0) this.startDive(e, now);
        break;
      }
      case Phase.Dive: {
        s.timer += dt;
        this.water(e, dt, now);
        this.breach(e, now);
        this.goblins(e, now);
        const t = tally(world, s.dive);
        if (!world.all(Lord).size) this.next(e);
        else if (t.active === 0 && t.downed === 0) this.end(e, t);
        break;
      }
      case Phase.Over:
        s.timer = Math.max(0, s.timer - dt);
        if (s.timer <= 0) this.next(e);
        break;
    }
  }

  /** Down it all goes: loot in the silt, stuck in the fat, and waiting in the vault. */
  private startDive(e: SewerEntity, now: number): void {
    const { world, map, plug } = this.ctx;
    const s = e.state;
    Object.assign(s, { phase: Phase.Dive, timer: 0, banked: 0, worth: 0, breached: false, surge: false, result: Result.None, surfaced: 0, lost: 0 });
    for (const f of VALVE_FIELDS) s[f] = 0;
    const dive = s.dive;
    for (const spot of pickBurials(map.lootSpots, BURIED)) {
      const x = spot.x + (Math.random() - 0.5) * 0.6;
      const y = spot.y + (Math.random() - 0.5) * 0.6;
      world.spawn(Loot, { x, y, z: 0.02, kind: buriedKind(Math.random()), where: LootWhere.Buried, dive });
    }
    const stuck: Kind[] = [LootKind.Gem, LootKind.Watch];
    stuckSpots(fatSeed(dive), STUCK).forEach((v, i) => {
      const at = plug.frame.toWorld(v.u, v.v, v.w);
      world.spawn(Loot, { ...at, kind: stuck[i % stuck.length], where: LootWhere.Stuck, dive });
    });
    const vault: Kind[] = [LootKind.Toilet, LootKind.Crown, LootKind.Gem, LootKind.Gem];
    map.vaultSpots.slice(0, vault.length).forEach((spot, i) => {
      world.spawn(Loot, { x: spot.x, y: spot.y, z: map.groundAt(spot.x, spot.y), kind: vault[i], where: LootWhere.Lying, dive });
    });
    this.nextSurge = now + rand(SURGE_GAP[0], SURGE_GAP[1]) * 1000;
    this.nextGoblin = now + 6000;
    world.send(Feed, { text: `Dive ${dive}: dig up the loot, blast through the fatberg to the vault, and bring it all back to the ladder` }, { to: 'all' });
  }

  /** The sewage rises, faster in a surge, and each open valve lets some away; the valves creep shut. */
  private water(e: SewerEntity, dt: number, now: number): void {
    const { world } = this.ctx;
    const s = e.state;
    if (!s.surge && now >= this.nextSurge) {
      s.surge = true;
      this.surgeUntil = now + SURGE_SECONDS * 1000;
      world.send(Feed, { text: 'A surge is coming down the pipes! Open the relief valves!' }, { to: 'all' });
    } else if (s.surge && now >= this.surgeUntil) {
      s.surge = false;
      this.nextSurge = now + rand(SURGE_GAP[0], SURGE_GAP[1]) * 1000;
    }
    let drain = 0;
    for (const f of VALVE_FIELDS) {
      drain += s[f] * DRAIN;
      s[f] = Math.max(0, s[f] - VALVE_CLOSE * dt);
    }
    s.water = Math.min(WATER_MAX, Math.max(WATER_MIN, s.water + (RISE + (s.surge ? SURGE_RISE : 0) - drain) * dt));
  }

  /** Once there's a way through the fatberg, everyone hears about it. */
  private breach(e: SewerEntity, now: number): void {
    const { world, plug, map } = this.ctx;
    const s = e.state;
    if (s.breached || now < this.nextBreach || !plug.chunks.some((c) => c)) return;
    this.nextBreach = now + 500;
    if (!plug.open) return;
    s.breached = true;
    const at = plug.frame.toWorld(8, 5, 4);
    world.send(Noise, { kind: Sound.Breach, x: at.x, y: at.y, z: at.z, a: 0 }, { to: 'all' });
    world.send(Feed, { text: `The fatberg's breached! The vault is open` }, { to: 'all' });
    map.fatBlocks = false;
  }

  /** Now and then a goblin comes out of a drain near somebody, up to a limit for how many are down here. */
  private goblins(e: SewerEntity, now: number): void {
    const { ctx } = this;
    const { world, map } = ctx;
    if (now < this.nextGoblin) return;
    this.nextGoblin = now + GOBLIN_MS * (0.7 + Math.random() * 0.6);
    const s = e.state;
    const lords = [...world.all(Lord)].filter((l) => l.render.dive === s.dive && l.render.mode === LordMode.Active);
    if (!lords.length) return;
    let count = 0;
    for (const g of world.all(Goblin)) if (g.render.dive === s.dive && alive(g.render.mode)) count++;
    if (count >= goblinCap(lords.length)) return;
    const options = map.drains.filter((d) => {
      const near = Math.min(...lords.map((l) => Math.hypot(l.x - d.x, l.y - d.y)));
      return near > 6 && near < 30;
    });
    if (!options.length) return;
    spawnGoblin(ctx, options[Math.floor(Math.random() * options.length)], s.dive);
  }

  private end(e: SewerEntity, t: Tally): void {
    const s = e.state;
    s.phase = Phase.Over;
    s.timer = OVER_SECONDS;
    s.surfaced = t.surfaced;
    s.lost = t.dead + t.downed;
    s.result = t.surfaced > 0 ? Result.Rich : Result.Lost;
    this.ctx.world.send(Feed, { text: t.surfaced > 0 ? `Out with £${s.worth} of loot!` : `Nobody made it out. The sewer keeps the lot.` }, { to: 'all' });
  }

  private next(e: SewerEntity): void {
    const s = e.state;
    Object.assign(s, { dive: s.dive + 1, phase: Phase.Gather, timer: GATHER_SECONDS, surge: false, breached: false, banked: 0, worth: 0, result: Result.None });
    for (const f of VALVE_FIELDS) s[f] = 0;
    this.chunkWait = 0;
  }
}

/** A Lord banked loot at the ladder: the sewer's owner counts it. */
export function banked(ctx: SewerContext, e: SewerEntity, by: number, kind: Kind): void {
  const s = e.state;
  if (s.phase !== Phase.Dive) return;
  s.banked = Math.min(255, s.banked + 1);
  s.worth = Math.min(65535, s.worth + LOOT[kind].worth);
  const who = ctx.world.getAs(Lord, by)?.render.name ?? 'Someone';
  ctx.world.send(Feed, { text: `${who} banked ${LOOT[kind].name} (+£${LOOT[kind].worth})` }, { to: 'all' });
}

/** A hand on a relief valve: the sewer's owner opens it. */
export function turned(ctx: SewerContext, e: SewerEntity, valve: number, amount: number): void {
  const s = e.state;
  if (valve < 0 || valve >= VALVES || s.phase !== Phase.Dive) return;
  const f = VALVE_FIELDS[valve];
  const was = s[f];
  s[f] = Math.min(1, was + amount);
  if (was < 0.08 && s[f] >= 0.08) {
    const v = ctx.map.valves[valve];
    ctx.world.send(Noise, { kind: Sound.Gush, x: v.x, y: v.y, z: v.z, a: valve }, { to: 'all' });
  }
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}
