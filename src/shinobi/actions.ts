import type { CaptainRole } from './captain';
import type { ShinobiContext } from './context';
import { Feed, Guard, Noise, Order, Report, Revive, Shinobi, Sound, Strike, Tally, Wound } from './defs';
import { hear, ordered, struck } from './guards';
import type { RoundKeeper } from './round';
import { BELL_SECONDS } from './captain';
import type { ShinobiRole } from './shinobi';

/** The local player's role: a shinobi or the captain. */
export interface LocalRoles {
  shinobi?: ShinobiRole;
  captain?: CaptainRole;
}

/**
 * Wires Peer Shinobi's actions. A change to an entity is made by its owner, the only peer that writes it: a blow or blade
 * and an order by the guard's, a wound or a helping hand by the shinobi's. Noises are heard by everyone, and the guards
 * each peer owns come to look if they're near enough; the captain hears of them through those guards, and of what
 * they report.
 */
export function registerActions(ctx: ShinobiContext, keeper: RoundKeeper, roles: LocalRoles): void {
  const { world } = ctx;

  world.onAction(Feed, (p) => ctx.hud.message(p.text));

  world.onCommand(Strike, Guard, (g, p) => struck(ctx, g, p.by, p.weapon, p.amount, p.x, p.y));

  world.onCommand(Order, Guard, (g, p) => ordered(ctx, g, p.kind, p.x, p.y));

  world.onCommand(Tally, Shinobi, (target, p) => {
    if (target === ctx.me) roles.shinobi?.tally(p.kind);
  });

  world.onCommand(Wound, Shinobi, (target, p) => {
    if (target === ctx.me) roles.shinobi?.wound(p.amount, p.kx, p.ky);
  });

  world.onCommand(Revive, Shinobi, (target, p) => {
    if (target === ctx.me) roles.shinobi?.helpedBy(p.by);
  });

  world.onAction(Noise, (p) => {
    const at = { x: p.x, y: p.y, z: p.z };
    switch (p.kind) {
      case Sound.Steps:
        ctx.sfx.play('steps', at);
        break;
      case Sound.Land:
        ctx.sfx.play('land', at);
        ctx.fx.dust(p.x, p.y, p.z);
        break;
      case Sound.Clatter:
        ctx.sfx.play('clatter', at);
        break;
      case Sound.Fall:
        ctx.sfx.play('fall', at);
        ctx.fx.dust(p.x, p.y, p.z);
        break;
      case Sound.Shout:
        ctx.sfx.play('shout', at);
        break;
      case Sound.Attack:
        ctx.sfx.play(p.a === 1 ? 'twang' : 'thrust', at);
        break;
      case Sound.Stab:
        ctx.sfx.play('stab', at);
        ctx.fx.blood(p.x, p.y, p.z);
        break;
      case Sound.Bell:
        ctx.sfx.play('bell');
        keeper.ring(BELL_SECONDS);
        ctx.hud.message('The alarm bell is ringing!');
        break;
      case Sound.Cry:
        ctx.sfx.play('cry', at);
        break;
      case Sound.Pickup:
        ctx.sfx.play('pickup', at);
        break;
      case Sound.Gong:
        ctx.sfx.play('gong');
        break;
      case Sound.Kindle:
        ctx.sfx.play('kindle', at);
        ctx.fx.kindle(p.x, p.y);
        break;
    }
    hear(ctx, p.kind, p.x, p.y, p.z);
    roles.captain?.intel.heard(p.kind, p.x, p.y, p.z);
  });

  world.onAction(Report, (p) => roles.captain?.intel.reported(p.kind, p.guard, p.about, p.x, p.y));
}
