import type { HauntContext } from './context';
import { Phase } from './defs';
import { updateOwnedKeys } from './keys';
import { updateOwnedMonsters } from './monsters';
import type { RoundKeeper } from './round';

/**
 * The rest of a simulation step, once the network's been received and the local role has played its intent: the night
 * moves on, the gate opens once the pedestal's full, keys and monsters this peer owns do their part, and the Haunt's
 * view of who's where catches up. No DOM, so `Game` and the tests run the same frame.
 */
export function stepRules(ctx: HauntContext, keeper: RoundKeeper, dt: number, now: number): void {
  keeper.update(dt, now);
  const round = keeper.round?.state;
  ctx.manor.gateOpen = !!round && round.phase !== Phase.Waiting && round.placed >= round.needed;
  updateOwnedKeys(ctx);
  updateOwnedMonsters(ctx, dt);
}
