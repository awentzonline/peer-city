import { updateAway, updateFaults } from './away';
import type { StarshipContext } from './context';
import type { Torpedoes } from './flights';
import { updateRaiders } from './raiders';
import type { ShipKeeper } from './ship';

/**
 * The rest of a simulation step, once the network's been received and the local role has played its intent: the ship
 * flies, torpedoes run, and the raiders, faults, sentinels and relics this peer owns do their part. No DOM, so `Game` and
 * the tests run the same frame.
 */
export function stepRules(ctx: StarshipContext, keeper: ShipKeeper, torpedoes: Torpedoes, dt: number, now: number): void {
  keeper.update(dt, now);
  torpedoes.update(dt);
  updateRaiders(ctx, torpedoes, dt);
  updateFaults(ctx, dt);
  updateAway(ctx, dt);
}
