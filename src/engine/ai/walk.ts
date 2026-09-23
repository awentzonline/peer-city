import type { Spot } from '../spatial/FlowPaths';

/** Where a body is and which way it faces: the part of an entity's state that walking moves. */
export interface Pose {
  x: number;
  y: number;
  angle: number;
}

/** Something that says where to head next on the way somewhere (see `FlowPaths`). */
export interface Wayfinder {
  next(x: number, y: number, tx: number, ty: number, r: number, now: number): Spot | null;
}

/** What a walking body remembers between frames: keep it in a `defineLocal`, it needn't survive a change of owner. */
export interface WalkMemory {
  /** When to ask the way again, ms, and where it was last told to go. */
  nextPath: number;
  waypoint: Spot | null;
  /** Wandering: stand about until then, ms. */
  restUntil: number;
}

export function walkMemory(): WalkMemory {
  return { nextPath: 0, waypoint: null, restUntil: 0 };
}

/** The ground a body walks on: what stops it, and how it asks the way. */
export interface Walkable {
  paths: Wayfinder;
  /** Move a body of radius `r`, sliding along whatever's in the way. True if it bumped into something. */
  move(p: Pose, dx: number, dy: number, r: number): boolean;
  /** How fast a body turns to face where it's going, 1/s. */
  turnRate: number;
  /** How long a waypoint stands before the way's asked again, ms, plus up to this much more at random. */
  repathMs?: number;
  repathJitterMs?: number;
}

/** Turn a body towards `angle`, at the ground's turn rate. */
export function turnToward(p: Pose, angle: number, dt: number, rate: number): void {
  let d = (angle - p.angle) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  p.angle += d * Math.min(1, dt * rate);
}

/**
 * Head for (tx, ty) at `speed`: straight there, or by way of the ground's paths when `path` is set. Bumping into
 * something asks the way afresh next frame.
 */
export function walkToward(ground: Walkable, p: Pose, mem: WalkMemory, tx: number, ty: number, r: number, speed: number, dt: number, now: number, path: boolean): void {
  let gx = tx;
  let gy = ty;
  if (path) {
    if (now >= mem.nextPath || !mem.waypoint) {
      mem.nextPath = now + (ground.repathMs ?? 250) + Math.random() * (ground.repathJitterMs ?? 100);
      mem.waypoint = ground.paths.next(p.x, p.y, tx, ty, r, now);
    }
    if (!mem.waypoint) return;
    gx = mem.waypoint.x;
    gy = mem.waypoint.y;
    if (Math.hypot(gx - p.x, gy - p.y) < 0.3) mem.nextPath = 0;
  }
  const dx = gx - p.x;
  const dy = gy - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) return;
  const k = Math.min(d, speed * dt) / d;
  if (ground.move(p, dx * k, dy * k, r)) mem.nextPath = 0;
  turnToward(p, Math.atan2(dy, dx), dt, ground.turnRate);
}

export interface WanderOptions {
  /** How long to stand about on arriving, ms, plus up to this much more at random. */
  restMs: number;
  restJitterMs: number;
  /** How far off to pick the next spot, m: at least 2, and up to this much beyond. */
  range: number;
  /** Whether a spot's somewhere to go from here: open ground, and in sight. */
  ok(fromX: number, fromY: number, x: number, y: number): boolean;
}

/** Drift about nearby at `speed`, stopping now and then: `p.tx/ty` is where it's going, picked afresh on arriving. */
export function wander(ground: Walkable, p: Pose & { tx: number; ty: number }, mem: WalkMemory, r: number, speed: number, dt: number, now: number, opts: WanderOptions): void {
  if (now < mem.restUntil) return;
  if (Math.hypot(p.tx - p.x, p.ty - p.y) < 0.6) {
    mem.restUntil = now + opts.restMs + Math.random() * opts.restJitterMs;
    const spot = spotNear(p.x, p.y, opts.range, (x, y) => opts.ok(p.x, p.y, x, y));
    if (spot) {
      p.tx = spot.x;
      p.ty = spot.y;
    }
    return;
  }
  walkToward(ground, p, mem, p.tx, p.ty, r, speed, dt, now, true);
}

/** A cell centre 2 to 2+`range` off that `ok` accepts, trying a few times, or null. */
export function spotNear(x: number, y: number, range: number, ok: (x: number, y: number) => boolean, tries = 8): Spot | null {
  for (let i = 0; i < tries; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 2 + Math.random() * range;
    const px = x + Math.cos(a) * d;
    const py = y + Math.sin(a) * d;
    if (ok(px, py)) return { x: Math.floor(px) + 0.5, y: Math.floor(py) + 0.5 };
  }
  return null;
}

/** A body that can be kept apart from others: an entity with a rendered position and a state to nudge. */
export interface Body {
  readonly x: number;
  readonly y: number;
  state: Pose;
}

/**
 * Keep bodies this peer moves from standing in each other: each is pushed halfway out of any it overlaps, `radius`
 * being each one's, and `standing` whether one's in the way at all (not dead, not carried off).
 */
export function keepApart<B extends Body>(
  ground: Pick<Walkable, 'move'>,
  mine: Iterable<B>,
  near: (x: number, y: number, r: number) => readonly B[],
  radius: (b: B) => number,
  standing: (b: B) => boolean,
  reach = 1.2,
): void {
  for (const b of mine) {
    if (!standing(b)) continue;
    const s = b.state;
    const r = radius(b);
    for (const o of near(s.x, s.y, reach)) {
      if (o === b || !standing(o)) continue;
      const min = r + radius(o);
      const dx = s.x - o.x;
      const dy = s.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d >= min || d < 1e-4) continue;
      const push = (min - d) * 0.5;
      ground.move(s, (dx / d) * push, (dy / d) * push, r);
    }
  }
}
