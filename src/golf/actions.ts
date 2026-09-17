import type { GolfContext } from './context';
import { Cart, Feed, Golfer, Knock, Noise, Shove, Whack } from './defs';
import type { Golfer as GolferRole } from './golfer';
import { driverOf } from './golfer';

/**
 * Wires Peer Golf's actions. A knock is carried out by the golfer's owner, and a shove by the rammed cart's owner,
 * the only peers that write them; noises are shown and heard by whoever's near. A cart is only handed to someone who asks while nobody's driving it.
 */
export function registerActions(ctx: GolfContext, golfer: GolferRole): void {
  const { world } = ctx;

  world.onAction(Feed, (p) => ctx.hud.message(p.text));

  world.onCommand(Knock, Golfer, (target, p) => {
    if (target !== ctx.me) return;
    golfer.knocked(world.getAs(Golfer, p.by) ?? null, p.kx, p.ky, p.cause);
  });

  world.onCommand(Shove, Cart, (cart, p) => {
    ctx.carts.shove(cart, { x: p.vx, y: p.vy, z: p.vz }, { x: p.x, y: p.y, z: p.z });
  });

  world.onAction(Noise, (p) => {
    const at = { x: p.x, y: p.y, z: p.z };
    switch (p.kind) {
      case Whack.Swish:
        ctx.sfx.play('swish', at, p.power);
        break;
      case Whack.Bonk:
        ctx.sfx.play('bonk', at, p.power);
        ctx.fx.stars(p.x, p.y, p.z);
        break;
      case Whack.Crash:
        ctx.sfx.play('crash', at, p.power);
        ctx.fx.crash(p.x, p.y, p.z, p.power);
        break;
      case Whack.Splash:
        ctx.sfx.play('splash', at, p.power);
        ctx.fx.splash(p.x, p.y, p.z);
        break;
    }
  });

  world.setTransferPolicy(Cart, (cart) => !driverOf(ctx, cart));
}
