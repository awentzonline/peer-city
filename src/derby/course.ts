import { mulberry32 } from '@engine/index';
import { clamp } from '../crossplay/math';

/**
 * The hill, the same on every peer from its seed: a flat garage on top where racers are built, and a winding
 * downhill track below it, with banked turns, rollers, jumps and walls, to a finish line and a runout.
 *
 * World axes as everywhere: (x, y) on the ground, z up, meters. The track runs roughly along +x. A point on
 * it is measured by `u`, how far along the centreline it is (the centreline's x, since the track never turns
 * back on itself), and `lat`, how far left (+) or right (-) of the centreline.
 */

/** The garage floor's height. */
export const TOP = 160;
/** The garage: flat ground where the bays are. The track leaves from its +x edge at (0, 0). */
export const GARAGE = { x0: -120, x1: 0, y0: -48, y1: 48 };
export const LENGTH = 960;
export const FINISH = 890;
/** The flat, drivable half-width of the track. Beyond it walls rise. */
export const HALF_WIDTH = 9;
/** How far out either side of the centreline the ground is modelled. */
export const EDGE = 40;
/** Where a racer that's fallen off or flipped goes back to. */
export const CHECKPOINT_SPACING = 70;
/** Lateral offsets of the ground's vertices: close together on the track, further apart up the walls. */
export const LATS = [-40, -32, -25, -19, -15, -12, -10, -9.3, -8.2, -7.1, -6, -4, -2, 0, 2, 4, 6, 7.1, 8.2, 9.3, 10, 12, 15, 19, 25, 32, 40];

/** How long a jump's landing is, m. */
const LANDING = 28;

export const BAYS = 12;
/** A bay's pad is this many meters square. */
export const BAY_SIZE = 9;

export interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

export interface Where {
  /** Distance along the track. */
  u: number;
  /** Left of the centreline. */
  lat: number;
}

export interface Tree {
  x: number;
  y: number;
  z: number;
  height: number;
  radius: number;
}

const GRID = 16;

export class Course {
  /** Centreline and its left-pointing normal, and the track's height and banking, a sample per meter of u. */
  readonly cx: Float64Array;
  readonly cy: Float64Array;
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  readonly h: Float64Array;
  readonly bank: Float64Array;
  /** Where the jumps take off. */
  readonly jumps: number[] = [];
  readonly trees: Tree[] = [];
  private readonly cells = new Map<number, number[]>();

  constructor(readonly seed: number) {
    const n = LENGTH + 1;
    this.cx = new Float64Array(n);
    this.cy = new Float64Array(n);
    this.nx = new Float64Array(n);
    this.ny = new Float64Array(n);
    this.h = new Float64Array(n);
    this.bank = new Float64Array(n);
    const rnd = mulberry32(seed);
    const p1 = rnd() * Math.PI * 2;
    const p2 = rnd() * Math.PI * 2;
    const wiggle = (u: number) => {
      const ramp = smoothstep(20, 110, u);
      return ramp * (58 * (Math.sin(u / 110 + p1) - Math.sin(p1)) + 22 * (Math.sin(u / 46 + p2) - Math.sin(p2)));
    };
    for (let i = 0; i < n; i++) {
      this.cx[i] = i;
      this.cy[i] = wiggle(i);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const tx = this.cx[b] - this.cx[a];
      const ty = this.cy[b] - this.cy[a];
      const len = Math.hypot(tx, ty);
      this.nx[i] = -ty / len;
      this.ny[i] = tx / len;
      // curvature, from how the heading turns: bank the outside of the bend up
      const h0 = Math.atan2(this.cy[i] - this.cy[a], this.cx[i] - this.cx[a] || 1);
      const h1 = Math.atan2(this.cy[b] - this.cy[i], this.cx[b] - this.cx[i] || 1);
      this.bank[i] = clamp((h1 - h0) * 8, -0.22, 0.22);
    }
    smooth(this.bank, 12);

    // Slopes in stretches, steeper and gentler, with rollers here and there.
    const slope = new Float64Array(n);
    let u = 0;
    while (u < n) {
      const len = 50 + Math.floor(rnd() * 70);
      const s = u < 45 ? 0.04 : u > FINISH + 10 ? 0.01 : 0.08 + rnd() * 0.22;
      const rollers = u > 60 && u < FINISH - 60 && rnd() < 0.35;
      for (let i = u; i < Math.min(n, u + len); i++) slope[i] = s + (rollers ? 0.18 * Math.sin((i - u) / 3.2) : 0);
      u += len;
    }
    smooth(slope, 6);
    this.h[0] = TOP;
    for (let i = 1; i < n; i++) this.h[i] = this.h[i - 1] - slope[i];

    // Kickers: a ramp that rises out of the slope, over a lip, and a landing that eases back down onto it. Fast
    // racers fly off the lip and come down on the landing's slope; slow ones just roll over.
    for (let j = 200; j < FINISH - 80; j += 150 + Math.floor(rnd() * 90)) {
      this.jumps.push(j);
      const rise = 0.9 + rnd() * 0.9;
      for (let d = -18; d <= 0; d++) this.h[j + d] += rise * ((d + 18) / 18) ** 2;
      for (let d = 1; d <= LANDING; d++) this.h[j + d] += rise * 0.5 * (1 + Math.cos((Math.PI * d) / LANDING));
    }

    for (let i = 0; i < n; i += 4) {
      const key = cellKey(this.cx[i], this.cy[i]);
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    }

    for (let k = 0; k < 420; k++) {
      const tu = 30 + rnd() * (LENGTH - 30);
      const side = rnd() < 0.5 ? -1 : 1;
      const lat = side * (HALF_WIDTH + 7 + rnd() * (EDGE - HALF_WIDTH - 9));
      const i = Math.floor(tu);
      const x = this.cx[i] + this.nx[i] * lat;
      const y = this.cy[i] + this.ny[i] * lat;
      const height = 5 + rnd() * 7;
      this.trees.push({ x, y, z: this.surface(tu, lat) - 0.3, height, radius: 0.25 + height * 0.03 });
    }
  }

  /** The track's height at u, lat (inside the modelled ground). */
  surface(u: number, lat: number): number {
    const i = clamp(Math.floor(u), 0, LENGTH - 1);
    const f = clamp(u - i, 0, 1);
    const base = this.h[i] + (this.h[i + 1] - this.h[i]) * f;
    const bank = this.bank[i] + (this.bank[i + 1] - this.bank[i]) * f;
    const a = Math.abs(lat);
    const track = -clamp(lat, -HALF_WIDTH, HALF_WIDTH) * bank;
    const wall = a <= HALF_WIDTH ? 0 : 12 * (1 - Math.exp(-(a - HALF_WIDTH) / 5)) + 0.1 * (a - HALF_WIDTH);
    return base + track + wall;
  }

  /** Where a point is along the track: the nearest centreline sample, refined. */
  locate(x: number, y: number, out: Where = { u: 0, lat: 0 }): Where {
    let best = -1;
    let bestD = Infinity;
    const gx = Math.floor(x / GRID);
    const gy = Math.floor(y / GRID);
    for (let r = 1; r <= 4 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const list = this.cells.get(gridKey(gx + dx, gy + dy));
          if (!list) continue;
          for (const i of list) {
            const d = (this.cx[i] - x) ** 2 + (this.cy[i] - y) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
    }
    if (best < 0) best = clamp(Math.round(x), 0, LENGTH);
    // the coarse index holds every 4th sample: walk to the nearest one
    for (let step = 0; step < 8; step++) {
      const here = (this.cx[best] - x) ** 2 + (this.cy[best] - y) ** 2;
      const back = best > 0 ? (this.cx[best - 1] - x) ** 2 + (this.cy[best - 1] - y) ** 2 : Infinity;
      const fwd = best < LENGTH ? (this.cx[best + 1] - x) ** 2 + (this.cy[best + 1] - y) ** 2 : Infinity;
      if (back < here && back <= fwd) best--;
      else if (fwd < here) best++;
      else break;
    }
    const i = best;
    const tx = this.ny[i];
    const ty = -this.nx[i];
    const dx = x - this.cx[i];
    const dy = y - this.cy[i];
    out.u = clamp(i + dx * tx + dy * ty, i === 0 ? -Infinity : 0, LENGTH);
    out.lat = dx * this.nx[i] + dy * this.ny[i];
    return out;
  }

  inGarage(x: number, y: number): boolean {
    return x <= GARAGE.x1 && x >= GARAGE.x0 && y >= GARAGE.y0 && y <= GARAGE.y1;
  }

  /** Ground height anywhere: the garage floor, the modelled ground by the track, or the lip of it beyond. */
  heightAt(x: number, y: number): number {
    if (x <= GARAGE.x1) return TOP;
    const w = this.locate(x, y, where);
    return this.surface(w.u, clamp(w.lat, -EDGE, EDGE));
  }

  /** The direction the track heads at u. */
  headingAt(u: number): number {
    const i = clamp(Math.round(u), 0, LENGTH);
    return Math.atan2(-this.nx[i], this.ny[i]);
  }

  /** A point u along the track, lat to the left, on its surface. */
  pointAt(u: number, lat: number, out: Pose = { x: 0, y: 0, z: 0, heading: 0 }): Pose {
    const i = clamp(Math.floor(u), 0, LENGTH);
    out.x = this.cx[i] + this.nx[i] * lat + (u - i);
    out.y = this.cy[i] + this.ny[i] * lat;
    out.z = this.surface(u, lat);
    out.heading = this.headingAt(u);
    return out;
  }

  /** The last checkpoint at or before u. */
  checkpoint(u: number): number {
    return Math.max(0, Math.floor(u / CHECKPOINT_SPACING) * CHECKPOINT_SPACING);
  }

  /** Off the course: past the walls, or far below or above the ground. */
  outOfBounds(x: number, y: number, z: number): boolean {
    if (this.inGarage(x, y)) return z < TOP - 8;
    if (x < GARAGE.x1) return true;
    const w = this.locate(x, y, where);
    if (Math.abs(w.lat) > EDGE - 3 || w.u >= LENGTH) return true;
    const ground = this.surface(w.u, w.lat);
    return z < ground - 6 || z > ground + 70;
  }

  /** The middle of bay `i`'s pad. Bays face down the hill (+x), in two rows either side of the garage. */
  bay(i: number): Pose {
    const row = i % 2 === 0 ? 1 : -1;
    const col = Math.floor(i / 2);
    return { x: -104 + col * 16, y: row * 30, z: TOP, heading: 0 };
  }

  /** Where the builder of bay `i` stands when they get out: beside it, toward the middle of the garage. */
  bayStand(i: number): Pose {
    const b = this.bay(i);
    return { x: b.x, y: b.y - Math.sign(b.y) * (BAY_SIZE / 2 + 2.5), z: TOP, heading: b.y > 0 ? Math.PI / 2 : -Math.PI / 2 };
  }

  /** The start grid: three abreast, a row every 9 meters back from the line. */
  gridSlot(i: number): Pose {
    const row = Math.floor(i / 3);
    const col = (i % 3) - 1;
    return this.pointAt(Math.max(1, 34 - row * 9), col * 6);
  }

  /**
   * The ground by the track as a triangle mesh in world axes: a row of vertices across the track (at `LATS`)
   * every `step` meters along it.
   */
  ribbon(step = 1): { positions: Float32Array; indices: Uint32Array; lats: Float32Array; columns: number; rows: number } {
    const columns = LATS.length;
    const rows = Math.floor(LENGTH / step) + 1;
    const positions = new Float32Array(rows * columns * 3);
    const lats = new Float32Array(rows * columns);
    for (let r = 0; r < rows; r++) {
      const u = r * step;
      const i = Math.min(LENGTH, Math.round(u));
      for (let c = 0; c < columns; c++) {
        const lat = LATS[c];
        const k = r * columns + c;
        positions[k * 3] = this.cx[i] + this.nx[i] * lat;
        positions[k * 3 + 1] = this.cy[i] + this.ny[i] * lat;
        positions[k * 3 + 2] = this.surface(u, lat);
        lats[k] = lat;
      }
    }
    const indices = new Uint32Array((rows - 1) * (columns - 1) * 6);
    let n = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < columns - 1; c++) {
        const a = r * columns + c;
        const b = a + columns;
        // counter-clockwise seen from above (+z), with the normal left of the direction of travel
        indices.set([a, b, a + 1, a + 1, b, b + 1], n);
        n += 6;
      }
    }
    return { positions, indices, lats, columns, rows };
  }
}

const where: Where = { u: 0, lat: 0 };

function gridKey(gx: number, gy: number): number {
  return (gx + 1000) * 4096 + (gy + 1000);
}

function cellKey(x: number, y: number): number {
  return gridKey(Math.floor(x / GRID), Math.floor(y / GRID));
}

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Box-blur an array in place, `radius` samples each way. */
function smooth(a: Float64Array, radius: number): void {
  const copy = a.slice();
  for (let i = 0; i < a.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(a.length - 1, i + radius); j++) {
      sum += copy[j];
      count++;
    }
    a[i] = sum / count;
  }
}
