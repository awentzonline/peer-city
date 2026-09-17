import { Singleton, type NetWorld } from '@engine/index';
import type { HauntContext, RoundEntity } from './context';
import { Feed, Haunt, Key, Monster, MonsterKind, MonsterMode, Phase, Result, Round, Survivor, SurvivorMode } from './defs';
import { KEY_FLOOR, pickKeySpots } from './keys';
import { SOCKETS, START } from './manor';
import { monsterCap, summon, summonRefusal } from './monsters';

/** How long survivors gather at the gate before a night starts, once anyone's there, s. */
export const WAIT_SECONDS = 20;
/** How long a night lasts before the house claims whoever's still inside, s. */
export const HUNT_SECONDS = 600;
/** How long the result shows before the next night, s. */
export const OVER_SECONDS = 12;
/** Keys hidden each night: one more than the pedestal needs. */
export const KEYS_HIDDEN = SOCKETS.length + 1;
/** With nobody playing the Haunt, how often the house itself sends something, ms. */
const HOUSE_MS = 7000;

/** Survivors on a night, by what's become of them. */
export interface Tally {
  inside: number;
  escaped: number;
  claimed: number;
}

export function tally(world: NetWorld, round: number): Tally {
  const t: Tally = { inside: 0, escaped: 0, claimed: 0 };
  for (const sv of world.all(Survivor)) {
    const s = sv.render;
    if (s.round !== round) continue;
    if (s.mode === SurvivorMode.Escaped) t.escaped++;
    else if (s.mode === SurvivorMode.Dead) t.claimed++;
    else t.inside++;
  }
  return t;
}

/**
 * The night: one migratable entity for the whole manor, run by whoever owns it. Survivors gather at the gate while the
 * clock runs down, then the hunt: keys are hidden in the house, the Haunt's monsters come, and it's over once nobody's
 * left inside or time's up. Each survivor's peer does its own part from what it sees of the round (see
 * `SurvivorRole.nightly`), and monsters and keys from a night that's over clear themselves away.
 *
 * With nobody playing the Haunt, the house sends monsters of its own, so a group of survivors (or one) still has a night.
 */
export class RoundKeeper {
  private readonly one: Singleton<typeof Round>;
  private nextHouse = 0;

  constructor(private readonly ctx: HauntContext) {
    this.one = new Singleton(ctx.world, Round, { init: () => ({ x: START.x, y: START.y + 30, phase: Phase.Waiting, round: 1, timer: WAIT_SECONDS, needed: SOCKETS.length }) });
  }

  get round(): RoundEntity | null {
    return this.one.entity;
  }

  update(dt: number, now: number): void {
    const round = this.one.update(now);
    if (round?.mine) this.run(round, dt);
  }

  private run(round: RoundEntity, dt: number): void {
    const { world } = this.ctx;
    const s = round.state;
    switch (s.phase) {
      case Phase.Waiting: {
        // the clock only runs with someone at the gate
        if (!world.all(Survivor).size) {
          s.timer = WAIT_SECONDS;
          break;
        }
        s.timer = Math.max(0, s.timer - dt);
        if (s.timer <= 0) this.startHunt(round);
        break;
      }
      case Phase.Hunt: {
        s.timer = Math.max(0, s.timer - dt);
        let placed = 0;
        for (const k of world.all(Key)) if (k.render.round === s.round && k.render.socket) placed++;
        s.placed = Math.min(s.needed, placed);
        const t = tally(world, s.round);
        if (!world.all(Survivor).size) {
          // everyone's gone: start afresh for whoever comes next
          this.next(round);
          break;
        }
        if (t.inside === 0 || s.timer <= 0) {
          this.end(round, t);
          break;
        }
        this.houseHaunts(round);
        break;
      }
      case Phase.Over:
        s.timer = Math.max(0, s.timer - dt);
        if (s.timer <= 0) this.next(round);
        break;
    }
  }

  private startHunt(round: RoundEntity): void {
    const { world, manor } = this.ctx;
    const s = round.state;
    s.phase = Phase.Hunt;
    s.timer = HUNT_SECONDS;
    s.placed = 0;
    s.result = Result.None;
    s.escaped = s.claimed = 0;
    for (const spot of pickKeySpots(manor, KEYS_HIDDEN)) world.spawn(Key, { x: spot.x, y: spot.y, z: KEY_FLOOR, round: s.round });
    world.send(Feed, { text: `Night ${s.round}: find ${s.needed} keys in the house, put them in the pedestal, and get out` }, { to: 'all' });
    this.nextHouse = this.ctx.now + HOUSE_MS * 2;
  }

  /** Nobody left inside, or dawn never came: the living still inside are the house's. */
  private end(round: RoundEntity, t: Tally): void {
    const s = round.state;
    s.phase = Phase.Over;
    s.timer = OVER_SECONDS;
    s.escaped = t.escaped;
    s.claimed = t.claimed + t.inside;
    s.result = t.escaped > 0 ? Result.Escaped : Result.Claimed;
  }

  private next(round: RoundEntity): void {
    const s = round.state;
    s.round++;
    s.phase = Phase.Waiting;
    s.timer = WAIT_SECONDS;
    s.placed = 0;
    s.result = Result.None;
  }

  /** With nobody playing the Haunt, the house keeps a few things prowling near whoever's inside. */
  private houseHaunts(round: RoundEntity): void {
    const { ctx } = this;
    const { world, now } = ctx;
    if (now < this.nextHouse || world.all(Haunt).size) return;
    this.nextHouse = now + HOUSE_MS;
    const s = round.state;
    const inside = [...world.all(Survivor)].filter((sv) => sv.render.round === s.round && sv.render.mode === SurvivorMode.Alive);
    if (!inside.length) return;
    let prowling = 0;
    for (const m of world.all(Monster)) if (m.render.round === s.round && m.render.mode !== MonsterMode.Dead) prowling++;
    if (prowling >= Math.min(monsterCap(inside.length), 1 + inside.length * 2)) return;
    const near = inside[Math.floor(Math.random() * inside.length)];
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const d = 12 + Math.random() * 16;
      const x = near.x + Math.cos(a) * d;
      const y = near.y + Math.sin(a) * d;
      if (summonRefusal(ctx, x, y)) continue;
      summon(ctx, Math.random() < 0.3 ? MonsterKind.Crawler : MonsterKind.Shade, x, y, 0, s.round);
      return;
    }
  }
}
