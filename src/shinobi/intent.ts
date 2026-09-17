import { idleIntent, stillIntent, type AvatarIntent } from '../crossplay/intent';

/**
 * What a shinobi wants this frame: an avatar's, and whether they're reaching up to climb. A virtual head climbs a wall or
 * roof in front of it while `climb` is held; tracked hands climb by gripping one and pulling (`HandIntent.grab`).
 * The trigger strikes with the tanto, or throws a kunai or shuriken: in a tracked hand, letting go of the trigger throws
 * it the way the hand was moving.
 */
export interface ShinobiIntent extends AvatarIntent {
  /** Climb what's in front of you (held), or jump if there's nothing to climb. */
  climb: boolean;
}

export function idleShinobiIntent(): ShinobiIntent {
  return { ...idleIntent(), climb: false };
}

export function stillShinobi(intent: ShinobiIntent): ShinobiIntent {
  stillIntent(intent);
  intent.climb = false;
  return intent;
}

/** What the captain can call on, beyond ordering guards about. */
export const enum Call {
  /** Light braziers somewhere: nobody hides in their light. */
  Braziers = 0,
  /** Ring the alarm bell: every guard's on the alert for a while. */
  Bell = 1,
  /** Turn out two more guards from the barracks, to search where you point. */
  Reinforce = 2,
  /** Send the lord (and his bodyguard) somewhere else. */
  MoveLord = 3,
}

export interface GroundPoint {
  x: number;
  y: number;
}

/**
 * What the captain wants this frame, in terms of the castle rather than a screen, a finger or a laser: where they look,
 * where they point on the ground, and a few things to do there.
 */
export interface CaptainIntent {
  /** The ground in the middle of the view: what they're paying attention to. */
  focus: GroundPoint;
  /** The ground pointed at, or null. */
  pointer: GroundPoint | null;
  /** How near the pointer counts as on something, m. */
  reach: number;
  /**
   * Act at the pointer: use the armed call there, or else pick out (or let go of) a guard under it, or else send the guards
   * picked out to search there.
   */
  primary: boolean;
  /** Send the picked-out guards to search at the pointer, or put the armed call away. */
  secondary: boolean;
  /** Arm a call to use with `primary`, or 'none' to put it away. Null changes nothing. */
  arm: Call | 'none' | null;
  /** Pick out every guard near the pointer, instead of what was picked out. */
  gather: boolean;
  /** Pick out these guards (by id), found by the device. `add` keeps what was picked out. */
  select: { ids: number[]; add: boolean } | null;
  /** Pick out every guard that takes orders, or let them all go if they already are. */
  selectAll: boolean;
  /** Tell the picked-out guards to stand watch at the pointer. */
  post: boolean;
  /** Send the picked-out guards back to their routes and posts. */
  dismiss: boolean;
}

export function idleCaptainIntent(): CaptainIntent {
  return { focus: { x: 48, y: 48 }, pointer: null, reach: 1.5, primary: false, secondary: false, arm: null, gather: false, select: null, selectAll: false, post: false, dismiss: false };
}

/** Clear what a frontend sets afresh every frame, keeping where it looks and points. */
export function stillCaptain(intent: CaptainIntent): CaptainIntent {
  intent.primary = intent.secondary = intent.gather = intent.selectAll = intent.post = intent.dismiss = false;
  intent.arm = null;
  intent.select = null;
  return intent;
}
