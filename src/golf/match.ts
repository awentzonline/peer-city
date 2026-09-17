import { Singleton, type NetWorld } from '@engine/index';
import type { GolferEntity, MatchEntity } from './context';
import { HOLES, type Course } from './course';
import { Ball, BallMode, Golfer, Match, Phase } from './defs';

/** The longest a hole can take, s. */
export const HOLE_SECONDS = 420;
/** Once someone's holed out, the rest have at most this long. */
export const AFTER_FIRST = 75;
export const HOLE_OVER_SECONDS = 10;
export const RESULTS_SECONDS = 20;

/** A ball is picked up after this many strokes over par. */
const PICK_UP_OVER = 5;

/**
 * The match: one migratable entity for the whole course, run by whoever owns it. It says which hole everyone's
 * playing and when that hole's over. Everyone else only reads it, and each golfer does their own part: they tee
 * their ball up on the hole they see, and score it when they hole out or the hole ends without them.
 */
export class MatchKeeper {
  private readonly one: Singleton<typeof Match>;
  /** When this peer first knew of a match, ms: carts wait a moment for the network to tell of any already out. */
  knownSince = -1;

  constructor(
    private readonly world: NetWorld,
    private readonly course: Course,
  ) {
    this.one = new Singleton(world, Match, {
      init: () => ({ x: course.holes[0].tee.x, y: course.holes[0].tee.y, phase: Phase.Playing, round: 1, hole: 0, timer: HOLE_SECONDS }),
    });
  }

  get match(): MatchEntity | null {
    return this.one.entity;
  }

  /** Make the match if nobody has, and run it if it's ours. */
  update(dt: number, now: number): void {
    const match = this.one.update(now);
    if (!match) {
      this.knownSince = -1;
      return;
    }
    if (this.knownSince < 0) this.knownSince = now;
    if (match.mine) this.run(match, dt);
  }

  private run(match: MatchEntity, dt: number): void {
    const s = match.state;
    switch (s.phase) {
      case Phase.Playing: {
        const balls = [...this.world.all(Ball)].filter((b) => b.state.round === s.round && b.state.hole === s.hole);
        const holed = balls.filter((b) => b.state.mode === BallMode.Holed).length;
        const done = holed + balls.filter((b) => b.state.mode === BallMode.Out).length;
        if (holed && !s.first) {
          s.first = true;
          s.timer = Math.min(s.timer, AFTER_FIRST);
        }
        if (!balls.length) {
          // nobody's teed up yet (or everyone's left): don't run the clock down on an empty course
          s.timer = Math.max(s.timer, Math.min(HOLE_SECONDS, 30));
          break;
        }
        s.timer = Math.max(0, s.timer - dt);
        if (done === balls.length || s.timer <= 0) this.go(match, Phase.HoleOver, HOLE_OVER_SECONDS);
        break;
      }
      case Phase.HoleOver:
        s.timer -= dt;
        if (s.timer > 0) break;
        // this peer may own the match without anyone playing near it: move it to the next tee, where they're headed
        if (s.hole + 1 >= HOLES) {
          this.go(match, Phase.Results, RESULTS_SECONDS);
        } else {
          s.hole++;
          s.first = false;
          this.moveTo(match);
          this.go(match, Phase.Playing, HOLE_SECONDS);
        }
        break;
      case Phase.Results:
        s.timer -= dt;
        if (s.timer > 0) break;
        s.round++;
        s.hole = 0;
        s.first = false;
        this.moveTo(match);
        this.go(match, Phase.Playing, HOLE_SECONDS);
        break;
    }
  }

  private moveTo(match: MatchEntity): void {
    const t = this.course.holes[match.state.hole].tee;
    match.state.x = t.x;
    match.state.y = t.y;
  }

  private go(match: MatchEntity, phase: Phase, timer: number): void {
    match.state.phase = phase;
    match.state.timer = timer;
  }
}

/**
 * The hole a golfer should be making for: the one being played, or between holes the next one (the first again
 * once a round's over). `waiting` says it hasn't started yet, so it's the tee that matters, not the pin.
 */
export function targetHole(match: { phase: Phase; hole: number }): { hole: number; waiting: boolean } {
  if (match.phase === Phase.Playing) return { hole: match.hole, waiting: false };
  if (match.phase === Phase.HoleOver && match.hole + 1 < HOLES) return { hole: match.hole + 1, waiting: true };
  return { hole: 0, waiting: true };
}

/** A ball is picked up after this many strokes on a hole. */
export function maxStrokes(par: number): number {
  return par + PICK_UP_OVER;
}

/** What a hole scores for a golfer who didn't finish it: at least two more than they'd taken, and never under a triple bogey. */
export function unfinishedScore(par: number, strokes: number): number {
  return Math.min(maxStrokes(par), Math.max(strokes + 2, par + 3));
}

/** Strokes over (+) or under (-) par for the holes a card has played. */
export function toPar(card: Uint8Array, course: Course): number {
  let total = 0;
  for (let h = 0; h < HOLES; h++) if (card[h]) total += card[h] - course.holes[h].par;
  return total;
}

export function holesPlayed(card: Uint8Array): number {
  let n = 0;
  for (let h = 0; h < HOLES; h++) if (card[h]) n++;
  return n;
}

export function formatToPar(n: number): string {
  return n === 0 ? 'E' : n > 0 ? `+${n}` : String(n);
}

/** A hole's score in words. */
export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return 'Hole in one!';
  const names: Record<number, string> = { [-3]: 'Albatross', [-2]: 'Eagle', [-1]: 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double bogey', 3: 'Triple bogey' };
  const d = strokes - par;
  return names[d] ?? (d < 0 ? `${-d} under` : `${d} over par`);
}

/** Golfers playing a round, best first: lowest to par, then whoever's played more holes. */
export function standings(world: NetWorld, round: number, course: Course): GolferEntity[] {
  const list = [...world.all(Golfer)].filter((g) => g.state.round === round);
  return list.sort((a, b) => {
    const pa = toPar(a.state.card, course);
    const pb = toPar(b.state.card, course);
    if (pa !== pb) return pa - pb;
    const ha = holesPlayed(a.state.card);
    const hb = holesPlayed(b.state.card);
    if (ha !== hb) return hb - ha;
    return a.state.name < b.state.name ? -1 : 1;
  });
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
