import type { AvatarSim } from './avatar';
import type { Vec3 } from './context';
import type { Side } from './intent';
import type { Tool, ToolUse, UseEffect } from './tool';

/**
 * One of an avatar's hands, running the hooks of the tool in it: equip and unequip as tools come and go,
 * use and release as the trigger moves, and hold every frame. Each tracked hand has one; the crosshair
 * uses the right hand's.
 */
export class HeldTool implements ToolUse {
  side: Side | null = null;
  readonly origin: Vec3 = { x: 0, y: 0, z: 0 };
  readonly aim: Vec3 = { x: 1, y: 0, z: 0 };
  readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  pressedAt: number | null = null;
  private held: Tool | null = null;
  private nextUse = 0;

  constructor(readonly avatar: AvatarSim) {}

  get tool(): Tool | null {
    return this.held;
  }

  /** Put a tool in the hand, or empty it (null). */
  hold(tool: Tool | null): void {
    if (tool === this.held) return;
    this.held?.onUnequip(this);
    this.pressedAt = null;
    this.held = tool;
    tool?.onEquip(this);
  }

  /** Run a frame of the tool in the hand, once `origin`, `aim` and `tip` are set. */
  update(trigger: boolean, dt: number): void {
    const tool = this.held;
    if (!tool) {
      this.pressedAt = null;
      return;
    }
    const { now } = this.avatar.ctx;
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
}
