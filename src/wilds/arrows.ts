import { sweepBodies } from './bodies';
import type { SurvivorEntity, Vec3, WildsContext } from './context';
import { Damage, Item, Loose } from './defs';
import { ARROWS } from './kit';

export const ARROW_MIN_SPEED = 16;
export const ARROW_MAX_SPEED = 58;
const GRAVITY = 9.8;
/** Longest step of a flight, meters, so fast arrows don't pass through things. */
const STEP = 0.8;
const STUCK_MS = 25000;
const MAX_FLIGHT_MS = 6000;
/** Chance an arrow that lands in the ground can be picked up again. */
const RECOVERABLE = 0.75;

export interface Flight {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  shooter: number;
  /** This peer loosed it, so this peer decides what it hits. */
  mine: boolean;
  born: number;
  /** When it stuck in something (0 while flying). */
  stuckAt: number;
}

const origin: Vec3 = { x: 0, y: 0, z: 0 };
const dir: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Arrows in flight. They're projectiles, not hit-scan: they arc under gravity, so there's no entity for each
 * one. The shooter's peer flies the arrow and decides what it hits; everyone nearby gets a `Loose` and flies
 * their own copy just to see it. Views draw `flights`.
 */
export class Arrows {
  readonly flights: Flight[] = [];

  constructor(private readonly ctx: WildsContext) {
    ctx.world.onAction(Loose, (p) => {
      this.add(p.x, p.y, p.z, p.vx, p.vy, p.vz, p.shooter, false);
    });
  }

  /** Shoot an arrow from `from` along the unit vector `aim`. */
  loose(shooter: SurvivorEntity, from: Vec3, aim: Vec3, speed: number): void {
    const { x, y, z } = from;
    const [vx, vy, vz] = [aim.x * speed, aim.y * speed, aim.z * speed];
    this.add(x, y, z, vx, vy, vz, shooter.id, true);
    this.ctx.world.send(Loose, { x, y, z, vx, vy, vz, shooter: shooter.id }, { to: 'near', x, y, radius: 160, self: false });
  }

  private add(x: number, y: number, z: number, vx: number, vy: number, vz: number, shooter: number, mine: boolean): void {
    this.flights.push({ x, y, z, vx, vy, vz, shooter, mine, born: this.ctx.now, stuckAt: 0 });
    this.ctx.sfx.play('twang', { x, y, z });
  }

  update(dt: number): void {
    const { ctx } = this;
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      const done = f.stuckAt ? ctx.now - f.stuckAt > STUCK_MS : this.fly(f, dt) || ctx.now - f.born > MAX_FLIGHT_MS;
      if (done) this.flights.splice(i, 1);
    }
  }

  /** Move a flight on by `dt`. True when it's gone (into a body, or picked up where it landed). */
  private fly(f: Flight, dt: number): boolean {
    const { ctx } = this;
    const { land } = ctx;
    const speed = Math.hypot(f.vx, f.vy, f.vz);
    const steps = Math.max(1, Math.ceil((speed * dt) / STEP));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      f.vz -= GRAVITY * h;
      const len = Math.hypot(f.vx, f.vy, f.vz) * h;
      if (len < 1e-6) continue;
      Object.assign(origin, { x: f.x, y: f.y, z: f.z });
      Object.assign(dir, { x: (f.vx * h) / len, y: (f.vy * h) / len, z: (f.vz * h) / len });
      const hit = land.raycast(f.x, f.y, f.z, dir.x, dir.y, dir.z, len);
      const body = sweepBodies(ctx, origin, dir, hit.t, f.shooter);
      if (body) {
        const bx = f.x + dir.x * body.t;
        const by = f.y + dir.y * body.t;
        const bz = f.z + dir.z * body.t;
        ctx.fx.blood(bx, by, bz);
        ctx.sfx.play('hit', { x: bx, y: by, z: bz });
        if (f.mine) {
          const k = Math.min(1, (speed - ARROW_MIN_SPEED) / (ARROW_MAX_SPEED - ARROW_MIN_SPEED));
          ctx.world.command(Damage, { target: body.entity.id, amount: Math.round(22 + 58 * Math.max(0, k)), attacker: f.shooter, kx: dir.x * 3, ky: dir.y * 3 });
        }
        return true;
      }
      if (hit.t < len) {
        f.x += dir.x * hit.t;
        f.y += dir.y * hit.t;
        f.z += dir.z * hit.t;
        f.stuckAt = ctx.now;
        ctx.sfx.play('thunk', f);
        if (f.mine && hit.obstacle < 0 && Math.random() < RECOVERABLE) {
          ctx.world.spawn(Item, { x: f.x, y: f.y, tool: ARROWS.id, amount: 1 });
          return true;
        }
        return false;
      }
      f.x += dir.x * len;
      f.y += dir.y * len;
      f.z += dir.z * len;
    }
    return false;
  }
}
