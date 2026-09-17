import type { NetEntity } from '@engine/index';
import type { GuardEntity, ShinobiContext, ShinobiEntity, Vec3 } from './context';
import { Blade, Guard, GuardMode, Noise, Shinobi, ShinobiMode, Sound, Strike, Throw, Weapon, Wound } from './defs';
import { GUARDS } from './guards';
import { FLIGHTS } from './kit';

/** Longest step of a flight, m, so nothing fast passes through a body or a wall. */
const STEP = 0.35;
/** How long something stays stuck where it hit before it's no longer drawn, ms (a blade left behind is a `Blade`). */
const STUCK_MS = 6000;
const MAX_FLIGHT_MS = 4000;
/** How far off peers see a throw, m. */
const SEEN_FROM = 120;
export const SHINOBI_RADIUS = 0.35;

export interface Flying {
  kind: Weapon;
  /** Who threw or loosed it. */
  by: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Where it was thrown from: a guard that lives turns to look there. */
  ox: number;
  oy: number;
  /** This peer threw it, so this peer decides what it hits. */
  mine: boolean;
  born: number;
  /** When it stuck in something, or 0 while it flies. */
  stuckAt: number;
  /** Radians it's spun, for a shuriken. */
  spin: number;
}

const dir: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Kunai, shuriken and arrows in flight. They're projectiles that arc and take time to arrive, not hit-scan, and there's
 * no entity for each: the thrower's peer flies one and decides what it hits, and everyone near gets a `Throw` and flies
 * their own copy to see it. A shinobi's blade that misses clatters where it lands, which guards come to look at, and is
 * left there as a `Blade` to pick up again; one that hits drops at its victim's feet.
 */
export class Flights {
  readonly all: Flying[] = [];

  constructor(private readonly ctx: ShinobiContext) {
    ctx.world.onAction(Throw, (p) => this.add(p.kind, p.by, p, { x: p.vx, y: p.vy, z: p.vz }, false));
  }

  /** Throw or loose something from `from` with velocity `v`. */
  launch(kind: Weapon, by: number, from: Vec3, v: Vec3): void {
    this.add(kind, by, from, v, true);
    this.ctx.world.send(Throw, { kind, by, x: from.x, y: from.y, z: from.z, vx: v.x, vy: v.y, vz: v.z }, { to: 'near', x: from.x, y: from.y, radius: SEEN_FROM, self: false });
  }

  private add(kind: Weapon, by: number, from: Vec3, v: Vec3, mine: boolean): void {
    this.all.push({ kind, by, x: from.x, y: from.y, z: from.z, vx: v.x, vy: v.y, vz: v.z, ox: from.x, oy: from.y, mine, born: this.ctx.now, stuckAt: 0, spin: 0 });
    this.ctx.sfx.play(kind === Weapon.Arrow ? 'twang' : 'whoosh', from, kind === Weapon.Kunai ? 0.8 : 0.6);
  }

  update(dt: number): void {
    const { now } = this.ctx;
    for (let i = this.all.length - 1; i >= 0; i--) {
      const f = this.all[i];
      const done = f.stuckAt ? now - f.stuckAt > STUCK_MS : this.fly(f, dt) || now - f.born > MAX_FLIGHT_MS;
      if (done) this.all.splice(i, 1);
    }
  }

  /** Clear everything flying, e.g. for a new night. */
  clear(): void {
    this.all.length = 0;
  }

  /** Move a flight on by `dt`. True when it's gone into a body. */
  private fly(f: Flying, dt: number): boolean {
    const { ctx } = this;
    const gravity = FLIGHTS[f.kind as Weapon.Kunai].gravity;
    const speed = Math.hypot(f.vx, f.vy, f.vz);
    const steps = Math.max(1, Math.ceil((speed * dt) / STEP));
    const h = dt / steps;
    f.spin += dt * (f.kind === Weapon.Shuriken ? 40 : f.kind === Weapon.Kunai ? 14 : 0);
    for (let s = 0; s < steps; s++) {
      f.vz -= gravity * h;
      const len = Math.hypot(f.vx, f.vy, f.vz) * h;
      if (len < 1e-6) continue;
      dir.x = (f.vx * h) / len;
      dir.y = (f.vy * h) / len;
      dir.z = (f.vz * h) / len;
      const wall = ctx.castle.raycast(f.x, f.y, f.z, dir.x, dir.y, dir.z, len);
      const body = this.sweep(f, wall);
      if (body) {
        const bx = f.x + dir.x * body.t;
        const by = f.y + dir.y * body.t;
        const bz = f.z + dir.z * body.t;
        ctx.fx.blood(bx, by, bz);
        ctx.sfx.play('stab', { x: bx, y: by, z: bz }, 0.8);
        if (f.mine) this.hit(f, body.entity, bx, by, bz);
        return true;
      }
      if (wall < len) {
        f.x += dir.x * wall;
        f.y += dir.y * wall;
        f.z += dir.z * wall;
        f.stuckAt = ctx.now;
        ctx.fx.sparks(f.x, f.y, f.z);
        if (f.mine) this.missed(f);
        return false;
      }
      f.x += dir.x * len;
      f.y += dir.y * len;
      f.z += dir.z * len;
    }
    return false;
  }

  /** The nearest body a step of a flight passes through before `max`: guards for a shinobi's blade, shinobi for an arrow. */
  private sweep(f: Flying, max: number): { entity: NetEntity<any>; t: number } | null {
    const { world } = this.ctx;
    let best: { entity: NetEntity<any>; t: number } | null = null;
    const reach = max + 2;
    if (f.kind === Weapon.Arrow) {
      for (const sv of world.query(f.x, f.y, reach, Shinobi) as ShinobiEntity[]) {
        const s = sv.render;
        if (s.mode !== ShinobiMode.Alive) continue;
        const t = rayCylinder(f, dir, sv.x, sv.y, SHINOBI_RADIUS, s.z, s.z + s.head + 0.15, max);
        if (t >= 0 && (!best || t < best.t)) best = { entity: sv, t };
      }
    } else {
      for (const g of world.query(f.x, f.y, reach, Guard) as GuardEntity[]) {
        const s = g.render;
        if (s.mode === GuardMode.Dead) continue;
        const spec = GUARDS[s.kind];
        const t = rayCylinder(f, dir, g.x, g.y, spec.radius + 0.08, s.z, s.z + spec.height, max);
        if (t >= 0 && (!best || t < best.t)) best = { entity: g, t };
      }
    }
    return best;
  }

  private hit(f: Flying, victim: NetEntity<any>, x: number, y: number, z: number): void {
    const { world, round } = this.ctx;
    if (f.kind === Weapon.Arrow) {
      const k = 1 / Math.max(0.01, Math.hypot(f.vx, f.vy));
      world.command(Wound, { target: victim.id, by: f.by, amount: FLIGHTS[Weapon.Arrow].damage, kx: f.vx * k * 2, ky: f.vy * k * 2 });
      return;
    }
    const flight = FLIGHTS[f.kind as Weapon.Kunai];
    world.command(Strike, { target: victim.id, by: f.by, weapon: f.kind, amount: flight.damage, x: f.ox, y: f.oy });
    world.send(Noise, { kind: Sound.Stab, x, y, z, a: f.kind }, { to: 'all' });
    // it drops at their feet
    const at = (victim.render as { z: number }).z;
    const r = round()?.state.round ?? 0;
    world.spawn(Blade, { x: victim.x + dir.x * 0.4, y: victim.y + dir.y * 0.4, z: at + 0.03, kind: f.kind, yaw: Math.random() * Math.PI * 2, pitch: 0, round: r });
  }

  /** A blade that missed: it clatters, and stays where it stuck for someone to pick up. */
  private missed(f: Flying): void {
    const { world, round } = this.ctx;
    world.send(Noise, { kind: Sound.Clatter, x: f.x, y: f.y, z: f.z, a: f.kind }, { to: 'all' });
    if (f.kind === Weapon.Arrow) return;
    world.spawn(Blade, { x: f.x, y: f.y, z: Math.max(0.03, f.z), kind: f.kind, yaw: Math.atan2(f.vy, f.vx), pitch: Math.asin(Math.max(-1, Math.min(1, f.vz / Math.max(0.01, Math.hypot(f.vx, f.vy, f.vz))))), round: round()?.state.round ?? 0 });
  }
}

/** Entry distance of a ray into an upright cylinder, or -1. */
export function rayCylinder(o: Vec3, d: Vec3, cx: number, cy: number, r: number, z0: number, z1: number, max: number): number {
  const fx = o.x - cx;
  const fy = o.y - cy;
  let tIn = 0;
  let tOut = max;
  const a = d.x * d.x + d.y * d.y;
  if (a < 1e-9) {
    if (fx * fx + fy * fy > r * r) return -1;
  } else {
    const b = fx * d.x + fy * d.y;
    const disc = b * b - a * (fx * fx + fy * fy - r * r);
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    tIn = Math.max(tIn, (-b - sq) / a);
    tOut = Math.min(tOut, (-b + sq) / a);
  }
  if (Math.abs(d.z) < 1e-9) {
    if (o.z < z0 || o.z > z1) return -1;
  } else {
    let t0 = (z0 - o.z) / d.z;
    let t1 = (z1 - o.z) / d.z;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tIn = Math.max(tIn, t0);
    tOut = Math.min(tOut, t1);
  }
  return tIn <= tOut ? tIn : -1;
}
