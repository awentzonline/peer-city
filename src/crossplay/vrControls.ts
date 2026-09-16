import { GRIP_IN_HAND, type Holsters } from './holsters';
import type { HandIntent, TrackedHead } from './intent';
import type { Rig, XRHand } from './rig';

/** A stick reading with its resting wobble taken out. */
export function deadzone(v: number, dead = 0.15): number {
  return Math.abs(v) < dead ? 0 : v;
}

/**
 * Snap turning: push the stick over and the play space turns a step about your head; let it come back to the
 * middle before the next. The rules never turn a headset, they just see it face a new way.
 */
export class SnapTurn {
  private armed = true;

  constructor(readonly step = Math.PI / 6) {}

  update(rig: Rig, stickX: number): void {
    if (this.armed && Math.abs(stickX) > 0.7) {
      rig.rotateAroundHead(stickX > 0 ? -this.step : this.step);
      this.armed = false;
    } else if (Math.abs(stickX) < 0.3) {
      this.armed = true;
    }
  }
}

/** Where the headset is and which way it faces, in world axes: an `AvatarIntent.head`. */
export function readHead(rig: Rig, out: TrackedHead): TrackedHead {
  rig.head(out);
  out.heading = rig.headHeading();
  out.pitch = rig.headPitch();
  return out;
}

/**
 * A tracked hand into its intent: what its holsters put in it, its trigger (pulled past `trigger`), an empty
 * hand closing on something, and where its grip and the tip of its tool are and point.
 */
export function readHand(rig: Rig, holsters: Holsters, hand: XRHand, out: HandIntent, trigger = 0.6): HandIntent {
  out.tracked = hand.connected;
  out.tool = holsters.held(hand);
  out.trigger = hand.trigger >= trigger;
  out.grab = holsters.grabbing(hand);
  if (!hand.connected) return out;
  rig.handPose(hand, GRIP_IN_HAND, out.grip, out.pointing);
  rig.handPose(hand, holsters.tip(hand), out.tip, out.aim, holsters.forward(hand));
  return out;
}

/**
 * Keeps your real floor on the ground under the avatar in a world with hills, easing over bumps so it doesn't
 * jitter, and jumping straight there at first or after a big drop.
 */
export class FollowGround {
  private placed = false;

  update(rig: Rig, groundZ: number, dt: number): void {
    const target = rig.floorY + groundZ;
    const root = rig.root.position;
    if (!this.placed || Math.abs(target - root.y) > 2) root.y = target;
    else root.y += (target - root.y) * Math.min(1, dt * 10);
    this.placed = true;
  }

  /** Jump straight to the ground next time, e.g. once the avatar's been put somewhere else. */
  reset(): void {
    this.placed = false;
  }
}
