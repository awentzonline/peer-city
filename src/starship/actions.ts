import type { PayloadOf } from '@engine/index';
import { grabbed, hurtSentinel, mend, recovered, relicAboard } from './away';
import type { StarshipContext } from './context';
import type { CrewRole } from './crew';
import { Beam3, Boom, Console, Crew, Damage, Fault, Feed, Grab, Jolt, Launch, Mend, Noise, Raider, Recovered, Relic, Repaired, Scanned, Sentinel, Ship, Transport } from './defs';
import type { Torpedoes } from './flights';
import { hurt } from './raiders';
import { FAULT_HEALTH, health, type ShipKeeper } from './ship';

/** How this peer shows events: the views and sounds in the game, nothing in tests. */
export interface Presenter {
  beam(p: PayloadOf<typeof Beam3>): void;
  boom(p: PayloadOf<typeof Boom>): void;
  jolt(p: PayloadOf<typeof Jolt>): void;
  noise(p: PayloadOf<typeof Noise>): void;
}

export const NO_PRESENTER: Presenter = { beam() {}, boom() {}, jolt() {}, noise() {} };

const HEALTH_KEYS = ['hEng', 'hWep', 'hShd', 'hSen'] as const;

/**
 * Wires Peer Starship's actions. A change to an entity is made by its owner, the only peer that writes it: stations'
 * orders, damage, repairs and relics by the ship's; a wound or a transport by the crew member's; a hit by the raider's or
 * sentinel's. Events are shown by whoever hears of them.
 */
export function registerActions(ctx: StarshipContext, keeper: ShipKeeper, torpedoes: Torpedoes, crew: CrewRole | null, show: Presenter): void {
  const { world } = ctx;

  world.onAction(Feed, (p) => ctx.hud.message(p.text));

  world.onCommand(Console, Ship, (ship, p) => keeper.console(ship, p.act, p.a, p.b, p.ref));
  world.onCommand(Damage, Ship, (ship, p) => keeper.damage(ship, p.amount, p.x, p.y));
  world.onCommand(Repaired, Ship, (ship, p) => {
    ship.state[HEALTH_KEYS[p.system]] = Math.min(1, health(ship.state, p.system) + FAULT_HEALTH);
  });
  world.onCommand(Recovered, Ship, (_ship, p) => recovered(ctx, p.planet));

  world.onCommand(Damage, Raider, (r, p) => hurt(ctx, r, p.amount));
  world.onCommand(Scanned, Raider, (r) => (r.state.scanned = true));

  world.onCommand(Damage, Sentinel, (e, p) => hurtSentinel(ctx, e, p.amount));
  world.onCommand(Mend, Fault, (e, p) => mend(ctx, e, p.amount));
  world.onCommand(Grab, Relic, (e, p) => grabbed(ctx, e, p.by));
  world.onCommand(Transport, Relic, (e) => relicAboard(ctx, e));

  world.onCommand(Damage, Crew, (e, p) => {
    if (e === ctx.me) crew?.wound(p.amount);
  });
  world.onCommand(Transport, Crew, (e, p) => {
    if (e === ctx.me) crew?.transported(p.x, p.y);
  });

  world.onAction(Launch, (p, from) => {
    if (!from.local) torpedoes.add(p.x, p.y, p.heading, p.target, p.hostile);
  });
  world.onAction(Beam3, (p) => show.beam(p));
  world.onAction(Boom, (p) => show.boom(p));
  world.onAction(Jolt, (p) => show.jolt(p));
  world.onAction(Noise, (p) => show.noise(p));
}
