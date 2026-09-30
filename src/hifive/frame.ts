import { updateOwnedBuddies, type TeamKeeper } from './buddies';
import type { HiContext } from './context';

/**
 * The rest of a simulation step, once the network's been received and the local role has played its intent: the team
 * keeps its buddies about, and the buddies this peer owns do their part. No DOM, so `Game` and the tests run the same frame.
 */
export function stepRules(ctx: HiContext, keeper: TeamKeeper, dt: number, now: number): void {
  keeper.update(dt, now);
  updateOwnedBuddies(ctx, dt);
}
