import type { Vec3 } from '../crossplay/math';
import { GRAVITY } from '../crossplay/rigid';
import { CUP_RADIUS, Lie, type Course, type Tree } from './course';

/**
 * A golf ball's flight, bounces and roll over the course. It isn't in the cart physics world: a ball is small and
 * fast, the ground is a height grid, and what matters is how each kind of ground takes it, so it's simulated on its
 * own in small fixed steps by its owner. Pure: no network, no scene.
 */

export const BALL_RADIUS = 0.021;
const STEP = 1 / 240;
/** Air drag per (m/s)², per m/s², for a real ball's size and weight. */
const DRAG = 0.0042;
/** Lift from backspin, at full spin. */
const LIFT = 0.0031;
/** Spin dies away over a flight: seconds. */
const SPIN_LIFE = 3.5;
/** Slower than this on the ground, and not pulled along by the slope, a ball stops. */
const STOP_SPEED = 0.07;

/** How the ground takes a ball. */
export interface Ground {
  /** Of the speed into the ground, how much comes back out. */
  bounce: number;
  /** Of the speed along the ground, how much a bounce keeps. */
  keep: number;
  /** Rolling resistance: deceleration, m/s². */
  roll: number;
}

export const GROUNDS: Record<Lie, Ground> = {
  [Lie.Rough]: { bounce: 0.22, keep: 0.5, roll: 5.5 },
  [Lie.Fairway]: { bounce: 0.34, keep: 0.72, roll: 2.6 },
  [Lie.Green]: { bounce: 0.24, keep: 0.78, roll: 0.62 },
  [Lie.Tee]: { bounce: 0.32, keep: 0.72, roll: 2.6 },
  [Lie.Sand]: { bounce: 0.04, keep: 0.15, roll: 9 },
  [Lie.Water]: { bounce: 0, keep: 0, roll: 20 },
  [Lie.Out]: { bounce: 0.3, keep: 0.6, roll: 4 },
  [Lie.Path]: { bounce: 0.55, keep: 0.85, roll: 1.6 },
};

export const enum Club {
  Driver = 0,
  Iron = 1,
  Wedge = 2,
  Putter = 3,
}

export interface ClubSpec {
  name: string;
  /** Launch angle, radians. */
  loft: number;
  /** Ball speed off the face at full power, m/s. */
  speed: number;
  /** Backspin, 0..1: lift in the air, and how much a bounce is checked. */
  spin: number;
  /** A tracked swing: ball speed per m/s of club head speed. */
  smash: number;
  /** How much of its power a club gets from each lie. */
  lies: Partial<Record<Lie, number>>;
}

export const CLUBS: readonly ClubSpec[] = [
  { name: 'Driver', loft: 0.24, speed: 74, spin: 0.5, smash: 3.8, lies: { [Lie.Fairway]: 0.9, [Lie.Rough]: 0.6, [Lie.Sand]: 0.35, [Lie.Green]: 0.85 } },
  { name: 'Iron', loft: 0.38, speed: 50, spin: 0.62, smash: 2.8, lies: { [Lie.Rough]: 0.78, [Lie.Sand]: 0.5 } },
  { name: 'Wedge', loft: 0.8, speed: 33, spin: 1, smash: 2, lies: { [Lie.Rough]: 0.9, [Lie.Sand]: 0.92 } },
  { name: 'Putter', loft: 0.02, speed: 7, spin: 0, smash: 1.25, lies: { [Lie.Rough]: 0.55, [Lie.Sand]: 0.25 } },
];

export function lieFactor(club: Club, lie: Lie): number {
  return CLUBS[club].lies[lie] ?? 1;
}

export const enum Flight {
  /** Sitting still, ready to be struck. */
  Rest = 0,
  Air = 1,
  Rolling = 2,
  /** In the cup. */
  Holed = 3,
}

/** What happened to a ball in a step. */
export type BallEvent = 'bounce' | 'tree' | 'lip' | 'holed' | 'water' | 'out' | 'rest';

export interface BallState extends Vec3 {
  vx: number;
  vy: number;
  vz: number;
  flight: Flight;
  spin: number;
  /** Seconds since it was struck. */
  t: number;
}

export function ballAt(x: number, y: number, z: number): BallState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, flight: Flight.Rest, spin: 0, t: 0 };
}

/**
 * Strike a resting ball with a club: `power` 0..1 of the club's full swing, along `heading`, from whatever lie it's
 * in. A putter rolls it; everything else launches it at the club's loft. Distance goes roughly with the square of
 * speed, so power is eased into speed to make half power go about half as far.
 */
export function strike(ball: BallState, club: Club, power: number, heading: number, lie: Lie): void {
  const spec = CLUBS[club];
  launch(ball, club, spec.speed * Math.sqrt(Math.min(1, Math.max(0, power))) * lieFactor(club, lie), heading, spec.loft);
}

/** Send a ball off at `speed` along `heading`, `loft` radians up, with a club's spin. */
export function launch(ball: BallState, club: Club, speed: number, heading: number, loft: number): void {
  const spec = CLUBS[club];
  const h = Math.cos(loft) * speed;
  ball.vx = Math.cos(heading) * h;
  ball.vy = Math.sin(heading) * h;
  ball.vz = Math.sin(loft) * speed;
  ball.spin = spec.spin;
  ball.t = 0;
  ball.flight = club === Club.Putter || loft < 0.05 ? Flight.Rolling : Flight.Air;
  if (ball.flight === Flight.Air) ball.z += 0.01;
}

const n: Vec3 = { x: 0, y: 0, z: 1 };

/**
 * Move a ball on `dt` seconds over the course, toward a cup at `pin`. Returns what happened, most important last
 * (a ball can bounce and then drop in the same frame), or null if nothing did.
 */
export function stepBall(ball: BallState, course: Course, pin: Vec3, dt: number, rnd: () => number = Math.random): BallEvent | null {
  if (ball.flight === Flight.Rest || ball.flight === Flight.Holed) return null;
  let event: BallEvent | null = null;
  let left = Math.min(dt, 0.25);
  while (left > 1e-9 && (ball.flight === Flight.Air || ball.flight === Flight.Rolling)) {
    const h = Math.min(STEP, left);
    left -= h;
    const e = ball.flight === Flight.Air ? fly(ball, course, pin, h) : roll(ball, course, pin, h, rnd);
    if (e) event = e;
    if (e === 'water' || e === 'out' || e === 'holed') break;
  }
  return event;
}

/** Move a ball through the air for `h` seconds: gravity, drag against the motion, and lift from its backspin. */
function air(ball: BallState, h: number): void {
  ball.t += h;
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  const spin = ball.spin * Math.exp(-ball.t / SPIN_LIFE);
  const horiz = Math.hypot(ball.vx, ball.vy);
  ball.vx -= DRAG * speed * ball.vx * h;
  ball.vy -= DRAG * speed * ball.vy * h;
  ball.vz += (-GRAVITY - DRAG * speed * ball.vz + LIFT * spin * horiz * horiz) * h;
  ball.x += ball.vx * h;
  ball.y += ball.vy * h;
  ball.z += ball.vz * h;
}

function fly(ball: BallState, course: Course, pin: Vec3, h: number): BallEvent | null {
  air(ball, h);
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  const spin = ball.spin * Math.exp(-ball.t / SPIN_LIFE);
  if (course.outOfBounds(ball.x, ball.y)) return 'out';
  const trunk = hitTrees(ball, course);
  const ground = course.heightAt(ball.x, ball.y);
  if (ball.z > ground + BALL_RADIUS * 0.5) return trunk;

  const lie = course.lieAt(ball.x, ball.y);
  if (lie === Lie.Water) return 'water';
  // straight into the cup
  if (Math.hypot(ball.x - pin.x, ball.y - pin.y) < CUP_RADIUS && speed < 6) {
    ball.flight = Flight.Holed;
    return 'holed';
  }
  ball.z = ground + BALL_RADIUS * 0.5;
  course.normalAt(ball.x, ball.y, n);
  const g = GROUNDS[lie];
  const into = ball.vx * n.x + ball.vy * n.y + ball.vz * n.z;
  // the part of the velocity along the ground, and the part into it
  const tx = ball.vx - into * n.x;
  const ty = ball.vy - into * n.y;
  const tz = ball.vz - into * n.z;
  // backspin checks the ball on its first bounces
  const keep = g.keep * (1 - 0.7 * spin);
  const out = -into * g.bounce;
  ball.vx = tx * keep + n.x * out;
  ball.vy = ty * keep + n.y * out;
  ball.vz = tz * keep + n.z * out;
  ball.spin *= 0.75;
  if (out < 1.2) {
    ball.flight = Flight.Rolling;
    ball.vz = tz * keep;
  }
  return trunk ?? 'bounce';
}

function roll(ball: BallState, course: Course, pin: Vec3, h: number, rnd: () => number): BallEvent | null {
  ball.t += h;
  const lie = course.lieAt(ball.x, ball.y);
  if (lie === Lie.Water) return 'water';
  if (course.outOfBounds(ball.x, ball.y)) return 'out';
  const g = GROUNDS[lie];
  course.normalAt(ball.x, ball.y, n);
  // gravity along the slope
  const gx = GRAVITY * n.z * n.x;
  const gy = GRAVITY * n.z * n.y;
  const slope = Math.hypot(gx, gy);
  let vx = ball.vx;
  let vy = ball.vy;
  const speed = Math.hypot(vx, vy);
  if (speed < STOP_SPEED && slope < g.roll * 0.9) {
    ball.vx = ball.vy = ball.vz = 0;
    ball.z = course.heightAt(ball.x, ball.y) + BALL_RADIUS * 0.5;
    ball.flight = Flight.Rest;
    return 'rest';
  }
  vx += gx * h;
  vy += gy * h;
  const s2 = Math.hypot(vx, vy);
  // backspin left over from the flight bites and stops it sooner
  ball.spin *= Math.exp(-h * 1.2);
  if (s2 > 0) {
    const slow = Math.min(s2, g.roll * (1 + 8 * ball.spin) * h);
    vx -= (vx / s2) * slow;
    vy -= (vy / s2) * slow;
  }
  ball.vx = vx;
  ball.vy = vy;
  ball.x += vx * h;
  ball.y += vy * h;
  // a fast ball off a crest takes off again
  const ground = course.heightAt(ball.x, ball.y);
  const lift = ball.z + ball.vz * h - (ground + BALL_RADIUS * 0.5);
  if (lift > 0.08 && s2 > 8) {
    ball.flight = Flight.Air;
    ball.z += ball.vz * h;
  } else {
    ball.z = ground + BALL_RADIUS * 0.5;
    ball.vz = (vx * -n.x + vy * -n.y) / Math.max(n.z, 0.3);
  }
  const trunk = hitTrees(ball, course);

  const dx = ball.x - pin.x;
  const dy = ball.y - pin.y;
  if (dx * dx + dy * dy < CUP_RADIUS * CUP_RADIUS) {
    const v = Math.hypot(ball.vx, ball.vy);
    if (v < 1.7) {
      ball.flight = Flight.Holed;
      ball.vx = ball.vy = ball.vz = 0;
      ball.z = pin.z - 0.08;
      return 'holed';
    }
    if (ball.t > 0.05) {
      // too fast: it lips out, knocked off line and slowed
      const a = (rnd() - 0.5) * 1.4;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ball.vx = (vx * c - vy * s) * 0.55;
      ball.vy = (vx * s + vy * c) * 0.55;
      ball.x = pin.x + (dx / Math.hypot(dx, dy || 1e-6)) * CUP_RADIUS * 1.05;
      ball.y = pin.y + (dy / Math.hypot(dx || 1e-6, dy)) * CUP_RADIUS * 1.05;
      ball.t = 0;
      return 'lip';
    }
  }
  return trunk;
}

/** Trunks knock a ball back; canopies catch and drop it. */
function hitTrees(ball: BallState, course: Course): BallEvent | null {
  let event: BallEvent | null = null;
  for (const t of course.treesNear(ball.x, ball.y, 0.5)) {
    const dx = ball.x - t.x;
    const dy = ball.y - t.y;
    const d = Math.hypot(dx, dy);
    const up = ball.z - t.z;
    if (up < t.height * 0.55 && d < t.trunk + BALL_RADIUS) {
      const nx = dx / (d || 1);
      const ny = dy / (d || 1);
      const into = ball.vx * nx + ball.vy * ny;
      if (into < 0) {
        ball.vx = (ball.vx - 2 * into * nx) * 0.45;
        ball.vy = (ball.vy - 2 * into * ny) * 0.45;
        ball.x = t.x + nx * (t.trunk + BALL_RADIUS);
        ball.y = t.y + ny * (t.trunk + BALL_RADIUS);
        event = 'tree';
      }
    } else if (inCanopy(t, d, up) && ball.flight === Flight.Air && Math.hypot(ball.vx, ball.vy) > 4) {
      // leaves and branches: most of its speed goes, in a random direction
      ball.vx *= 0.25 + Math.random() * 0.1;
      ball.vy *= 0.25 + Math.random() * 0.1;
      ball.vz = Math.min(ball.vz, 0) * 0.3;
      event = 'tree';
    }
  }
  return event;
}

function inCanopy(t: Tree, d: number, up: number): boolean {
  const mid = t.height * 0.7;
  const spread = t.canopy * (1 - Math.abs(up - mid) / (t.height * 0.45));
  return up > t.height * 0.35 && up < t.height * 1.05 && d < spread;
}

/** Where a shot would first come down, for an aiming guide: simulated on a copy, with no cup or trees. */
export function carry(from: Vec3, club: Club, power: number, heading: number, lie: Lie, course: Course): Vec3 {
  const b = ballAt(from.x, from.y, from.z + BALL_RADIUS * 0.5);
  strike(b, club, power, heading, lie);
  if (b.flight === Flight.Rolling) {
    // a putt: roughly where it stops on flat ground
    const s = Math.hypot(b.vx, b.vy);
    const d = (s * s) / (2 * GROUNDS[Lie.Green].roll);
    return { x: from.x + Math.cos(heading) * d, y: from.y + Math.sin(heading) * d, z: course.heightAt(from.x + Math.cos(heading) * d, from.y + Math.sin(heading) * d) };
  }
  for (let i = 0; i < 240 * 20; i++) {
    air(b, STEP);
    if (b.vz < 0 && b.z <= course.heightAt(b.x, b.y) + BALL_RADIUS * 0.5) break;
  }
  return { x: b.x, y: b.y, z: course.heightAt(b.x, b.y) };
}
