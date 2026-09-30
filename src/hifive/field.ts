import { FlowPaths, type Pose, type Spot, type WalkGrid, type Walkable } from '@engine/index';

/**
 * The grounds: a locker room, a tunnel out of it, and the field. Meters, world axes (x, y on the ground, z up), all
 * on the positive side so the pathing grid (cells from 0) covers them. North is +y: the tunnel runs north from the
 * locker room onto the south end of the field, and the jumbotron stands beyond the north end zone.
 */

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Where you can stand in the locker room: the lockers line its walls, outside this. */
export const LOCKER: Rect = { x0: 20.6, x1: 39.4, y0: 4.6, y1: 18 };
/** The tunnel, overlapping both rooms so the doorways are open. */
export const TUNNEL: Rect = { x0: 28.2, x1: 31.8, y0: 17, y1: 28 };
export const FIELD: Rect = { x0: 6, x1: 54, y0: 27, y1: 72 };
export const ROOMS: readonly Rect[] = [LOCKER, TUNNEL, FIELD];

/** The locker room's real walls (the lockers stand inside them) and ceiling. */
export const LOCKER_WALLS: Rect = { x0: 20, x1: 40, y0: 4, y1: 18 };
export const CEILING = 3.4;
export const TUNNEL_HEIGHT = 3.2;

/** Benches down the middle of the locker room, knee high. */
export const BENCHES: readonly Rect[] = [
  { x0: 22.5, x1: 28.5, y0: 10.75, y1: 11.25 },
  { x0: 31.5, x1: 37.5, y0: 10.75, y1: 11.25 },
];
export const BENCH_HEIGHT = 0.45;
/** Things on the field you can't walk through: the goalpost's foot, at the north end (the tunnel comes out at the south). */
export const POSTS: readonly Rect[] = [{ x0: 29.8, x1: 30.2, y0: 70.3, y1: 70.7 }];
const OBSTACLES: readonly Rect[] = [...BENCHES, ...POSTS];

/** Cells per side of the pathing grid. */
const GRID = 76;

/**
 * Keep a body of radius `r` on its feet somewhere it can stand: out of the benches and posts, and inside the rooms,
 * pushed to the nearest place in them when it isn't. True if it had to be moved.
 */
export function collide(p: { x: number; y: number }, r: number): boolean {
  let moved = false;
  for (const o of OBSTACLES) moved = pushOut(p, o, r) || moved;
  if (inRooms(p.x, p.y, r)) return moved;
  let bx = p.x;
  let by = p.y;
  let best = Infinity;
  for (const room of ROOMS) {
    const x = clampTo(p.x, room.x0 + r, room.x1 - r);
    const y = clampTo(p.y, room.y0 + r, room.y1 - r);
    const d = (x - p.x) ** 2 + (y - p.y) ** 2;
    if (d < best) {
      best = d;
      bx = x;
      by = y;
    }
  }
  p.x = bx;
  p.y = by;
  return true;
}

/** Whether a body of radius `r` at (x, y) is inside one of the rooms. */
export function inRooms(x: number, y: number, r = 0): boolean {
  return ROOMS.some((room) => x >= room.x0 + r && x <= room.x1 - r && y >= room.y0 + r && y <= room.y1 - r);
}

/** Whether a body of radius `r` could stand at (x, y): in the rooms and clear of everything in them. */
export function standable(x: number, y: number, r: number): boolean {
  return inRooms(x, y, r) && !OBSTACLES.some((o) => x > o.x0 - r && x < o.x1 + r && y > o.y0 - r && y < o.y1 + r);
}

function pushOut(p: { x: number; y: number }, o: Rect, r: number): boolean {
  const x0 = o.x0 - r;
  const x1 = o.x1 + r;
  const y0 = o.y0 - r;
  const y1 = o.y1 + r;
  if (p.x <= x0 || p.x >= x1 || p.y <= y0 || p.y >= y1) return false;
  const left = p.x - x0;
  const right = x1 - p.x;
  const down = p.y - y0;
  const up = y1 - p.y;
  const m = Math.min(left, right, down, up);
  if (m === left) p.x = x0;
  else if (m === right) p.x = x1;
  else if (m === down) p.y = y0;
  else p.y = y1;
  return true;
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Where a new pal comes in: somewhere in the locker room between the benches and the tunnel, facing it. */
export function spawnPoint(rand = Math.random): { x: number; y: number; heading: number } {
  for (let i = 0; i < 20; i++) {
    const x = 24 + rand() * 12;
    const y = 12.5 + rand() * 4;
    if (standable(x, y, 0.4)) return { x, y, heading: Math.PI / 2 };
  }
  return { x: 30, y: 14, heading: Math.PI / 2 };
}

/** Somewhere to stroll to, for a buddy: in the locker room or out on the field. */
export function strollSpot(rand = Math.random): Spot {
  for (let i = 0; i < 20; i++) {
    const inside = rand() < 0.4;
    const room = inside ? LOCKER : FIELD;
    const x = room.x0 + 1 + rand() * (room.x1 - room.x0 - 2);
    const y = room.y0 + 1 + rand() * (room.y1 - room.y0 - 2);
    if (standable(x, y, 0.5)) return { x, y };
  }
  return { x: 30, y: 40 };
}

class Grid implements WalkGrid {
  readonly size = GRID;

  open(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < GRID && j < GRID && standable(i + 0.5, j + 0.5, 0.3);
  }

  nearestOpen(x: number, y: number): Spot {
    const ci = Math.floor(x);
    const cj = Math.floor(y);
    for (let r = 0; r < GRID; r++) {
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          if (this.open(i, j)) return { x: i + 0.5, y: j + 0.5 };
        }
      }
    }
    return { x: 30, y: 40 };
  }
}

/** The grounds as the buddies walk them: the ways between the rooms, and the same walls everyone else has. */
export class Grounds implements Walkable {
  readonly paths = new FlowPaths(new Grid());
  readonly turnRate = 7;

  move(p: Pose, dx: number, dy: number, r: number): boolean {
    p.x += dx;
    p.y += dy;
    return collide(p, r);
  }
}
