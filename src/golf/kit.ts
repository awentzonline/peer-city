import * as THREE from 'three';
import { box, merge, paint } from '../crossplay/models';
import { Tool, Toolbox, type ToolUse } from '../crossplay/tool';
import { CLUBS, Club } from './ball';
import type { Golfer } from './golfer';

/**
 * Peer Golf's clubs: a driver, an iron, a wedge and a putter. Each plays the ball and knocks people over.
 *
 * - On a crosshair, standing over your ball, hold the trigger to draw the club back and let go to swing: the meter
 *   rises to full and falls back if you hold on too long. Anywhere else, the trigger swings at whoever's in front.
 * - In a tracked hand, swing it for real: through your ball to play it (as hard as you swing), or into someone.
 */

export type Use = ToolUse<Golfer>;

/** How long the meter takes to fill, then to fall back to nothing, s. */
export const METER_RISE = 1.05;
export const METER_FALL = 0.9;

/** The swing meter's power `t` seconds after the club started back. */
export function meter(t: number): number {
  if (t <= METER_RISE) return t / METER_RISE;
  return Math.max(0, 1 - (t - METER_RISE) / METER_FALL);
}

interface Swing {
  /** Where the club head was last frame, in the world, and whether that's known. */
  last: { x: number; y: number; z: number };
  known: boolean;
  /** Earliest the head can hit someone again, ms. */
  next: number;
}

const swings = new WeakMap<Use, Swing>();

function swingOf(use: Use): Swing {
  let s = swings.get(use);
  if (!s) swings.set(use, (s = { last: { x: 0, y: 0, z: 0 }, known: false, next: 0 }));
  return s;
}

export class ClubTool extends Tool<Golfer> {
  constructor(
    readonly club: Club,
    stash: [number, number, number],
    build: () => THREE.BufferGeometry,
  ) {
    super({
      name: CLUBS[club].name,
      model: { build, length: 1.02 },
      // held down and forward from the hand, the head about a meter off
      grip: { tip: [0, 0, -1.0], pitch: -0.95 },
      stash: [{ at: stash, pitch: -Math.PI / 2 }],
      color: 0xdfe6e9,
      issued: 1,
      max: 1,
    });
  }

  override onUse(use: Use): void {
    if (use.side !== null) return; // tracked hands swing it for real (onHold)
    const golfer = use.avatar;
    if (golfer.addressing) golfer.drawBack();
    else golfer.swingAtPeople();
  }

  override onHold(use: Use): void {
    const golfer = use.avatar;
    if (use.side === null) {
      golfer.holdBack();
      return;
    }
    const s = swingOf(use);
    const head = use.origin;
    if (s.known) golfer.swingThrough(this.club, use, s.last, head, s);
    s.last.x = head.x;
    s.last.y = head.y;
    s.last.z = head.z;
    s.known = true;
  }

  override onRelease(use: Use): void {
    if (use.side === null) use.avatar.letGo();
  }

  override onUnequip(use: Use): void {
    swingOf(use).known = false;
    if (use.side === null) use.avatar.cancelSwing();
  }
}

// ---------------------------------------------------------------------------
// Models: tips point down -Z, tops up +Y. The grip is the origin.
// ---------------------------------------------------------------------------

const SHAFT = 0xc9d1d6;
const GRIP = 0x1f1f24;

function shaft(): THREE.BufferGeometry[] {
  return [
    paint(new THREE.CylinderGeometry(0.009, 0.006, 0.95, 6).rotateX(Math.PI / 2).translate(0, 0, -0.5), SHAFT),
    paint(new THREE.CylinderGeometry(0.014, 0.012, 0.26, 8).rotateX(Math.PI / 2).translate(0, 0, -0.08), GRIP),
  ];
}

function driverGeometry(): THREE.BufferGeometry {
  return merge([...shaft(), paint(new THREE.SphereGeometry(0.06, 10, 8).scale(1, 0.7, 1.1).translate(0.035, -0.02, -0.99), 0x2d3436), box(0.004, 0.05, 0.07, 0.095, -0.02, -0.99, 0x74b9ff)]);
}

function ironGeometry(): THREE.BufferGeometry {
  return merge([...shaft(), box(0.085, 0.05, 0.018, 0.035, -0.015, -0.985, 0xb2bec3)]);
}

function wedgeGeometry(): THREE.BufferGeometry {
  return merge([...shaft(), box(0.08, 0.06, 0.02, 0.032, -0.02, -0.985, 0xdcae62)]);
}

function putterGeometry(): THREE.BufferGeometry {
  return merge([...shaft(), box(0.11, 0.025, 0.03, 0.03, -0.035, -0.975, 0x636e72), box(0.02, 0.012, 0.012, 0.03, -0.018, -0.965, 0xffffff)]);
}

export const DRIVER = new ClubTool(Club.Driver, [0.26, -0.6, 0], driverGeometry);
export const IRON = new ClubTool(Club.Iron, [0.17, -0.56, -0.18], ironGeometry);
export const WEDGE = new ClubTool(Club.Wedge, [-0.17, -0.56, -0.18], wedgeGeometry);
export const PUTTER = new ClubTool(Club.Putter, [-0.26, -0.6, 0], putterGeometry);

/** In `Club` order, so a club's tool id is its `Club`. */
export const TOOLS = new Toolbox<ClubTool>([DRIVER, IRON, WEDGE, PUTTER]);

export function clubTool(club: Club): ClubTool {
  return TOOLS.all[club];
}
