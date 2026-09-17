import { Side, type HandIntent } from './intent';
import type { Vec3 } from './math';

/**
 * Climbing with tracked hands, hand over hand. An empty hand that squeezes its grip on something that can be held
 * (`canHold`) takes hold of that spot, and while it holds on the body moves so the hand stays put: pull down and you go
 * up, push the wall away and you come off it, reach over the top and pull and you're over. Two hands holding average
 * their pulls. No DOM or three.js: it works on `HandIntent`s, so the rules run it and it's tested headless.
 *
 * A game applies `update`'s pull to its avatar (moving the play space with it, as for anything that moves the body), and
 * stops gravity while `holding`.
 */
export class HandClimb {
  private readonly anchors: [Vec3 | null, Vec3 | null] = [null, null];

  /** Whether either hand is holding on. */
  get holding(): boolean {
    return !!(this.anchors[Side.Right] || this.anchors[Side.Left]);
  }

  /** Whether a hand is holding on. */
  holds(side: Side): boolean {
    return !!this.anchors[side];
  }

  /**
   * Take hold, keep holding, or let go, from this frame's hands. `out` gets how far the body should move, in world axes,
   * so the holding hands stay where they took hold. Returns whether any hand holds on. `took` is called for each hand as
   * it takes hold, for a buzz.
   */
  update(hands: [HandIntent, HandIntent] | null, canHold: (p: Vec3) => boolean, out: Vec3, took?: (side: Side) => void): boolean {
    out.x = out.y = out.z = 0;
    let n = 0;
    for (const side of [Side.Right, Side.Left]) {
      const hand = hands?.[side];
      if (!hand || !hand.tracked || !hand.grab || hand.tool) {
        this.anchors[side] = null;
        continue;
      }
      let anchor = this.anchors[side];
      if (!anchor) {
        if (!canHold(hand.grip)) continue;
        anchor = this.anchors[side] = { x: hand.grip.x, y: hand.grip.y, z: hand.grip.z };
        took?.(side);
      }
      out.x += anchor.x - hand.grip.x;
      out.y += anchor.y - hand.grip.y;
      out.z += anchor.z - hand.grip.z;
      n++;
    }
    if (n > 1) {
      out.x /= n;
      out.y /= n;
      out.z /= n;
    }
    return n > 0;
  }

  /**
   * The body was moved by something other than the hands (pushed out of a wall, stopped by the ground): shift the
   * anchors by what the pull couldn't do, so a hand doesn't keep pulling against it.
   */
  slip(dx: number, dy: number, dz: number): void {
    for (const a of this.anchors) {
      if (!a) continue;
      a.x += dx;
      a.y += dy;
      a.z += dz;
    }
  }

  /** Let go with both hands, e.g. when the avatar's knocked down or put somewhere else. */
  release(): void {
    this.anchors[0] = this.anchors[1] = null;
  }
}
