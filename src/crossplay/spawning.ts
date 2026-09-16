import type { EntityDef, NetWorld } from '@engine/index';

/**
 * Populating a world with no server to decide who spawns what. Every peer tops up the neighbourhood around its
 * own focus from what it can see, and two rules keep that from going wrong:
 *
 * - Take your share: spawn with probability `spawnShare(...)` (times a rate), so ten players standing together
 *   spawn about as much as one would, not ten times as much.
 * - Don't spawn in view: skip spots `seenByOthers`, so nothing pops into existence in front of someone.
 *
 * The engine's `cullDistance` then removes what nobody's near, and rebalancing hands NPCs to the peer the
 * region's authority hash picks.
 */

/** The fraction of the spawning near a point this peer should do: 1 alone, 1/n with n players there. */
export function spawnShare(world: NetWorld, x: number, y: number, radius: number, players: EntityDef<any>): number {
  return 1 / Math.max(1, world.count(x, y, radius, players));
}

/** Whether another peer is looking from within `radius` of a point. */
export function seenByOthers(world: NetWorld, x: number, y: number, radius: number): boolean {
  for (const f of world.peerFoci()) if (Math.hypot(f.x - x, f.y - y) < radius) return true;
  return false;
}
