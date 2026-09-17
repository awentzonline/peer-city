import type { HauntContext } from './context';
import { Burn, Feed, Glare, Haunt, Hurt, Key, Monster, Noise, Order, OrderKind, Revive, Sound, Survivor, SurvivorMode } from './defs';
import { WHISPER_DARK_MS, WHISPER_RADIUS, type HauntRole } from './haunt';
import { MONSTERS, burn, order } from './monsters';
import type { SurvivorRole } from './survivor';

/** The local player's role: a survivor or the Haunt. */
export interface LocalRoles {
  survivor?: SurvivorRole;
  haunt?: HauntRole;
}

/**
 * Wires Peer Haunt's actions. A change to an entity is made by its owner, the only peer that writes it: a hurt or a
 * helping hand by the survivor's, light and orders by the monster's, a glare by the Haunt's. Noises are seen and heard
 * by everyone, and a whisper puts out the lights near it. A key is only
 * handed to someone who asks while it's lying loose.
 */
export function registerActions(ctx: HauntContext, roles: LocalRoles): void {
  const { world } = ctx;

  world.onAction(Feed, (p) => ctx.hud.message(p.text));

  world.onCommand(Hurt, Survivor, (target, p) => {
    if (target === ctx.me) roles.survivor?.hurt(p.amount, p.kx, p.ky);
  });

  world.onCommand(Revive, Survivor, (target, p) => {
    if (target === ctx.me) roles.survivor?.helpedBy(p.by);
  });

  world.onCommand(Burn, Monster, (m, p) => burn(ctx, m, p.amount, world.getAs(Survivor, p.by)));

  world.onCommand(Order, Monster, (m, p) => order(ctx, m, p.kind === OrderKind.Attack ? (world.getAs(Survivor, p.victim) ?? null) : null, p.x, p.y));

  world.onCommand(Glare, Haunt, (target, p) => {
    if (target === ctx.haunt) roles.haunt?.glare(world.getAs(Survivor, p.by));
  });

  world.onAction(Noise, (p) => {
    const at = { x: p.x, y: p.y, z: p.z };
    switch (p.kind) {
      case Sound.Strike:
        ctx.sfx.play('strike', at, p.a === 2 ? 1 : 0.7);
        break;
      case Sound.Banish:
        ctx.sfx.play('banish', at);
        ctx.fx.banish(p.x, p.y, p.z, MONSTERS[p.a as 0 | 1 | 2]?.radius ?? 0.4);
        break;
      case Sound.Summon:
        ctx.sfx.play('summon', at);
        ctx.fx.summon(p.x, p.y);
        break;
      case Sound.Whisper: {
        ctx.sfx.play('whisper', at);
        ctx.fx.whisper(p.x, p.y);
        const me = ctx.me?.state;
        if (me && me.mode === SurvivorMode.Alive && Math.hypot(me.x - p.x, me.y - p.y) < WHISPER_RADIUS) roles.survivor?.snuff(WHISPER_DARK_MS);
        break;
      }
      case Sound.Pickup:
        ctx.sfx.play('pickup', at);
        ctx.fx.sparkle(p.x, p.y, p.z);
        break;
      case Sound.Socket:
        ctx.sfx.play('socket', at);
        ctx.fx.sparkle(p.x, p.y, p.z);
        break;
      case Sound.Scream:
        ctx.sfx.play('scream', at);
        break;
    }
  });

  world.setTransferPolicy(Key, (key) => !key.state.holder && !key.state.socket);
}
