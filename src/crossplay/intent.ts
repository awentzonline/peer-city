import type { Vec3 } from './math';
import type { Tool } from './tool';

/** A hand's index in `AvatarIntent.hands`. In replicated state the right hand holds `tool`, the left `ltool`. */
export const enum Side {
  Right = 0,
  Left = 1,
}

/** A headset's pose, in world axes. */
export interface TrackedHead extends Vec3 {
  /** `z` is the eyes' height in the world: the ground under the play space, plus the player's real height or crouch. */
  heading: number;
  pitch: number;
}

export interface HandIntent {
  /** A controller is tracking this hand. An untracked hand keeps its last replicated pose. */
  tracked: boolean;
  /** World position of the grip, and the unit direction the hand points. */
  grip: Vec3;
  pointing: Vec3;
  /**
   * World position of the tip of the tool in the hand, and the unit direction the tool points. They
   * differ from the grip's by how the tool sits in the hand (`Tool.grip`). An empty hand's are the grip's.
   */
  tip: Vec3;
  aim: Vec3;
  /** The tool in the hand, or null. The device decides, e.g. by grabbing one out of a holster. */
  tool: Tool<any> | null;
  trigger: boolean;
  /** An empty hand is closing on something in the world, not on anything it carries: reaching out to take hold of it. */
  grab: boolean;
}

/**
 * What the player of an avatar wants this frame, in terms of the body rather than any device's controls.
 * A frontend fills one in (see role.ts) and the avatar's rules apply it. Games add to it.
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
   * Tracked hands, by `Side`: each uses the tool it holds wherever it points. Null for a crosshair: the
   * selected tool is used from the eyes through the middle of the view.
   */
  hands: [HandIntent, HandIntent] | null;
  /** -1..1 relative to where the head faces. */
  strafe: number;
  forward: number;
  run: boolean;
  /** A virtual head crouches: lower, and slower. Tracked heads crouch for real. */
  crouch: boolean;
  jump: boolean;
  /** Act on whatever's in front of you: a car door, a crop to pull. */
  interact: boolean;
  /** Crosshair trigger. */
  trigger: boolean;
  /**
   * A unit direction to use the crosshair tool along instead of through the middle of the view, e.g. where a
   * touch screen was tapped. Null for the middle.
   */
  aim: Vec3 | null;
  /** Where the crosshair tool's tip is seen (a first-person model), for effects such as tracers, or null for the eyes. */
  tip: Vec3 | null;
  /** Crosshair: step through the tools carried (-1, 0 or 1), or take one out. */
  cycleTool: number;
  selectTool: Tool<any> | null;
}

const vec = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export function handIntent(): HandIntent {
  return { tracked: false, grip: vec(), pointing: { x: 1, y: 0, z: 0 }, tip: vec(), aim: { x: 1, y: 0, z: 0 }, tool: null, trigger: false, grab: false };
}

/**
 * Clear what the player's asking the body to do this frame (looking, moving, using, switching tools), keeping the
 * device's poses (`head`, `hands`, `tip`). For a frontend whose player is busy with a menu, or starting a frame.
 * A game's own fields are the game's to clear.
 */
export function stillIntent<I extends AvatarIntent>(intent: I): I {
  intent.turn = intent.lookUp = intent.strafe = intent.forward = 0;
  intent.run = intent.crouch = intent.jump = intent.interact = intent.trigger = false;
  intent.aim = null;
  intent.cycleTool = 0;
  intent.selectTool = null;
  return intent;
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
    crouch: false,
    jump: false,
    interact: false,
    trigger: false,
    aim: null,
    tip: null,
    cycleTool: 0,
    selectTool: null,
  };
}
