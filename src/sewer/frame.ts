import type { SewerContext } from './context';
import { updateOwnedGoblins } from './goblins';
import { updateOwnedLoot } from './loot';
import type { DiveKeeper } from './round';

/**
 * The rest of a simulation step, once the network's been received and the local role has played its intent: the dive
 * and the water move on, the fatberg catches up with its chunks (and its owners knock out loose lumps), and goblins and
 * loot this peer owns do their part. No DOM, so `Game` and the tests run the same frame.
 */
export function stepRules(ctx: SewerContext, keeper: DiveKeeper, dt: number, now: number): void {
  keeper.update(dt, now);
  const dive = keeper.sewer?.render.dive ?? 0;
  ctx.plug.sync(ctx.world, dive);
  ctx.plug.updateOwned(ctx.world, dive, now);
  updateOwnedGoblins(ctx, dt);
  updateOwnedLoot(ctx);
}
