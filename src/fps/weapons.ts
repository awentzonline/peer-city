import type { NetEntity } from '@engine/index';
import type { GameContext, Vec3 } from './context';
import { Car, CarMode, Damage, DamageCause, Impact, Ped, PedMode, Player, Shot } from './defs';
import { carExtents, carSpec } from './specs';

export interface BulletOptions {
  range: number;
  /** Damage for a candidate victim; 0 lets the bullet pass through (e.g. no friendly fire). */
  damage: (e: NetEntity, head: boolean) => number;
  /** Entity the ray starts inside and must ignore (the shooter's own car). */
  ignore?: number;
  /** Where the visible tracer starts, when aiming from the eye but shooting from a gun. */
  from?: Vec3;
  /** For the sound others hear. */
  weapon?: number;
  /** Tracer without sound or muzzle flash, for the extra pellets of a shotgun blast. */
  quiet?: boolean;
}

export interface BulletHit {
  entity: NetEntity | null;
  head: boolean;
  dist: number;
}

/** A random direction within roughly `spread` radians of the unit vector `aim`. */
export function scatter(aim: Vec3, spread: number, out: Vec3): Vec3 {
  out.x = aim.x + (Math.random() * 2 - 1) * spread;
  out.y = aim.y + (Math.random() * 2 - 1) * spread;
  out.z = aim.z + (Math.random() * 2 - 1) * spread;
  const len = Math.hypot(out.x, out.y, out.z);
  out.x /= len;
  out.y /= len;
  out.z /= len;
  return out;
}

const HUMAN_RADIUS = 0.4;
const HEAD_SIZE = 0.32;

/** Vertical extent [bottom, top] of a standing target, or null if it can't be shot. */
function humanSpan(e: NetEntity): [number, number] | null {
  if (e.def === Ped) return (e.state as { mode: number }).mode !== PedMode.Dead ? [0, 1.86] : null;
  if (e.def === Player) {
    const s = e.render as { hp: number; car: number; z: number; head: number };
    return s.hp > 0 && s.car === 0 ? [s.z, s.z + s.head + 0.2] : null;
  }
  return null;
}

/** Entry distance of a ray into an upright cylinder, or -1. */
function rayCylinder(o: Vec3, d: Vec3, cx: number, cy: number, r: number, z0: number, z1: number, maxT: number): number {
  const fx = o.x - cx;
  const fy = o.y - cy;
  let tIn = 0;
  let tOut = maxT;
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
  if (!slab(o.z, d.z, z0, z1, (t0, t1) => ((tIn = Math.max(tIn, t0)), (tOut = Math.min(tOut, t1))))) return -1;
  return tIn <= tOut ? tIn : -1;
}

/** Narrows [t0, t1] to where a 1D ray is inside [lo, hi]; false if never. */
function slab(o: number, d: number, lo: number, hi: number, narrow: (t0: number, t1: number) => void): boolean {
  if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
  let t0 = (lo - o) / d;
  let t1 = (hi - o) / d;
  if (t0 > t1) [t0, t1] = [t1, t0];
  narrow(t0, t1);
  return true;
}

/** Entry distance of a ray into a car's oriented bounding box, or -1. */
function rayCar(o: Vec3, d: Vec3, car: NetEntity, maxT: number): number {
  const s = car.render as { angle: number; kind: number };
  const { hl, hw } = carExtents(s.kind);
  const spec = carSpec(s.kind);
  const c = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  const rx = o.x - car.x;
  const ry = o.y - car.y;
  let tIn = 0;
  let tOut = maxT;
  const narrow = (t0: number, t1: number) => {
    tIn = Math.max(tIn, t0);
    tOut = Math.min(tOut, t1);
  };
  if (!slab(rx * c + ry * sn, d.x * c + d.y * sn, -hl, hl, narrow)) return -1;
  if (!slab(-rx * sn + ry * c, -d.x * sn + d.y * c, -hw, hw, narrow)) return -1;
  if (!slab(o.z, d.z, spec.floor - 0.1, spec.roof, narrow)) return -1;
  return tIn <= tOut ? tIn : -1;
}

/**
 * Hit-scan a bullet in 3D against buildings (with their heights), the ground
 * and whatever this peer can see. Everyone nearby gets a cosmetic Shot; the
 * victim's owner gets the Damage. `d` must be normalized.
 */
export function fireBullet(ctx: GameContext, shooter: NetEntity, o: Vec3, d: Vec3, opts: BulletOptions): BulletHit {
  const wall = ctx.city.raycast3D(o.x, o.y, o.z, d.x, d.y, d.z, opts.range);
  const flat = Math.hypot(d.x, d.y) * wall;
  let hit: NetEntity | null = null;
  let hitT = wall;
  let head = false;
  let amount = 0;
  for (const e of ctx.world.query(o.x + (d.x * wall) / 2, o.y + (d.y * wall) / 2, flat / 2 + 4)) {
    if (e === shooter || e.id === opts.ignore) continue;
    let t = -1;
    let isHead = false;
    if (e.def === Car) {
      if ((e.state as { mode: number }).mode === CarMode.Wrecked) continue;
      t = rayCar(o, d, e, hitT);
    } else {
      const span = humanSpan(e);
      if (!span) continue;
      t = rayCylinder(o, d, e.x, e.y, HUMAN_RADIUS, span[0], span[1], hitT);
      isHead = t >= 0 && o.z + d.z * t > span[1] - HEAD_SIZE;
    }
    if (t < 0 || t >= hitT) continue;
    const dmg = opts.damage(e, isHead);
    if (!dmg) continue;
    hit = e;
    hitT = t;
    head = isHead;
    amount = dmg;
  }

  const from = opts.from ?? o;
  const ex = o.x + d.x * hitT - from.x;
  const ey = o.y + d.y * hitT - from.y;
  const ez = o.z + d.z * hitT - from.z;
  const len = Math.max(0.001, Math.hypot(ex, ey, ez));
  const impact = hit ? (hit.def === Car ? Impact.Metal : Impact.Flesh) : hitT < opts.range - 0.01 ? Impact.Wall : Impact.None;
  ctx.world.send(
    Shot,
    { x: from.x, y: from.y, z: from.z, yaw: Math.atan2(ey, ex), pitch: Math.asin(ez / len), dist: len, impact, shooter: shooter.id, weapon: opts.weapon ?? 0, quiet: opts.quiet ?? false },
    { to: 'near', x: from.x, y: from.y, radius: 230 },
  );
  if (hit) {
    ctx.world.send(
      Damage,
      { target: hit.id, amount, attacker: shooter.id, cause: DamageCause.Bullet, kx: d.x * 3, ky: d.y * 3, head },
      { to: 'owner', entity: hit },
    );
  }
  return { entity: hit, head, dist: hitT };
}
