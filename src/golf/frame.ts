import { keepCarts } from './carts';
import type { GolfContext } from './context';
import type { Golfer } from './golfer';
import type { MatchKeeper } from './match';

/** The parts of Peer Golf's rules that move on every simulation step. */
export interface GolfRules {
  golfer: Golfer;
  keeper: MatchKeeper;
}

/** How long a peer waits after first seeing the match before it makes carts, ms: long enough to hear of any already out. */
const CART_SETTLE_MS = 2500;

/**
 * The rest of a simulation step, once the network's been received and the local golfer has played its intent: the
 * match moves on, the carts are kept, everyone else's carts follow their owners, the cart physics steps, and the
 * golfer reacts to what it did. No DOM, so `Game` and the tests run the same frame.
 */
export function stepRules(ctx: GolfContext, rules: GolfRules, dt: number, now: number): void {
  const { keeper } = rules;
  keeper.update(dt, now);
  const match = keeper.match;
  keepCarts(ctx.world, ctx.carts, !!match?.mine && now - keeper.knownSince > CART_SETTLE_MS);
  ctx.carts.sync();
  const crashes = ctx.carts.step(dt);
  ctx.carts.afterStep(dt, now);
  rules.golfer.afterPhysics(crashes);
}
