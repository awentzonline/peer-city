import type { Weapon } from './arsenal';
import type { Vec3 } from './context';

/** A hand's index in `AvatarIntent.hands`. In replicated state the right hand holds `weapon`, the left `lweapon`. */
export const enum Side {
  Right = 0,
  Left = 1,
}

/** A headset's pose, in world axes. */
export interface TrackedHead extends Vec3 {
  /** `z` is the eyes' height above the ground: the player's real height, or crouching. */
  heading: number;
  pitch: number;
}

export interface HandIntent {
  /** A controller is tracking this hand. An untracked hand keeps its last replicated pose. */
  tracked: boolean;
  /** World position of the grip. */
  grip: Vec3;
  /** Unit direction the hand points. */
  aim: Vec3;
  /** World position of the muzzle of the gun in the hand. */
  muzzle: Vec3;
  /** The gun in the hand, or null. The device decides, e.g. by grabbing one out of a holster. */
  weapon: Weapon | null;
  trigger: boolean;
}

/**
 * What the player of an avatar wants this frame, in terms of the body rather than any device's controls.
 * A frontend fills one in (see role.ts) and `AvatarSim` applies it.
 */
export interface AvatarIntent {
  /**
   * A tracked headset. The avatar stands and looks wherever it is, so walking round your room walks.
   * Null for a virtual head at eye height, turned by `turn` and `lookUp`.
   */
  head: TrackedHead | null;
  /** Radians to add to a virtual head's heading and pitch this frame. */
  turn: number;
  lookUp: number;
  /**
   * Tracked hands, by `Side`: each fires the gun it holds wherever it points. Null for a crosshair: the
   * selected gun fires from the eyes through the middle of the view.
   */
  hands: [HandIntent, HandIntent] | null;
  /** -1..1 relative to where the head faces. On foot that's walking; in a car, steering and throttle. */
  strafe: number;
  forward: number;
  run: boolean;
  jump: boolean;
  /** Handbrake. */
  brake: boolean;
  horn: boolean;
  /** Get into or out of a car. */
  interact: boolean;
  /** Crosshair trigger. */
  fire: boolean;
  /** Where a crosshair shot's tracer appears to leave from (a first-person gun model), or null for the eyes. */
  tracerFrom: Vec3 | null;
  /** Crosshair: step through the guns carried (-1, 0 or 1), or take one out. */
  cycleWeapon: number;
  selectWeapon: Weapon | null;
}

const vec = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export function handIntent(): HandIntent {
  return { tracked: false, grip: vec(), aim: { x: 1, y: 0, z: 0 }, muzzle: vec(), weapon: null, trigger: false };
}

/** Nothing pressed, with a virtual head and a crosshair. Frontends keep one and overwrite it every frame. */
export function idleIntent(): AvatarIntent {
  return {
    head: null,
    turn: 0,
    lookUp: 0,
    hands: null,
    strafe: 0,
    forward: 0,
    run: false,
    jump: false,
    brake: false,
    horn: false,
    interact: false,
    fire: false,
    tracerFrom: null,
    cycleWeapon: 0,
    selectWeapon: null,
  };
}
