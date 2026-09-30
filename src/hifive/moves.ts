import { clamp, type Vec3 } from '../crossplay/math';

/**
 * The moves, how they're held out and hit, and what they're worth. No DOM, no network: the rules, the views and the
 * tests all read these.
 */

export const enum Move {
  None = 0,
  /** Up high: one hand over your head. */
  High = 1,
  /** Down low: one hand out at your hip, palm up. */
  Low = 2,
  /** A fist bump: a fist out at your chest. */
  Fist = 3,
  /** Double up top: both hands over your head. */
  Double = 4,
}

export const MOVES: readonly Move[] = [Move.High, Move.Low, Move.Fist, Move.Double];

export const MOVE_NAMES: Record<Move, string> = {
  [Move.None]: '',
  [Move.High]: 'Up high',
  [Move.Low]: 'Down low',
  [Move.Fist]: 'Fist bump',
  [Move.Double]: 'Double up top',
};

/** How a five went, best first. */
export const enum Grade {
  Perfect = 0,
  Great = 1,
  Good = 2,
  /** A headset hand that barely moved: it counts, just. */
  Limp = 3,
  /** Swung at nothing: the offer was gone, or the timing was way off. */
  Whiff = 4,
  /** Swung at an offer that was pulled away. The one who pulled it gets the points. */
  TooSlow = 5,
  /** The wrong move: a fist into an open palm. */
  Awkward = 6,
}

export const GRADE_NAMES: Record<Grade, string> = {
  [Grade.Perfect]: 'PERFECT!',
  [Grade.Great]: 'GREAT!',
  [Grade.Good]: 'NICE',
  [Grade.Limp]: 'LIMP…',
  [Grade.Whiff]: 'WHIFF',
  [Grade.TooSlow]: 'TOO SLOW!',
  [Grade.Awkward]: 'AWKWARD…',
};

/** A five that landed and keeps a combo going. */
export function clean(grade: Grade): boolean {
  return grade <= Grade.Limp;
}

// ---------------------------------------------------------------------------
// Timing, for keys and fingers
// ---------------------------------------------------------------------------

/** One turn of the timing ring, ms: it closes in on the target and starts again. */
export const RING_MS = 1000;
/** Where in its turn the ring's on the target, 0..1. */
export const RING_HIT = 0.75;

/** How far the ring is through its turn, `ms` after it started. */
export function ringPhase(ms: number): number {
  return (((ms % RING_MS) + RING_MS) % RING_MS) / RING_MS;
}

/** How far off the target a press at `phase` was, ms, whichever turn it was nearest. */
export function ringError(phase: number): number {
  const e = Math.abs(phase - RING_HIT);
  return Math.min(e, 1 - e) * RING_MS;
}

/** How a timed swing went, by how far off the ring's target it was, ms. */
export function timingGrade(errorMs: number): Grade {
  if (errorMs <= 55) return Grade.Perfect;
  if (errorMs <= 115) return Grade.Great;
  if (errorMs <= 200) return Grade.Good;
  return Grade.Whiff;
}

// ---------------------------------------------------------------------------
// Speed, for tracked hands
// ---------------------------------------------------------------------------

/** A tracked hand moving slower than this, m/s, is only resting against someone else's. */
export const MIN_SWING = 0.8;

/** How a tracked hand's five went, by how fast it was moving, m/s. */
export function speedGrade(speed: number): Grade {
  if (speed >= 3.4) return Grade.Perfect;
  if (speed >= 2.3) return Grade.Great;
  if (speed >= 1.4) return Grade.Good;
  return Grade.Limp;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const BASE: Record<Grade, number> = {
  [Grade.Perfect]: 100,
  [Grade.Great]: 70,
  [Grade.Good]: 40,
  [Grade.Limp]: 15,
  [Grade.Whiff]: 0,
  [Grade.TooSlow]: 50,
  [Grade.Awkward]: 5,
};

/** A double's worth half as much again: it's two fives. */
const MOVE_BONUS: Record<Move, number> = {
  [Move.None]: 1,
  [Move.High]: 1,
  [Move.Low]: 1,
  [Move.Fist]: 1,
  [Move.Double]: 1.5,
};

/** The combo multiplier: a quarter more for each five in a row with the same person, up to three times. */
export function comboMultiplier(streak: number): number {
  return Math.min(3, 1 + 0.25 * Math.max(0, streak - 1));
}

/** What a five's worth to each of the pair (a too-slow only to the one who pulled away). */
export function scoreFor(grade: Grade, move: Move, streak: number, air: boolean): number {
  if (!clean(grade)) return BASE[grade];
  return Math.round(BASE[grade] * MOVE_BONUS[move] * comboMultiplier(streak) * (air ? 1.5 : 1));
}

/** A slap on the backside, or the turning round that denied it. */
export const SLAP_POINTS = 60;
export const DENY_POINTS = 40;

/** A pair's combo lapses after this long without a five, ms. */
export const COMBO_MS = 15_000;

export interface PairMemory {
  streak: number;
  /** When their last five was, ms. */
  at: number;
  move: Move;
}

/**
 * A pair's combo after a five: one more for a clean five soon enough after the last, as long as it's a different move
 * (mix it up), the same again for the same move, and back to nothing for anything else.
 */
export function nextStreak(prev: PairMemory | undefined, now: number, move: Move, grade: Grade): number {
  if (!clean(grade)) return 0;
  if (!prev || prev.streak === 0 || now - prev.at > COMBO_MS) return 1;
  return move === prev.move ? prev.streak : prev.streak + 1;
}

/** Every pair's combo, as far as this peer has heard: whoever swings next reads it, and everyone hears the result. */
export class Pairs {
  private readonly pairs = new Map<string, PairMemory>();

  static key(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  get(a: number, b: number): PairMemory | undefined {
    return this.pairs.get(Pairs.key(a, b));
  }

  set(a: number, b: number, memory: PairMemory): void {
    this.pairs.set(Pairs.key(a, b), memory);
  }

  /** Whether the pair had a five this recently, ms: a second report of the same one. */
  recent(a: number, b: number, now: number, withinMs: number): boolean {
    const p = this.get(a, b);
    return !!p && now - p.at < withinMs;
  }

  /** The pair's combo as it stands now (it lapses without a five). */
  streak(a: number, b: number, now: number): number {
    const p = this.get(a, b);
    return p && now - p.at <= COMBO_MS ? p.streak : 0;
  }
}

// ---------------------------------------------------------------------------
// Where hands go
// ---------------------------------------------------------------------------

/** A hand's pose relative to the body: `f` in front, `s` to the right, `z` above the feet. */
export interface HandPose {
  f: number;
  s: number;
  z: number;
}

/** Hands down by the sides. */
export const REST: HandPose = { f: 0.05, s: 0.32, z: 0.82 };

/**
 * Where the (right) hand goes to hold out a move, for someone whose eyes are `eye` above their feet. A double holds
 * the left out the same, mirrored.
 */
export function offerPose(move: Move, eye: number, out: HandPose = { f: 0, s: 0, z: 0 }): HandPose {
  switch (move) {
    case Move.High:
      return Object.assign(out, { f: 0.3, s: 0.2, z: eye + 0.3 });
    case Move.Low:
      return Object.assign(out, { f: 0.45, s: 0.14, z: Math.min(0.92, eye * 0.56) });
    case Move.Fist:
      return Object.assign(out, { f: 0.5, s: 0.12, z: eye * 0.76 });
    case Move.Double:
      return Object.assign(out, { f: 0.3, s: 0.26, z: eye + 0.3 });
    default:
      return Object.assign(out, REST);
  }
}

/** A pose relative to a body at (x, y) facing `heading` (with its feet `feet` up) as a world point. `mirror` for the left hand. */
export function posePoint(x: number, y: number, feet: number, heading: number, pose: HandPose, mirror: boolean, out: Vec3): Vec3 {
  const c = Math.cos(heading);
  const sn = Math.sin(heading);
  const s = mirror ? -pose.s : pose.s;
  // forward is (cos, sin); right is (-sin, cos)
  out.x = x + c * pose.f - sn * s;
  out.y = y + sn * pose.f + c * s;
  out.z = feet + pose.z;
  return out;
}

/** Where a backside is: behind the hips of someone at (x, y) facing `heading`. */
export function buttPoint(x: number, y: number, feet: number, heading: number, out: Vec3): Vec3 {
  out.x = x - Math.cos(heading) * 0.17;
  out.y = y - Math.sin(heading) * 0.17;
  out.z = feet + 0.93;
  return out;
}

/**
 * How far round from where someone at (x, y) faces `heading` a point at (px, py) is, radians: 0 straight in front,
 * π straight behind.
 */
export function bearingFrom(x: number, y: number, heading: number, px: number, py: number): number {
  const a = Math.atan2(py - y, px - x) - heading;
  return Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
}

/** Behind someone: far enough round that they can't see you without turning. */
export const BEHIND = (105 * Math.PI) / 180;
/** Facing someone: near enough in front that they've seen you coming. */
export const FACING = (80 * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Reading a headset player's hands
// ---------------------------------------------------------------------------

/** A tracked hand, relative to the feet, for `classifyHands`. */
export interface TrackedHand {
  tracked: boolean;
  /** Relative to the feet, world axes. */
  x: number;
  y: number;
  z: number;
  /** Squeezing the grip: a fist. */
  fist: boolean;
  /** m/s. */
  speed: number;
}

/** What a headset player's hands are holding out, and whether a one-handed offer's in the left. */
export interface ReadOffer {
  move: Move;
  left: boolean;
}

/** Held still enough to be an offer rather than a swing, m/s. */
const STILL = 1.3;

/**
 * Read a headset player's hands as an offer: a hand held still over their head is up high (both is a double), one out
 * in front low down is down low, and a fist out in front at chest height is a fist bump. `eye` is the eyes' height
 * above the feet, `heading` where they face; hands are `[right, left]`.
 */
export function classifyHands(eye: number, heading: number, hands: readonly [TrackedHand, TrackedHand]): ReadOffer {
  const kinds = hands.map((h) => handKind(eye, heading, h));
  if (kinds[0] === Move.High && kinds[1] === Move.High) return { move: Move.Double, left: false };
  // prefer the right hand; either on its own is an offer
  for (const side of [0, 1]) if (kinds[side] !== Move.None) return { move: kinds[side], left: side === 1 };
  return { move: Move.None, left: false };
}

function handKind(eye: number, heading: number, h: TrackedHand): Move {
  if (!h.tracked || h.speed > STILL) return Move.None;
  const forward = h.x * Math.cos(heading) + h.y * Math.sin(heading);
  const high = h.z > eye - 0.02;
  if (high) return h.fist ? Move.None : Move.High;
  if (forward < 0.3) return Move.None;
  if (h.fist) return h.z > eye * 0.6 ? Move.Fist : Move.None;
  return h.z < clamp(eye * 0.62, 0.8, 1.05) ? Move.Low : Move.None;
}

/**
 * The move a five between two tracked hands was, when nobody was offering one: by where they met (`z` above the
 * swinger's feet) and whether it was a fist.
 */
export function moveAt(z: number, eye: number, fist: boolean): Move {
  if (fist) return Move.Fist;
  if (z < eye * 0.6) return Move.Low;
  return Move.High;
}
