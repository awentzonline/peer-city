import type { ShinobiContext } from './context';
import { updateOwnedGuards } from './guards';
import { updateOwnedThings, type RoundKeeper } from './round';

/**
 * The rest of a simulation step, once the network's been received and the local role has played its intent: the night
 * moves on, blades and arrows fly, and the guards, blades and braziers this peer owns do their part. No DOM, so `Game`
 * and the tests run the same frame.
 */
export function stepRules(ctx: ShinobiContext, keeper: RoundKeeper, dt: number, now: number): void {
  keeper.update(dt, now);
  ctx.flights.update(dt);
  updateOwnedGuards(ctx, dt);
  updateOwnedThings(ctx, dt);
}
