import { idleIntent, type AvatarIntent } from '../crossplay/intent';

/**
 * What a player of Peer Golf wants this frame: an avatar's (walking the course, swinging a club), plus playing their
 * ball and driving a cart. Cart fields only matter while seated in one.
 */
export interface GolfIntent extends AvatarIntent {
  /** Stand over your ball to play it, or step away from it (a crosshair's golfer; they also do it walking up to it). */
  address: boolean;
  /**
   * The power a crosshair swing at the ball goes with when it's let go, 0..1, from a device that measures it itself
   * (a finger pulled back). Null to use the rules' swing meter, which runs while the trigger's held.
   */
  power: number | null;
  /** Driving: -1..1, + forward. */
  throttle: number;
  /** -1..1, + left. */
  steer: number;
  brake: boolean;
}

export function idleGolfIntent(): GolfIntent {
  return { ...idleIntent(), address: false, power: null, throttle: 0, steer: 0, brake: false };
}

/** Clear the golf fields a frontend sets every frame. */
export function stillGolf(intent: GolfIntent): GolfIntent {
  intent.address = intent.brake = false;
  intent.power = null;
  intent.throttle = intent.steer = 0;
  return intent;
}
