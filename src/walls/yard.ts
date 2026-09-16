import type { Vec3 } from '../crossplay/math';
import { Surface, type SurfaceSpec, type WallHit } from './wall';

/**
 * The yard: a walled lot, open to the street on the south side, with a freestanding board to paint both sides
 * of, and a rack of paint by the gate. Nothing about it is random or sent: every peer builds the same one.
 */

/** Inside of the perimeter walls, meters. */
export const YARD = { x0: -15, x1: 15, y0: -10, y1: 10 };
export const WALL_HEIGHT = 5;
export const WALL_THICKNESS = 0.4;

/** The freestanding board: a box on the ground. */
export const BOARD = { x0: 3, x1: 11, y: -3.5, thickness: 0.3, height: 3 };

export const SURFACES: readonly SurfaceSpec[] = [
  { name: 'North wall', x: 0, y: YARD.y1, z: 0, nx: 0, ny: -1, width: YARD.x1 - YARD.x0, height: WALL_HEIGHT, finish: 'block', base: 0xb9b4aa },
  { name: 'West wall', x: YARD.x0, y: 0, z: 0, nx: 1, ny: 0, width: YARD.y1 - YARD.y0, height: WALL_HEIGHT, finish: 'block', base: 0xafaaa2 },
  { name: 'East wall', x: YARD.x1, y: 0, z: 0, nx: -1, ny: 0, width: YARD.y1 - YARD.y0, height: WALL_HEIGHT, finish: 'block', base: 0xb3aea5 },
  { name: 'Board, north side', x: (BOARD.x0 + BOARD.x1) / 2, y: BOARD.y + BOARD.thickness / 2, z: 0, nx: 0, ny: 1, width: BOARD.x1 - BOARD.x0, height: BOARD.height, finish: 'board', base: 0xd8c8a8 },
  { name: 'Board, south side', x: (BOARD.x0 + BOARD.x1) / 2, y: BOARD.y - BOARD.thickness / 2, z: 0, nx: 0, ny: -1, width: BOARD.x1 - BOARD.x0, height: BOARD.height, finish: 'board', base: 0xd2c2a2 },
];

/** A fresh set of bare walls. */
export function buildSurfaces(): Surface[] {
  return SURFACES.map((spec, i) => new Surface(i, spec));
}

/** The nearest wall face along a ray within `reach`. */
export function pickWall(surfaces: readonly Surface[], origin: Vec3, dir: Vec3, reach: number): WallHit | null {
  let best: WallHit | null = null;
  for (const s of surfaces) {
    const hit = s.hit(origin, dir, reach);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  // the board stands in front of part of the north wall: don't paint through it
  if (best && best.surface < 3 && boardBlocks(origin, dir, best.distance)) return null;
  return best;
}

function boardBlocks(o: Vec3, d: Vec3, within: number): boolean {
  if (Math.abs(d.y) < 1e-6) return false;
  for (const face of [BOARD.y - BOARD.thickness / 2, BOARD.y + BOARD.thickness / 2]) {
    const t = (face - o.y) / d.y;
    if (t < 0 || t > within) continue;
    const x = o.x + d.x * t;
    const z = o.z + d.z * t;
    if (x >= BOARD.x0 && x <= BOARD.x1 && z >= 0 && z <= BOARD.height) return true;
  }
  return false;
}

/** Keep a body of `radius` in the yard and out of the board. */
export function collide(p: { x: number; y: number }, radius: number): void {
  p.x = Math.min(YARD.x1 - radius, Math.max(YARD.x0 + radius, p.x));
  p.y = Math.min(YARD.y1 - radius, Math.max(STREET_Y + radius, p.y));
  pushOut(p, BOARD.x0, BOARD.x1, BOARD.y - BOARD.thickness / 2, BOARD.y + BOARD.thickness / 2, radius);
  const w = rackWidth() / 2 + 0.1;
  pushOut(p, RACK.x - w, RACK.x + w, RACK.y - 0.1, RACK.y + 0.32, radius);
}

/** Push a circle out of an axis-aligned box, the shortest way. */
function pushOut(p: { x: number; y: number }, bx0: number, bx1: number, by0: number, by1: number, radius: number): void {
  const x0 = bx0 - radius;
  const x1 = bx1 + radius;
  const y0 = by0 - radius;
  const y1 = by1 + radius;
  if (p.x <= x0 || p.x >= x1 || p.y <= y0 || p.y >= y1) return;
  const pushes = [x0 - p.x, x1 - p.x, y0 - p.y, y1 - p.y];
  const least = pushes.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
  if (least === pushes[0] || least === pushes[1]) p.x += least;
  else p.y += least;
}

/** How far south of the yard you can wander: onto the pavement outside the gate. */
export const STREET_Y = YARD.y0 - 4;

/** Where painters arrive: by the gate, looking up the yard at the big wall. */
export function spawnPoint(): { x: number; y: number; heading: number } {
  return { x: -6 + (Math.random() - 0.5) * 4, y: -7 + (Math.random() - 0.5) * 2, heading: Math.PI / 2 };
}

// ---------------------------------------------------------------------------
// The paint rack
// ---------------------------------------------------------------------------

/** The colours on the rack. The last one is buff: the wall's own grey, for painting over mistakes. */
export const PALETTE: readonly { name: string; rgb: number }[] = [
  { name: 'White', rgb: 0xf5f3ee },
  { name: 'Black', rgb: 0x16161a },
  { name: 'Red', rgb: 0xe0282e },
  { name: 'Orange', rgb: 0xf57c1f },
  { name: 'Yellow', rgb: 0xffd21f },
  { name: 'Lime', rgb: 0x8ee03a },
  { name: 'Green', rgb: 0x16a05a },
  { name: 'Teal', rgb: 0x16b5b0 },
  { name: 'Sky', rgb: 0x4cc3ff },
  { name: 'Blue', rgb: 0x2451d6 },
  { name: 'Purple', rgb: 0x7a3fd1 },
  { name: 'Pink', rgb: 0xff5fae },
  { name: 'Chrome', rgb: 0xc9ced6 },
  { name: 'Gold', rgb: 0xc99a2e },
  { name: 'Brown', rgb: 0x6e4526 },
  { name: 'Buff', rgb: 0xb4afa6 },
];

/**
 * The rack stands by the gate, facing into the yard: two rows of eight swatches, each
 * with a can on the shelf below. Point any tool at a swatch and use it to load that colour.
 */
export const RACK = { x: -9, y: YARD.y0 + 0.6, z: 0.95, cols: 8, rows: 2, size: 0.32, gap: 0.06 };

export function rackWidth(): number {
  return RACK.cols * RACK.size + (RACK.cols - 1) * RACK.gap;
}

export function rackHeight(): number {
  return RACK.rows * RACK.size + (RACK.rows - 1) * RACK.gap;
}

/** A swatch's middle. The rack faces +y, so seen from in front, right is +x. */
export function swatchAt(i: number): Vec3 {
  const col = i % RACK.cols;
  const row = Math.floor(i / RACK.cols);
  const step = RACK.size + RACK.gap;
  return { x: RACK.x - rackWidth() / 2 + RACK.size / 2 + col * step, y: RACK.y, z: RACK.z + rackHeight() - RACK.size / 2 - row * step };
}

/** The swatch along a ray within `reach`, and how far away it is. */
export function pickSwatch(origin: Vec3, dir: Vec3, reach: number): { color: number; distance: number } | null {
  // it faces +y, so it's only seen from the yard side
  if (dir.y > -1e-6) return null;
  const t = (RACK.y - origin.y) / dir.y;
  if (t < 0 || t > reach || origin.y < RACK.y) return null;
  const x = origin.x + dir.x * t;
  const z = origin.z + dir.z * t;
  for (let i = 0; i < PALETTE.length; i++) {
    const c = swatchAt(i);
    if (Math.abs(x - c.x) <= RACK.size / 2 && Math.abs(z - c.z) <= RACK.size / 2) return { color: i, distance: t };
  }
  return null;
}
