import { Singleton, type NetWorld } from '@engine/index';
import type { RaceEntity, RacerEntity } from './context';
import { Feed, Phase, Race, Racer, RacerMode } from './defs';

/** Seconds from someone being ready to starting even if others aren't. */
export const READY_WAIT = 25;
/** Seconds on the grid before the go. */
export const COUNTDOWN = 5;
export const RACE_SECONDS = 300;
/** Once someone finishes, the rest have this long. */
export const AFTER_FIRST = 60;
export const RESULTS_SECONDS = 12;
/** A racer that hasn't finished by then is out of luck; one with no racers at all gives up sooner. */
const EMPTY_RACE_SECONDS = 4;

/** Where the race lives: the middle of the garage, so whoever's building there owns it. */
export const RACE_SPOT = { x: -60, y: 0 };

/**
 * The race: one migratable entity for the whole hill, run by whoever owns it. Everyone else only reads its
 * phase. Racers do their own part: they go to the grid when they see a countdown with a round they're not in,
 * go when they see it racing, and go back to their bays when they see it over.
 */
export class RaceKeeper {
  private readonly one: Singleton<typeof Race>;
  private spentRacing = 0;

  constructor(private readonly world: NetWorld) {
    // Give the network a moment to tell us about one first. Two peers making one at once keep the lowest id.
    this.one = new Singleton(world, Race, { init: () => ({ x: RACE_SPOT.x, y: RACE_SPOT.y, phase: Phase.Building, round: 0 }) });
  }

  /** The race, if this peer knows it. */
  get race(): RaceEntity | null {
    return this.one.entity;
  }

  /** Make the race if nobody has, and run it if it's ours. */
  update(dt: number, now: number): void {
    const race = this.one.update(now);
    if (race?.mine) this.run(race, dt);
  }

  private run(race: RaceEntity, dt: number): void {
    const s = race.state;
    const racers = [...this.world.all(Racer)];
    const racing = racers.filter((r) => r.state.round === s.round && r.state.mode !== RacerMode.Parked);
    switch (s.phase) {
      case Phase.Building: {
        const waiting = racers.filter((r) => r.state.mode === RacerMode.Parked);
        const ready = waiting.filter((r) => r.state.ready).length;
        if (!ready) {
          s.timer = 0;
        } else if (ready === waiting.length) {
          this.go(race, Phase.Countdown, COUNTDOWN);
          s.round++;
        } else {
          if (s.timer <= 0) {
            s.timer = READY_WAIT;
            this.say(`A race starts in ${READY_WAIT} seconds: press ready when your racer's done`);
          }
          s.timer = Math.max(0.01, s.timer - dt);
          if (s.timer <= 0.01) {
            this.go(race, Phase.Countdown, COUNTDOWN);
            s.round++;
          }
        }
        break;
      }
      case Phase.Countdown:
        s.timer -= dt;
        if (s.timer <= 0) {
          this.go(race, Phase.Racing, RACE_SECONDS);
          this.spentRacing = 0;
        }
        break;
      case Phase.Racing: {
        s.timer = Math.max(0, s.timer - dt);
        this.spentRacing += dt;
        const done = racing.filter((r) => r.state.mode === RacerMode.Finished).length;
        if (done && s.timer > AFTER_FIRST) s.timer = AFTER_FIRST;
        const everyone = racing.length > 0 && done === racing.length;
        const nobody = racing.length === 0 && this.spentRacing > EMPTY_RACE_SECONDS;
        if (everyone || nobody || s.timer <= 0) this.go(race, Phase.Results, RESULTS_SECONDS);
        break;
      }
      case Phase.Results:
        s.timer -= dt;
        if (s.timer <= 0) this.go(race, Phase.Building, 0);
        break;
    }
  }

  private go(race: RaceEntity, phase: Phase, timer: number): void {
    race.state.phase = phase;
    race.state.timer = timer;
  }

  private say(text: string): void {
    this.world.send(Feed, { text }, { to: 'all' });
  }
}

/** The racers in a round, best first: finishers by time, then the rest by how far they got, then those who gave up. */
export function standings(world: NetWorld, round: number): RacerEntity[] {
  const list = [...world.all(Racer)].filter((r) => r.state.round === round && round > 0 && (r.state.mode !== RacerMode.Parked || r.state.quit));
  return list.sort((a, b) => {
    if (a.state.quit !== b.state.quit) return a.state.quit ? 1 : -1;
    const fa = a.state.finish || Infinity;
    const fb = b.state.finish || Infinity;
    if (fa !== fb) return fa - fb;
    return b.state.progress - a.state.progress;
  });
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function raceTime(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return m ? `${m}:${rest}` : `${s.toFixed(2)}s`;
}
