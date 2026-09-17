import { Singleton, type NetWorld } from '@engine/index';
import { START } from './castle';
import type { BeaconEntity, BladeEntity, RoundEntity, ShinobiContext } from './context';
import { Beacon, Blade, Feed, Guard, GuardMode, Phase, Result, Round, Shinobi, ShinobiMode } from './defs';
import { muster } from './guards';

/** How long shinobi gather in the forest before a night starts, once anyone's there, s. */
export const WAIT_SECONDS = 20;
/** How long a night lasts before dawn, s. */
export const NIGHT_SECONDS = 540;
/** How long the shinobi have to get out once the lord's dead, s. */
export const ESCAPE_SECONDS = 90;
/** How long the result shows before the next night, s. */
export const OVER_SECONDS = 14;
/** How long the lord can go missing before he's taken for dead, ms (a change of owner can hide him a moment). */
const MISSING_MS = 3000;

/** Shinobi on a night, by what's become of them. */
export interface Tally {
  inside: number;
  escaped: number;
  taken: number;
}

export function tally(world: NetWorld, round: number): Tally {
  const t: Tally = { inside: 0, escaped: 0, taken: 0 };
  for (const sv of world.all(Shinobi)) {
    const s = sv.render;
    if (s.round !== round) continue;
    if (s.mode === ShinobiMode.Escaped) t.escaped++;
    else if (s.mode === ShinobiMode.Dead) t.taken++;
    else t.inside++;
  }
  return t;
}

/**
 * The night: one migratable entity for the whole castle, run by whoever owns it. Shinobi gather in the forest while the
 * clock runs down; then the watch is mustered and the night begins. If the lord dies the shinobi have a while to get out
 * over the wall, and the night ends when they're out or taken, or at dawn. Each shinobi's peer does its own part from what
 * it sees of the round (see `ShinobiRole.nightly`), and guards, blades and braziers from a night that's over clear
 * themselves away.
 */
export class RoundKeeper {
  private readonly one: Singleton<typeof Round>;
  private lordMissing = 0;

  constructor(private readonly ctx: ShinobiContext) {
    this.one = new Singleton(ctx.world, Round, { init: () => ({ x: START.x, y: START.y + 40, phase: Phase.Waiting, round: 1, timer: WAIT_SECONDS }) });
  }

  get round(): RoundEntity | null {
    return this.one.entity;
  }

  update(dt: number, now: number): void {
    const round = this.one.update(now);
    if (round?.mine) this.run(round, dt);
  }

  /** Ring the alarm bell, if this peer runs the night. */
  ring(seconds: number): void {
    const round = this.round;
    if (round?.mine && (round.state.phase === Phase.Night || round.state.phase === Phase.Escape)) round.state.alarm = seconds;
  }

  private run(round: RoundEntity, dt: number): void {
    const { world } = this.ctx;
    const s = round.state;
    s.alarm = Math.max(0, s.alarm - dt);
    switch (s.phase) {
      case Phase.Waiting:
        if (!world.all(Shinobi).size) {
          s.timer = WAIT_SECONDS;
          break;
        }
        s.timer = Math.max(0, s.timer - dt);
        if (s.timer <= 0) this.startNight(round);
        break;
      case Phase.Night:
      case Phase.Escape: {
        s.timer = Math.max(0, s.timer - dt);
        if (!world.all(Shinobi).size) {
          this.next(round);
          break;
        }
        const t = tally(world, s.round);
        if (s.phase === Phase.Night && this.lordDead(round)) {
          s.phase = Phase.Escape;
          s.timer = ESCAPE_SECONDS;
          world.send(Feed, { text: 'The lord is dead! Get over the wall before the watch closes in' }, { to: 'all' });
          break;
        }
        if (t.inside === 0 || s.timer <= 0) this.end(round, t);
        break;
      }
      case Phase.Over:
        s.timer = Math.max(0, s.timer - dt);
        if (s.timer <= 0) this.next(round);
        break;
    }
  }

  private lordDead(round: RoundEntity): boolean {
    const lord = this.ctx.world.getAs(Guard, round.state.lord);
    if (lord) {
      this.lordMissing = 0;
      return lord.state.mode === GuardMode.Dead;
    }
    this.lordMissing ||= this.ctx.now;
    return this.ctx.now - this.lordMissing > MISSING_MS;
  }

  private startNight(round: RoundEntity): void {
    const s = round.state;
    s.phase = Phase.Night;
    s.timer = NIGHT_SECONDS;
    s.result = Result.None;
    s.escaped = s.taken = 0;
    s.alarm = 0;
    this.lordMissing = 0;
    const lord = muster(this.ctx, s.round, tally(this.ctx.world, s.round).inside + tally(this.ctx.world, 0).inside);
    s.lord = lord.id;
    this.ctx.world.send(Feed, { text: `Night ${s.round}: the lord walks his grounds. Kill him, and get out alive` }, { to: 'all' });
  }

  /** Everyone's out or taken, or it's dawn. */
  private end(round: RoundEntity, t: Tally): void {
    const s = round.state;
    const dead = s.phase === Phase.Escape;
    s.phase = Phase.Over;
    s.timer = OVER_SECONDS;
    s.escaped = t.escaped;
    s.taken = t.taken + (dead ? t.inside : 0);
    s.alarm = 0;
    s.result = !dead ? Result.Defended : t.escaped > 0 ? Result.Assassinated : Result.Avenged;
  }

  private next(round: RoundEntity): void {
    const s = round.state;
    s.round++;
    s.phase = Phase.Waiting;
    s.timer = WAIT_SECONDS;
    s.result = Result.None;
    s.lord = 0;
    s.alarm = 0;
  }
}

/** Blades and braziers this peer owns: braziers burn down, and both are cleared away with their night. */
export function updateOwnedThings(ctx: ShinobiContext, dt: number): void {
  const { world } = ctx;
  const round = ctx.round()?.state;
  const over = (r: number) => !round || r !== round.round || round.phase === Phase.Waiting;
  for (const b of world.owned(Blade) as ReadonlySet<BladeEntity>) if (over(b.state.round)) world.despawn(b);
  for (const b of world.owned(Beacon) as ReadonlySet<BeaconEntity>) {
    b.state.left = Math.max(0, b.state.left - dt);
    if (over(b.state.round) || b.state.left <= 0) world.despawn(b);
  }
}
