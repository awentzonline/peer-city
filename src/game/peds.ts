import { DIR_X, DIR_Y, TILE, type City } from './city';
import type { GameContext, PedEntity } from './context';
import { Ped, PedMode } from './defs';

const WALK_SPEED = 42;
const RUN_SPEED = 130;
const RADIUS = 7;

interface PedLocal {
  dir?: number;
  fleeUntil?: number;
  fx?: number;
  fy?: number;
  deadAt?: number;
}

/** Axis-separated circle movement against the tile grid. Returns true if blocked. */
export function moveCircle(city: City, s: { x: number; y: number }, dx: number, dy: number, r: number): boolean {
  let blocked = false;
  if (!city.circleBlocked(s.x + dx, s.y, r)) s.x += dx;
  else blocked = true;
  if (!city.circleBlocked(s.x, s.y + dy, r)) s.y += dy;
  else blocked = true;
  return blocked;
}

export function updateOwnedPeds(ctx: GameContext, dt: number): void {
  const { world, city, now } = ctx;
  for (const p of world.all(Ped)) {
    if (!p.mine) continue;
    const s = p.state;
    const l = p.local as PedLocal;

    if (s.mode === PedMode.Dead) {
      l.deadAt ??= now;
      if (now - l.deadAt > 20000) world.despawn(p);
      continue;
    }

    if (s.mode === PedMode.Attack) continue; // officers in pursuit run police.ts

    if (s.mode === PedMode.Flee) {
      if (now > (l.fleeUntil ?? 0)) {
        s.mode = PedMode.Walk;
        retarget(city, p);
        continue;
      }
      const wobble = Math.sin(now / 280 + (p.id % 17)) * 0.5;
      const a = Math.atan2(s.y - (l.fy ?? s.y), s.x - (l.fx ?? s.x)) + wobble;
      if (moveCircle(city, s, Math.cos(a) * RUN_SPEED * dt, Math.sin(a) * RUN_SPEED * dt, RADIUS)) {
        // cornered: veer along the wall
        l.fx = s.x - Math.cos(a + 1.2) * 50;
        l.fy = s.y - Math.sin(a + 1.2) * 50;
      }
      s.angle = a;
      continue;
    }

    const gx = (s.tx + 0.5) * TILE;
    const gy = (s.ty + 0.5) * TILE;
    const dx = gx - s.x;
    const dy = gy - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 3 || (s.tx === 0 && s.ty === 0)) {
      chooseNextTile(city, p);
      continue;
    }
    const step = Math.min(d, WALK_SPEED * dt);
    moveCircle(city, s, (dx / d) * step, (dy / d) * step, RADIUS);
    s.angle = Math.atan2(dy, dx);
  }
}

function chooseNextTile(city: City, p: PedEntity): void {
  const s = p.state;
  const l = p.local as PedLocal;
  const cx = Math.floor(s.x / TILE);
  const cy = Math.floor(s.y / TILE);
  const options: number[] = [];
  for (let d = 0; d < 4; d++) if (city.isWalkableTile(cx + DIR_X[d], cy + DIR_Y[d])) options.push(d);
  if (options.length === 0) {
    s.tx = cx;
    s.ty = cy;
    return;
  }
  const reverse = l.dir === undefined ? -1 : (l.dir + 2) % 4;
  let pool = options.length > 1 ? options.filter((d) => d !== reverse) : options;
  if (pool.length === 0) pool = options;
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (l.dir !== undefined && pool.includes(l.dir) && Math.random() < 0.8) pick = l.dir;
  l.dir = pick;
  s.tx = cx + DIR_X[pick];
  s.ty = cy + DIR_Y[pick];
}

/** Head for the nearest walkable tile and resume wandering from there. */
export function retarget(city: City, p: PedEntity): void {
  const s = p.state;
  const cx = Math.floor(s.x / TILE);
  const cy = Math.floor(s.y / TILE);
  for (let r = 0; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (city.isWalkableTile(cx + dx, cy + dy)) {
          s.tx = cx + dx;
          s.ty = cy + dy;
          (p.local as PedLocal).dir = undefined;
          return;
        }
      }
    }
  }
  s.tx = cx;
  s.ty = cy;
}

/** Owned pedestrians near a disturbance run away from it. Police don't. */
export function panicPeds(ctx: GameContext, x: number, y: number, radius: number): void {
  for (const p of ctx.world.query(x, y, radius, Ped)) {
    if (!p.mine || p.state.cop || p.state.mode === PedMode.Dead) continue;
    const l = p.local as PedLocal;
    p.state.mode = PedMode.Flee;
    l.fx = x;
    l.fy = y;
    l.fleeUntil = ctx.now + 4000 + Math.random() * 3000;
  }
}
