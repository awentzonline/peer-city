import { angleDiff, type RaiderEntity, type ShipEntity, type StarshipContext } from './context';
import { Boom, Damage, Launch, Raider } from './defs';
import { TORPEDO_DAMAGE, WEAKNESS } from './ship';

export const TORPEDO_SPEED = 380;
const TORPEDO_TURN = 1.3;
const TORPEDO_LIFE = 6;
/** How near a torpedo gets to go off, u. */
const PROXIMITY = 42;
export const HOSTILE_TORPEDO_DAMAGE = 22;

interface Flight {
  id: number;
  x: number;
  y: number;
  heading: number;
  target: number;
  hostile: boolean;
  age: number;
  /** Launched here: this peer decides what it hits. Copies from elsewhere only fly to be seen. */
  live: boolean;
}

/**
 * Torpedoes, as actions rather than entities: the peer that launches one flies it and decides what it hits, and everyone
 * else flies a copy of it to watch. Ship torpedoes home on tactical's target, or run straight and hit the first raider in
 * their way; raiders' torpedoes home on the ship.
 */
export class Torpedoes {
  readonly flights: Flight[] = [];
  private nextId = 1;

  constructor(private readonly ctx: StarshipContext) {}

  launch(x: number, y: number, heading: number, target: number, hostile: boolean): void {
    this.ctx.world.send(Launch, { x, y, heading, target, hostile }, { to: 'all', self: false });
    this.add(x, y, heading, target, hostile, true);
  }

  /** Someone else's launch, to watch. */
  add(x: number, y: number, heading: number, target: number, hostile: boolean, live = false): void {
    const f: Flight = { id: this.nextId++, x, y, heading, target, hostile, age: 0, live };
    this.flights.push(f);
    this.ctx.fx.torpedo(f.id, x, y, heading, hostile);
  }

  update(dt: number): void {
    const { world } = this.ctx;
    const ship = this.ctx.ship();
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.age += dt;
      const target = f.hostile ? ship : (world.getAs(Raider, f.target) as RaiderEntity | undefined);
      if (target) {
        const want = Math.atan2(target.y - f.y, target.x - f.x);
        const turn = TORPEDO_TURN * dt;
        f.heading += Math.max(-turn, Math.min(turn, angleDiff(f.heading, want)));
      }
      f.x += Math.cos(f.heading) * TORPEDO_SPEED * dt;
      f.y += Math.sin(f.heading) * TORPEDO_SPEED * dt;
      const hit = f.hostile ? this.hitsShip(f, ship) : this.hitsRaider(f);
      if (hit || f.age > TORPEDO_LIFE) {
        this.flights.splice(i, 1);
        this.ctx.fx.torpedoGone(f.id, !!hit);
        if (hit && f.live) {
          world.send(Boom, { x: f.x, y: f.y, size: 0 }, { to: 'all' });
          const amount = f.hostile ? HOSTILE_TORPEDO_DAMAGE : TORPEDO_DAMAGE * ((hit as RaiderEntity).render.scanned ? WEAKNESS : 1);
          world.command(Damage, { target: hit.id, amount, x: f.x, y: f.y });
        }
      }
    }
  }

  private hitsShip(f: Flight, ship: ShipEntity | null): ShipEntity | null {
    return ship && Math.hypot(ship.x - f.x, ship.y - f.y) < PROXIMITY ? ship : null;
  }

  private hitsRaider(f: Flight): RaiderEntity | null {
    for (const r of this.ctx.world.all(Raider) as ReadonlySet<RaiderEntity>) if (Math.hypot(r.x - f.x, r.y - f.y) < PROXIMITY) return r;
    return null;
  }
}
