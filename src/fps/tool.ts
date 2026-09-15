import { Tool as KitTool, type Drop, type PickedUp, type ToolUse as KitToolUse } from '../crossplay/tool';
import type { AvatarSim } from './avatar';
import { Pickup, PickupKind } from './defs';

export { NO_TOOL, Toolbox } from '../crossplay/tool';
export type { Drop, DropReason, Grip, HitResult, PickedUp, StashSpot, ToolModel, ToolOptions, UseEffect } from '../crossplay/tool';

/** A Peer City tool in a hand, as its hooks see it. */
export type ToolUse = KitToolUse<AvatarSim>;

/**
 * A Peer City tool (see crossplay/tool.ts for the hooks). Picking one up says what you got, and one that's
 * dropped becomes a pickup on the street where it fell.
 */
export class Tool extends KitTool<AvatarSim> {
  override onPickup(avatar: AvatarSim, got: PickedUp): void {
    const { hud } = avatar.ctx;
    if (got.kept) hud.message(got.count === 1 ? `Picked up the ${this.name}` : got.count === 2 ? `Picked up a second ${this.name}` : `Picked up another ${this.name}`);
    else if (got.charges) hud.message(`+${got.charges} ${this.name} ${this.charges?.unit ?? ''}`.trim());
  }

  override onDrop(avatar: AvatarSim, drop: Drop): void {
    if (drop.reason !== 'dropped') return;
    avatar.ctx.world.spawn(Pickup, { x: drop.x, y: drop.y, kind: PickupKind.Tool, tool: this.id, amount: Math.min(65535, drop.charges) });
  }
}
