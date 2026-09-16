import type { Builder } from './builder';
import type { DerbyContext } from './context';
import { Edit, Feed, Racer, Shatter } from './defs';
import { throwShattered } from './racer';

/**
 * Wires Peer Derby's actions. An edit is made by the racer's owner, the only peer allowed to write it; parts
 * torn off are thrown by everyone who can see them, from where they see that racer.
 */
export function registerActions(ctx: DerbyContext, builder: Builder): void {
  const { world } = ctx;

  world.onAction(Feed, (p) => ctx.hud.message(p.text));

  world.onCommand(Edit, Racer, (racer, p, from) => {
    if (racer !== ctx.racer) return;
    const before = racer.state.design;
    builder.edit(p.op, p.x, p.y, p.z, p.dir, p.kind);
    // someone else built on your racer: say so, once in a while
    if (racer.state.design !== before && !from.local) builder.helped(from.from);
  });

  world.onAction(Shatter, (p) => {
    const racer = world.getAs(Racer, p.racer);
    if (racer && !racer.mine) throwShattered(ctx, racer, p.parts, p.vx, p.vy, p.vz);
  });
}
