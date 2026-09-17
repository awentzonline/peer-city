import { mulberry32 } from '@engine/index';
import type { Vec3 } from '../crossplay/math';

/**
 * Peer Golf's course: six holes in a loop over rolling ground, so the last green is a short walk from the first tee.
 * It's generated from a seed, so every peer builds the same course and none of it is sent.
 *
 * World axes, meters: x and y on the ground, z up. The ground is a height grid, split into triangles the same way
 * the scene and the cart physics split it, so a ball rests exactly on what's drawn.
 */

/** Half the width of the square the course covers, m. It runs from (0, 0) to (2 HALF, 2 HALF), all positive so it sits in one network zone; beyond it is out of bounds. */
export const HALF = 330;
/** Height grid spacing, m. */
export const GRID = 2;
/** Grid points along each side. */
export const N = Math.round((HALF * 2) / GRID) + 1;
/** Where surfaces are sampled, m per cell. */
const LIE_GRID = 1;
const LIE_N = (HALF * 2) / LIE_GRID;

export const CUP_RADIUS = 0.054;

/** What the ground is like at a spot: how a ball bounces and rolls on it, and how well it can be struck from it. */
export const enum Lie {
  Rough = 0,
  Fairway = 1,
  Green = 2,
  Tee = 3,
  Sand = 4,
  Water = 5,
  Out = 6,
  Path = 7,
}

export const LIE_NAMES = ['Rough', 'Fairway', 'Green', 'Tee box', 'Bunker', 'Water', 'Out of bounds', 'Cart path'];

export interface Pond {
  x: number;
  y: number;
  r: number;
  /** The water's surface height. */
  z: number;
}

export interface Bunker {
  x: number;
  y: number;
  r: number;
}

export interface Tree {
  x: number;
  y: number;
  /** Ground height at the trunk. */
  z: number;
  trunk: number;
  height: number;
  canopy: number;
  kind: number;
}

export interface Hole {
  index: number;
  par: number;
  tee: { x: number; y: number; z: number; heading: number };
  pin: { x: number; y: number; z: number };
  green: { x: number; y: number; r: number };
  /** The centre line from tee to green, sampled every few meters. */
  line: { x: number; y: number }[];
  /** Tee to pin along the line, m. */
  length: number;
  /** Half the fairway's width, m. */
  width: number;
  bunkers: Bunker[];
  ponds: Pond[];
}

/** A spot to park a cart at the barn. */
export interface Bay {
  x: number;
  y: number;
  heading: number;
}

const PARS = [4, 3, 5, 4, 3, 4];
export const HOLES = PARS.length;
const LENGTHS = [235, 130, 305, 220, 140, 245];
/** Walk from a green to the next tee, m. */
const GAP = 34;

/** Seeded 2D value noise in [-1, 1]. */
function valueNoise(seed: number): (x: number, y: number) => number {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(256).map((_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const vals = new Float32Array(256).map(() => rnd() * 2 - 1);
  const at = (ix: number, iy: number) => vals[perm[(perm[ix & 255] + iy) & 255]];
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Distance from a point to a polyline, and how far along it the nearest point is. */
function toLine(line: { x: number; y: number }[], x: number, y: number): { d: number; u: number } {
  let best = Infinity;
  let bestU = 0;
  let along = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const px = a.x + dx * t - x;
    const py = a.y + dy * t - y;
    const d = px * px + py * py;
    if (d < best) {
      best = d;
      bestU = along + t * len;
    }
    along += len;
  }
  return { d: Math.sqrt(best), u: bestU };
}

export class Course {
  readonly holes: Hole[] = [];
  readonly trees: Tree[] = [];
  /** Where carts start and are brought back to, beside the first tee. */
  readonly barn: { x: number; y: number; heading: number; bays: Bay[] };
  readonly clubhouse: { x: number; y: number; w: number; d: number; heading: number };
  readonly heights = new Float32Array(N * N);
  private readonly lies = new Uint8Array(LIE_N * LIE_N);
  private readonly treeCells = new Map<number, Tree[]>();
  private readonly ponds: Pond[] = [];

  constructor(readonly seed: number) {
    const rnd = mulberry32(seed);
    const big = valueNoise(seed ^ 0x51f1);
    const small = valueNoise(seed ^ 0x2bd3);
    const base = (x: number, y: number) => 9 * big(x / 150 + 20, y / 150 + 20) + 4 * big(x / 70 + 50, y / 70) + 1.6 * small(x / 28, y / 28);
    const roughBits = (x: number, y: number) => 1.6 * small(x / 28, y / 28);

    this.layHoles(rnd, base);
    const first = this.holes[0];
    // the clubhouse and cart barn sit near the first tee, somewhere clear of every hole
    const back = first.tee.heading + Math.PI;
    let bx = 0;
    let by = 0;
    let best = -Infinity;
    for (let r = 45; r <= 90; r += 15) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = first.tee.x + Math.cos(a) * r;
        const y = first.tee.y + Math.sin(a) * r;
        if (Math.max(Math.abs(x - HALF), Math.abs(y - HALF)) > HALF - 90) continue;
        const room = Math.min(...this.holes.map((h) => Math.min(toLine(h.line, x, y).d - h.width, Math.hypot(x - h.green.x, y - h.green.y) - h.green.r, ...h.ponds.map((p) => Math.hypot(x - p.x, y - p.y) - p.r))));
        // roomy enough for the barn, then as close to the tee as that allows
        const score = Math.min(room, 48) - r * 0.3;
        if (score > best) {
          best = score;
          bx = x;
          by = y;
        }
      }
    }
    const bays: Bay[] = [];
    for (let i = 0; i < 8; i++) {
      const side = (i - 3.5) * 3.2;
      bays.push({ x: bx + Math.cos(first.tee.heading + Math.PI / 2) * side, y: by + Math.sin(first.tee.heading + Math.PI / 2) * side, heading: first.tee.heading });
    }
    this.barn = { x: bx, y: by, heading: first.tee.heading, bays };
    this.clubhouse = {
      x: bx + Math.cos(back) * 16,
      y: by + Math.sin(back) * 16,
      w: 22,
      d: 10,
      heading: first.tee.heading,
    };

    this.shapeGround(base, roughBits);
    this.paintLies();
    this.plantTrees(rnd);
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  private layHoles(rnd: () => number, base: (x: number, y: number) => number): void {
    const total = LENGTHS.reduce((a, b) => a + b, 0) + GAP * LENGTHS.length;
    // a loop a bit bigger than a circle of that length, since holes cut across it
    const radius = (total / (Math.PI * 2)) * 1.02;
    const phase = rnd() * Math.PI * 2;
    const wobble = rnd() * Math.PI * 2;
    const loop = (s: number, push = 0) => {
      const a = phase + (s / total) * Math.PI * 2;
      const r = radius + 22 * Math.sin(3 * a + wobble) + push;
      return { x: HALF + Math.cos(a) * r, y: HALF + Math.sin(a) * r, a };
    };

    let s = 0;
    PARS.forEach((par, index) => {
      const L = LENGTHS[index];
      const tee = loop(s);
      const end = loop(s + L);
      // doglegs alternate in and out; par 3s are straight
      const bend = par === 3 ? 0 : (index % 2 ? 1 : -1) * (18 + rnd() * 16);
      const mid = loop(s + L / 2, bend);
      const line: { x: number; y: number }[] = [];
      const steps = Math.ceil(L / 6);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        line.push({ x: u * u * tee.x + 2 * u * t * (mid.x * 2 - (tee.x + end.x) / 2) + t * t * end.x, y: u * u * tee.y + 2 * u * t * (mid.y * 2 - (tee.y + end.y) / 2) + t * t * end.y });
      }
      let length = 0;
      for (let i = 0; i < line.length - 1; i++) length += Math.hypot(line[i + 1].x - line[i].x, line[i + 1].y - line[i].y);
      const heading = Math.atan2(line[1].y - line[0].y, line[1].x - line[0].x);
      const greenR = par === 3 ? 13 : 15;
      const into = Math.atan2(end.y - line[line.length - 2].y, end.x - line[line.length - 2].x);
      const pinAngle = rnd() * Math.PI * 2;
      const pinR = greenR * (0.2 + rnd() * 0.35);
      const pin = { x: end.x + Math.cos(pinAngle) * pinR, y: end.y + Math.sin(pinAngle) * pinR, z: 0 };
      const width = par === 3 ? 9 : 12 + rnd() * 3;
      const hole: Hole = { index, par, tee: { x: tee.x, y: tee.y, z: 0, heading }, pin, green: { x: end.x, y: end.y, r: greenR }, line, length, width, bunkers: [], ponds: [] };

      // greenside bunkers
      const sides = [into + Math.PI / 2 + (rnd() - 0.5) * 0.8, into - Math.PI / 2 + (rnd() - 0.5) * 0.8];
      for (const a of sides.slice(0, 1 + Math.floor(rnd() * 2))) {
        hole.bunkers.push({ x: end.x + Math.cos(a) * (greenR + 5), y: end.y + Math.sin(a) * (greenR + 5), r: 4 + rnd() * 2 });
      }
      // fairway bunkers where drives land
      if (par > 3) {
        const at = this.along(line, Math.min(length - 60, 150 + rnd() * 25));
        const side = rnd() < 0.5 ? 1 : -1;
        hole.bunkers.push({ x: at.x + Math.cos(at.heading + side * Math.PI / 2) * (width + 2), y: at.y + Math.sin(at.heading + side * Math.PI / 2) * (width + 2), r: 5 + rnd() * 2 });
      }
      // water: carried from the tee on the par 3s, beside the fairway on one par 4
      if (par === 3) {
        const at = this.along(line, length * 0.5);
        hole.ponds.push({ x: at.x, y: at.y, r: 15 + rnd() * 4, z: 0 });
      } else if (index === 3) {
        const at = this.along(line, length * 0.62);
        const side = rnd() < 0.5 ? 1 : -1;
        hole.ponds.push({ x: at.x + Math.cos(at.heading + side * Math.PI / 2) * (width + 14), y: at.y + Math.sin(at.heading + side * Math.PI / 2) * (width + 14), r: 16, z: 0 });
      }
      for (const p of hole.ponds) {
        // the water sits a little below the lowest ground round its edge, so its shore is always dry land
        let low = Infinity;
        for (let k = 0; k < 12; k++) low = Math.min(low, base(p.x + Math.cos(k) * p.r * 1.3, p.y + Math.sin(k) * p.r * 1.3));
        p.z = low - 0.35;
        this.ponds.push(p);
      }
      this.holes.push(hole);
      s += L + GAP;
    });
  }

  /** A point `u` meters along a line, and the heading there. */
  private along(line: { x: number; y: number }[], u: number): { x: number; y: number; heading: number } {
    let left = u;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (left <= len || i === line.length - 2) {
        const t = Math.min(1, left / len);
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: Math.atan2(b.y - a.y, b.x - a.x) };
      }
      left -= len;
    }
    return { x: line[0].x, y: line[0].y, heading: 0 };
  }

  private shapeGround(base: (x: number, y: number) => number, roughBits: (x: number, y: number) => number): void {
    const { holes } = this;
    // tees and greens are levelled; greens get a gentle tilt to read
    const greenTilt = holes.map((h, i) => {
      const a = (h.index * 2.4 + i) % (Math.PI * 2);
      return { gx: Math.cos(a) * 0.018, gy: Math.sin(a) * 0.018, z: base(h.green.x, h.green.y) };
    });
    const teeZ = holes.map((h) => base(h.tee.x, h.tee.y) + 0.35);
    const barnZ = base(this.barn.x, this.barn.y);
    // everything a hole shapes is within this of its line
    const boxes = holes.map((h) => {
      const pad = Math.max(h.width + 32, h.green.r + 14, ...h.ponds.map((p) => p.r * 1.8 + 2), ...h.bunkers.map((b) => b.r + 2));
      const xs = [...h.line.map((p) => p.x), ...h.ponds.map((p) => p.x), ...h.bunkers.map((b) => b.x)];
      const ys = [...h.line.map((p) => p.y), ...h.ponds.map((p) => p.y), ...h.bunkers.map((b) => b.y)];
      return { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad };
    });

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i * GRID;
        const y = j * GRID;
        let h = base(x, y);
        holes.forEach((hole, k) => {
          const box = boxes[k];
          if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) return;
          const fair = toLine(hole.line, x, y);
          if (fair.d < hole.width + 30) h -= roughBits(x, y) * 0.7 * (1 - smoothstep(hole.width, hole.width + 30, fair.d));
          const dt = Math.hypot(x - hole.tee.x, y - hole.tee.y);
          h += (teeZ[k] - h) * (1 - smoothstep(7, 15, dt));
          const g = greenTilt[k];
          const dg = Math.hypot(x - hole.green.x, y - hole.green.y);
          const plane = g.z + (x - hole.green.x) * g.gx + (y - hole.green.y) * g.gy;
          h += (plane - h) * (1 - smoothstep(hole.green.r + 1, hole.green.r + 12, dg));
          for (const b of hole.bunkers) {
            const d = Math.hypot(x - b.x, y - b.y);
            if (d < b.r + 1) h -= 0.75 * (1 - smoothstep(b.r * 0.4, b.r + 1, d));
          }
          for (const p of hole.ponds) {
            const d = Math.hypot(x - p.x, y - p.y);
            if (d < p.r * 1.8) h = Math.min(h, p.z + 1.6 * ((d / p.r) ** 2 - 1));
          }
        });
        const db = Math.hypot(x - this.barn.x, y - this.barn.y);
        h += (barnZ - h) * (1 - smoothstep(26, 40, db));
        // the course rises into hills at its edges
        const edge = Math.max(Math.abs(x - HALF), Math.abs(y - HALF));
        h += 14 * smoothstep(HALF - 60, HALF, edge);
        this.heights[j * N + i] = h;
      }
    }
    for (const hole of holes) {
      hole.tee.z = this.heightAt(hole.tee.x, hole.tee.y);
      hole.pin.z = this.heightAt(hole.pin.x, hole.pin.y);
    }
  }

  private paintLies(): void {
    const { lies, holes } = this;
    lies.fill(Lie.Rough);
    const set = (x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => Lie | null) => {
      const i0 = Math.max(0, Math.floor(x0 / LIE_GRID));
      const i1 = Math.min(LIE_N - 1, Math.ceil(x1 / LIE_GRID));
      const j0 = Math.max(0, Math.floor(y0 / LIE_GRID));
      const j1 = Math.min(LIE_N - 1, Math.ceil(y1 / LIE_GRID));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const lie = fn((i + 0.5) * LIE_GRID, (j + 0.5) * LIE_GRID);
          if (lie !== null) lies[j * LIE_N + i] = lie;
        }
      }
    };
    for (const hole of holes) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of hole.line) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      const pad = hole.width + 20;
      set(x0 - pad, y0 - pad, x1 + pad, y1 + pad, (x, y) => {
        const f = toLine(hole.line, x, y);
        // fairways start a short way off the tee and wander a little in width
        const w = hole.width * (0.85 + 0.15 * Math.sin(f.u / 23 + hole.index));
        if (f.d < w && f.u > 35 && f.u < hole.length) return Lie.Fairway;
        return null;
      });
      const { green, tee } = hole;
      set(green.x - green.r - 2, green.y - green.r - 2, green.x + green.r + 2, green.y + green.r + 2, (x, y) => {
        const a = Math.atan2(y - green.y, x - green.x);
        const r = green.r * (1 + 0.12 * Math.sin(a * 3 + hole.index));
        const d = Math.hypot(x - green.x, y - green.y);
        return d < r ? Lie.Green : d < r + 1.5 ? Lie.Fairway : null;
      });
      const c = Math.cos(tee.heading);
      const s = Math.sin(tee.heading);
      set(tee.x - 9, tee.y - 9, tee.x + 9, tee.y + 9, (x, y) => {
        const along = (x - tee.x) * c + (y - tee.y) * s;
        const across = -(x - tee.x) * s + (y - tee.y) * c;
        return Math.abs(along) < 6 && Math.abs(across) < 4.5 ? Lie.Tee : null;
      });
      for (const b of hole.bunkers) set(b.x - b.r, b.y - b.r, b.x + b.r, b.y + b.r, (x, y) => (Math.hypot(x - b.x, y - b.y) < b.r * (1 + 0.15 * Math.sin(Math.atan2(y - b.y, x - b.x) * 2 + b.r)) ? Lie.Sand : null));
      for (const p of hole.ponds) set(p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r, (x, y) => (Math.hypot(x - p.x, y - p.y) < p.r ? Lie.Water : null));
    }
    // a paved apron in front of the barn
    const { barn } = this;
    set(barn.x - 22, barn.y - 22, barn.x + 22, barn.y + 22, (x, y) => (Math.hypot(x - barn.x, y - barn.y) < 16 ? Lie.Path : null));
  }

  private plantTrees(rnd: () => number): void {
    const thick = valueNoise(this.seed ^ 0x7ee5);
    const clear = (x: number, y: number) => {
      for (const hole of this.holes) {
        const f = toLine(hole.line, x, y);
        if (f.d < hole.width + 9) return false;
        if (Math.hypot(x - hole.tee.x, y - hole.tee.y) < 18) return false;
        if (Math.hypot(x - hole.green.x, y - hole.green.y) < hole.green.r + 12) return false;
        for (const p of hole.ponds) if (Math.hypot(x - p.x, y - p.y) < p.r + 3) return false;
        for (const b of hole.bunkers) if (Math.hypot(x - b.x, y - b.y) < b.r + 3) return false;
      }
      // the walk from each green to the next tee stays open
      for (let i = 0; i < this.holes.length; i++) {
        const g = this.holes[i].green;
        const t = this.holes[(i + 1) % this.holes.length].tee;
        if (toLine([g, t], x, y).d < 10) return false;
      }
      return Math.hypot(x - this.barn.x, y - this.barn.y) > 42;
    };
    for (let k = 0; k < 9000 && this.trees.length < 900; k++) {
      const x = HALF + (rnd() * 2 - 1) * (HALF - 8);
      const y = HALF + (rnd() * 2 - 1) * (HALF - 8);
      const woods = thick(x / 45, y / 45);
      // near the course, trees line the holes; further out they grow in woods
      const nearest = Math.min(...this.holes.map((h) => toLine(h.line, x, y).d - h.width));
      const want = nearest < 32 ? 0.35 : woods > 0.15 ? 0.6 : 0.04;
      if (rnd() > want || !clear(x, y)) continue;
      const height = 7 + rnd() * 7;
      const tree: Tree = { x, y, z: this.heightAt(x, y), trunk: 0.25 + rnd() * 0.2, height, canopy: 2.2 + rnd() * 1.8, kind: rnd() < 0.45 ? 1 : 0 };
      if (this.treesNear(x, y, tree.canopy + 1).length) continue;
      this.trees.push(tree);
      const key = this.treeKey(x, y);
      let cell = this.treeCells.get(key);
      if (!cell) this.treeCells.set(key, (cell = []));
      cell.push(tree);
    }
  }

  private treeKey(x: number, y: number): number {
    return Math.floor(x / 16) * 1000 + Math.floor(y / 16);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Ground height at a point, on the same triangles the scene draws. */
  heightAt(x: number, y: number): number {
    const gx = Math.min(N - 1.0001, Math.max(0, x / GRID));
    const gy = Math.min(N - 1.0001, Math.max(0, y / GRID));
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const h = this.heights;
    const a = h[j * N + i];
    const b = h[j * N + i + 1];
    const c = h[(j + 1) * N + i];
    const d = h[(j + 1) * N + i + 1];
    // triangles (a, c, b) and (b, c, d): split along the b–c diagonal
    return fx + fy <= 1 ? a + (b - a) * fx + (c - a) * fy : d + (c - d) * (1 - fx) + (b - d) * (1 - fy);
  }

  /** The ground's upward unit normal at a point. */
  normalAt(x: number, y: number, out: Vec3 = { x: 0, y: 0, z: 1 }): Vec3 {
    const gx = Math.min(N - 1.0001, Math.max(0, x / GRID));
    const gy = Math.min(N - 1.0001, Math.max(0, y / GRID));
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const h = this.heights;
    const a = h[j * N + i];
    const b = h[j * N + i + 1];
    const c = h[(j + 1) * N + i];
    const d = h[(j + 1) * N + i + 1];
    let sx: number;
    let sy: number;
    if (gx - i + gy - j <= 1) {
      sx = (b - a) / GRID;
      sy = (c - a) / GRID;
    } else {
      sx = (d - c) / GRID;
      sy = (d - b) / GRID;
    }
    const len = Math.hypot(sx, sy, 1);
    out.x = -sx / len;
    out.y = -sy / len;
    out.z = 1 / len;
    return out;
  }

  lieAt(x: number, y: number): Lie {
    if (this.outOfBounds(x, y)) return Lie.Out;
    const i = Math.floor(x / LIE_GRID);
    const j = Math.floor(y / LIE_GRID);
    return this.lies[j * LIE_N + i] as Lie;
  }

  /** The pond a point's in, if any. */
  pondAt(x: number, y: number): Pond | null {
    for (const p of this.ponds) if (Math.hypot(x - p.x, y - p.y) < p.r) return p;
    return null;
  }

  treesNear(x: number, y: number, r: number): Tree[] {
    const out: Tree[] = [];
    const i0 = Math.floor((x - r) / 16);
    const i1 = Math.floor((x + r) / 16);
    const j0 = Math.floor((y - r) / 16);
    const j1 = Math.floor((y + r) / 16);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const t of this.treeCells.get(i * 1000 + j) ?? []) {
          if (Math.hypot(t.x - x, t.y - y) < r + t.canopy) out.push(t);
        }
      }
    }
    return out;
  }

  /** Where a golfer's ball is teed up on a hole: along the front of the tee box, spread out by `slot`. */
  teeSpot(hole: number, slot: number): { x: number; y: number; z: number; heading: number } {
    const t = this.holes[hole].tee;
    const across = (((slot % 7) + 7) % 7) - 3;
    const x = t.x + Math.cos(t.heading) * 2 - Math.sin(t.heading) * across * 1.1;
    const y = t.y + Math.sin(t.heading) * 2 + Math.cos(t.heading) * across * 1.1;
    return { x, y, z: this.heightAt(x, y), heading: t.heading };
  }

  /** Where a golfer arriving for a hole stands: behind its tee. */
  arrival(hole: number, rnd = Math.random): { x: number; y: number; heading: number } {
    const t = this.holes[hole].tee;
    const back = 8 + rnd() * 4;
    const across = (rnd() - 0.5) * 8;
    return { x: t.x - Math.cos(t.heading) * back - Math.sin(t.heading) * across, y: t.y - Math.sin(t.heading) * back + Math.cos(t.heading) * across, heading: t.heading };
  }

  /** How far along a hole's line a point is, and how far off it. */
  locate(hole: number, x: number, y: number): { u: number; d: number } {
    return toLine(this.holes[hole].line, x, y);
  }

  outOfBounds(x: number, y: number): boolean {
    return Math.abs(x - HALF) >= HALF - 2 || Math.abs(y - HALF) >= HALF - 2;
  }

  /** Solid things on the ground for a walking golfer: the clubhouse. Pushes (x, y) out. */
  pushOut(p: { x: number; y: number }, radius: number): void {
    const c = this.clubhouse;
    const cos = Math.cos(c.heading);
    const sin = Math.sin(c.heading);
    const lx = (p.x - c.x) * cos + (p.y - c.y) * sin;
    const ly = -(p.x - c.x) * sin + (p.y - c.y) * cos;
    const hw = c.d / 2 + radius;
    const hd = c.w / 2 + radius;
    if (Math.abs(lx) < hw && Math.abs(ly) < hd) {
      const px = hw - Math.abs(lx);
      const py = hd - Math.abs(ly);
      let nx = lx;
      let ny = ly;
      if (px < py) nx = Math.sign(lx || 1) * hw;
      else ny = Math.sign(ly || 1) * hd;
      p.x = c.x + nx * cos - ny * sin;
      p.y = c.y + nx * sin + ny * cos;
    }
    for (const t of this.treesNear(p.x, p.y, 1)) {
      const dx = p.x - t.x;
      const dy = p.y - t.y;
      const d = Math.hypot(dx, dy);
      const min = t.trunk + radius;
      if (d < min && d > 1e-6) {
        p.x = t.x + (dx / d) * min;
        p.y = t.y + (dy / d) * min;
      }
    }
  }
}
