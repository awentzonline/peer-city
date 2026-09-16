import type { Builder } from './builder';
import type { DerbyContext } from './context';
import type { RaceKeeper } from './race';
import type { RacerProxies } from './racer';

/** The parts of Peer Derby's rules that move on every simulation step. */
export interface DerbyRules {
  builder: Builder;
  keeper: RaceKeeper;
  proxies: RacerProxies;
}

/**
 * The rest of a simulation step, once the network's been received and the local builder has played its intent:
 * the race moves on, everyone else's racers follow their owners, the physics world steps, and the builder's racer
 * reacts to what the physics did. No DOM, so `Game` and the tests run the same frame.
 */
export function stepRules(ctx: DerbyContext, rules: DerbyRules, dt: number, now: number): void {
  rules.keeper.update(dt, now);
  rules.proxies.update();
  ctx.physics.step(dt);
  rules.builder.afterPhysics(dt);
}
