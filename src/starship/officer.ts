import { Platform } from '../crossplay/platform';
import type { Frontend, Role } from '../crossplay/role';
import type { StarshipContext } from './context';
import { Console, Officer, Station } from './defs';
import type { ConsoleAct, OfficerIntent } from './intent';

/** How an officer's rules reach back to the device. Officers have no body, so it's only the platform. */
export interface OfficerBody {
  readonly platform: Platform;
}

export type OfficerFrontend = Frontend<OfficerIntent> & OfficerBody;

/** The whole world is one neighbourhood: every peer watches all of space and every deck. */
export const FOCUS = { x: 5000, y: 5000, radius: 20000 };

/** Send an order to the ship's owner. */
export function order(ctx: StarshipContext, a: ConsoleAct): void {
  const ship = ctx.ship();
  if (ship) ctx.world.command(Console, { target: ship.id, act: a.act, a: a.a, b: a.b, ref: a.ref });
}

/**
 * The player at a bridge station, or at the viewscreen. They have no body in the world, only an `Officer` entity so the
 * others can see who's at which station, and orders for the ship.
 */
export class OfficerRole implements Role<OfficerIntent, OfficerFrontend> {
  body: OfficerBody = { platform: Platform.Touch };

  constructor(readonly ctx: StarshipContext) {}

  attach(body: OfficerBody): void {
    this.body = body;
  }

  spawn(station: Station): void {
    const { ctx } = this;
    ctx.officer = ctx.world.spawn(Officer, { x: FOCUS.x, y: FOCUS.y, name: ctx.playerName, station, platform: this.body.platform });
    ctx.world.setFocus(FOCUS.x, FOCUS.y, FOCUS.radius);
  }

  update(_dt: number, intent: OfficerIntent): void {
    const me = this.ctx.officer;
    if (!me) return;
    me.state.station = intent.station;
    me.state.platform = this.body.platform;
    for (const a of intent.acts) order(this.ctx, a);
    this.ctx.world.setFocus(FOCUS.x, FOCUS.y, FOCUS.radius);
  }
}

/** Who's at each station, by name. */
export function manning(ctx: StarshipContext): Map<Station, string[]> {
  const out = new Map<Station, string[]>();
  const add = (station: Station, name: string) => {
    const list = out.get(station) ?? [];
    list.push(name);
    out.set(station, list);
  };
  for (const o of ctx.world.all(Officer)) add(o.render.station, o.render.name);
  return out;
}
