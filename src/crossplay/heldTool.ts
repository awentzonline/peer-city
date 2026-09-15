import type { AnyAvatar } from './avatar';
import type { Side } from './intent';
import type { Vec3 } from './math';
import type { Tool, ToolUse, UseEffect } from './tool';

/**
 * One of an avatar's hands, running the hooks of the tool in it: equip and unequip as tools come and go,
 * use and release as the trigger moves, and hold every frame. Each tracked hand has one; the crosshair
 * uses the right hand's.
 */
export class HeldTool<A extends AnyAvatar = AnyAvatar> implements ToolUse<A> {
  side: Side | null = null;
  readonly origin: Vec3 = { x: 0, y: 0, z: 0 };
  readonly aim: Vec3 = { x: 1, y: 0, z: 0 };
  readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  readonly velocity: Vec3 = { x: 0, y: 0, z: 0 };
  pressedAt: number | null = null;
  private held: Tool<A> | null = null;
  private nextUse = 0;
  /** Where `origin` was last frame, relative to the feet, if it was known. */
  private readonly last: Vec3 = { x: 0, y: 0, z: 0 };
  private tracking = false;

  constructor(readonly avatar: A) {}

  get tool(): Tool<A> | null {
    return this.held;
  }

  /** Put a tool in the hand, or empty it (null). */
  hold(tool: Tool<A> | null): void {
    if (tool === this.held) return;
    this.held?.onUnequip(this);
    this.pressedAt = null;
    this.nextUse = 0; // a cooldown is the tool's, not the hand's
    this.held = tool;
    this.lose();
    tool?.onEquip(this);
  }

  /** The hand's pose isn't known this frame (untracked, or the avatar was just put somewhere), so it can't have swung. */
  lose(): void {
    this.tracking = false;
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
  }

  /** Run a frame of the tool in the hand, once `origin`, `aim` and `tip` are set. */
  update(trigger: boolean, dt: number): void {
    this.track(dt);
    const tool = this.held;
    if (!tool) {
      this.pressedAt = null;
      return;
    }
    const { now } = this.avatar;
    if (trigger) {
      const fresh = this.pressedAt === null;
      if (fresh) this.pressedAt = now;
      if ((fresh || tool.automatic) && now >= this.nextUse) {
        this.nextUse = now + tool.cooldownMs;
        tool.onUse(this);
      }
    } else if (this.pressedAt !== null) {
      tool.onRelease(this);
      this.pressedAt = null;
    }
    tool.onHold(this, dt);
  }

  spend(n = 1): void {
    if (this.held) this.avatar.spend(this.held, n);
  }

  effect(effect: UseEffect): void {
    if (this.held) this.avatar.body.used(this.side, this.held, effect);
  }

  private track(dt: number): void {
    const s = this.avatar.me?.state;
    if (!s) return;
    const rx = this.origin.x - s.x;
    const ry = this.origin.y - s.y;
    const rz = this.origin.z - this.avatar.feetZ();
    const v = this.velocity;
    if (this.tracking && dt > 0) {
      v.x = (rx - this.last.x) / dt;
      v.y = (ry - this.last.y) / dt;
      v.z = (rz - this.last.z) / dt;
    } else {
      v.x = v.y = v.z = 0;
    }
    this.last.x = rx;
    this.last.y = ry;
    this.last.z = rz;
    this.tracking = true;
  }
}
