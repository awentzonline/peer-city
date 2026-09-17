import { idleIntent, type AvatarIntent } from '../crossplay/intent';

/**
 * What a survivor wants this frame: an avatar's. The trigger switches the flashlight in hand on or off, and `interact`,
 * held, helps up a downed survivor in front of you. Keys are picked up and put in the pedestal by walking up to them.
 */
export type SurvivorIntent = AvatarIntent;

export function idleSurvivorIntent(): SurvivorIntent {
  return idleIntent();
}

/** The Haunt's powers, by what they cost in dread. The first three summon a monster of that `MonsterKind`. */
export const enum Power {
  Shade = 0,
  Crawler = 1,
  Brute = 2,
  /** A whisper somewhere in the house: the Haunt's monsters come to it, and the lights near it go out. */
  Whisper = 3,
}

export interface GroundPoint {
  x: number;
  y: number;
}

/**
 * What the Haunt wants this frame, in terms of the house rather than a screen, a finger or a laser. Every device looks
 * somewhere and points somewhere on the ground, and does one of a few things there.
 */
export interface HauntIntent {
  /** The ground in the middle of its view: what it's paying attention to. */
  focus: GroundPoint;
  /** The ground it's pointing at, or null. Survivors feel a presence there. */
  pointer: GroundPoint | null;
  /** How near the pointer counts as on something, m: a fingertip covers more ground than a mouse pointer. */
  reach: number;
  /**
   * Act at the pointer: use the armed power there, or else pick out (or let go of) one of your monsters under it, or
   * else send the monsters you've picked out there (after a survivor, if one's under it).
   */
  primary: boolean;
  /** Send the monsters you've picked out to the pointer, or put the armed power away. */
  secondary: boolean;
  /** Arm a power to use with `primary`, or 'none' to put it away. Null changes nothing. */
  arm: Power | 'none' | null;
  /** Pick out every one of your monsters near the pointer, instead of what was picked out. */
  gather: boolean;
  /** Pick out these monsters (by id), found by the device, e.g. in a box dragged on a screen. `add` keeps what was picked out. */
  select: { ids: number[]; add: boolean } | null;
  /** Pick out all your monsters, or let them all go if they already are. */
  selectAll: boolean;
}

export function idleHauntIntent(): HauntIntent {
  return { focus: { x: 40, y: 40 }, pointer: null, reach: 1.5, primary: false, secondary: false, arm: null, gather: false, select: null, selectAll: false };
}

/** Clear what a frontend sets afresh every frame, keeping where it looks and points. */
export function stillHaunt(intent: HauntIntent): HauntIntent {
  intent.primary = intent.secondary = intent.gather = intent.selectAll = false;
  intent.arm = null;
  intent.select = null;
  return intent;
}
