import { mulberry32 } from '@engine/index';

/** The island is SIZE meters square, with heights sampled every GRID meters. */
export const SIZE = 512;
export const GRID = 2;
const N = SIZE / GRID + 1;
/** Water covers anything below this; anything lower still is too deep to wade. */
export const SEA = 0;
const DEEP = -0.6;
/** Obstacle lookup buckets, meters. */
const BUCKET = 8;
/** Nothing grows within this of the middle, so everyone arrives in an open meadow. */
export const MEADOW = 34;

export const enum Ground {
  Water = 0,
  Sand = 1,
  Grass = 2,
  Forest = 3,
  Rock = 4,
}

export const enum ObstacleKind {
  Pine = 0,
  Oak = 1,
  Rock = 2,
}

/** A tree or boulder: an upright cylinder standing on the ground. A tree's index is what `Stump.tree` replicates. */
export interface Obstacle {
  x: number;
  y: number;
  /** Trunk or boulder radius. */
  r: number;
  /** Height above the ground at its foot. */
  h: number;
  /** Ground height at its foot. */
  base: number;
  kind: ObstacleKind;
}

export interface RayHit {
  /** Distance to the hit, or the ray's full length if nothing was hit. */
  t: number;
  /** The obstacle hit, or -1 for the ground or nothing. */
  obstacle: number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

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

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x, y) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / norm;
}

/**
 * Peer Wilds' island: hills, lakes, beaches, forests and boulders around a meadow in the middle. It's
 * generated from a seed, so every peer builds the same land and none of it crosses the network. The only
 * thing that changes is which trees have been felled, and that comes from replicated `Stump`s (`felled`).
 */
export class Land {
  readonly heights = new Float32Array(N * N);
  readonly moisture = new Float32Array(N * N);
  readonly obstacles: Obstacle[] = [];
  /** Trees that are down right now, by obstacle index. Kept in step with `Stump` entities. */
  readonly felled = new Set<number>();
  private readonly buckets: number[][];
  private readonly bucketsPerSide = Math.ceil(SIZE / BUCKET);

  constructor(readonly seed: number) {
    const hills = valueNoise(seed);
    const detail = valueNoise(seed ^ 0x51f7);
    const wet = valueNoise(seed ^ 0x9e37);
    const c = SIZE / 2;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i * GRID;
        const y = j * GRID;
        const fromMiddle = Math.hypot(x - c, y - c);
        const d = detail(x / 28, y / 28) * 0.6 + detail(x / 9, y / 9) * 0.15;
        let h = 3 + fbm(hills, x / 140, y / 140, 5) * 24 + d * 2;
        const coast = smoothstep(0.62, 0.97, fromMiddle / c);
        h = h * (1 - coast) - 7 * coast;
        const meadow = smoothstep(MEADOW * 1.9, MEADOW * 0.7, fromMiddle);
        h = h * (1 - meadow) + (3 + d * 0.8) * meadow;
        this.heights[j * N + i] = h;
        this.moisture[j * N + i] = fbm(wet, x / 90, y / 90, 4);
      }
    }
    this.buckets = Array.from({ length: this.bucketsPerSide * this.bucketsPerSide }, () => []);
    this.plant(mulberry32(seed ^ 0x7ee5));
  }

  private plant(rnd: () => number): void {
    const c = SIZE / 2;
    const add = (o: Obstacle) => {
      for (const p of this.obstacles) if (Math.hypot(p.x - o.x, p.y - o.y) < p.r + o.r + 0.8) return;
      const i = this.obstacles.push(o) - 1;
      this.buckets[this.bucketIndex(o.x, o.y)].push(i);
    };
    const TREE_CELL = 4.5;
    for (let cy = TREE_CELL; cy < SIZE - TREE_CELL; cy += TREE_CELL) {
      for (let cx = TREE_CELL; cx < SIZE - TREE_CELL; cx += TREE_CELL) {
        const x = cx + rnd() * TREE_CELL;
        const y = cy + rnd() * TREE_CELL;
        const roll = rnd();
        const kindRoll = rnd();
        const size = rnd();
        if (Math.hypot(x - c, y - c) < MEADOW) continue;
        const g = this.groundAt(x, y);
        const chance = g === Ground.Forest ? 0.62 : g === Ground.Grass ? 0.05 : g === Ground.Rock ? 0.07 : 0;
        if (roll >= chance) continue;
        const h = this.heightAt(x, y);
        const pine = g === Ground.Rock || h > 9 || (g === Ground.Forest && kindRoll < 0.4);
        add({ x, y, r: 0.28 + size * 0.17, h: pine ? 7 + size * 4 : 5 + size * 2.5, base: h, kind: pine ? ObstacleKind.Pine : ObstacleKind.Oak });
      }
    }
    const ROCK_CELL = 11;
    for (let cy = 0; cy < SIZE; cy += ROCK_CELL) {
      for (let cx = 0; cx < SIZE; cx += ROCK_CELL) {
        const x = cx + rnd() * ROCK_CELL;
        const y = cy + rnd() * ROCK_CELL;
        const roll = rnd();
        const size = rnd();
        if (Math.hypot(x - c, y - c) < MEADOW) continue;
        const g = this.groundAt(x, y);
        const chance = g === Ground.Rock ? 0.3 : g === Ground.Grass || g === Ground.Sand ? 0.03 : 0;
        if (roll >= chance) continue;
        const r = 0.6 + size * 0.9;
        add({ x, y, r, h: r * 1.1, base: this.heightAt(x, y) - 0.2, kind: ObstacleKind.Rock });
      }
    }
  }

  private bucketIndex(x: number, y: number): number {
    const n = this.bucketsPerSide;
    const bx = Math.min(n - 1, Math.max(0, Math.floor(x / BUCKET)));
    const by = Math.min(n - 1, Math.max(0, Math.floor(y / BUCKET)));
    return by * n + bx;
  }

  private sample(field: Float32Array, x: number, y: number): number {
    const gx = Math.min(N - 1.001, Math.max(0, x / GRID));
    const gy = Math.min(N - 1.001, Math.max(0, y / GRID));
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const a = field[j * N + i] + (field[j * N + i + 1] - field[j * N + i]) * fx;
    const b = field[(j + 1) * N + i] + (field[(j + 1) * N + i + 1] - field[(j + 1) * N + i]) * fx;
    return a + (b - a) * fy;
  }

  /** Ground height at a point, meters above sea level. Outside the island it's seabed. */
  heightAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x > SIZE || y > SIZE) return -8;
    return this.sample(this.heights, x, y);
  }

  /** What the ground is like at a point. */
  groundAt(x: number, y: number): Ground {
    const h = this.heightAt(x, y);
    if (h < SEA - 0.3) return Ground.Water;
    if (h < 1) return Ground.Sand;
    if (h > 13) return Ground.Rock;
    return this.sample(this.moisture, x, y) > 0.06 ? Ground.Forest : Ground.Grass;
  }

  /** Whether an obstacle is standing: every boulder, and trees that haven't been felled. */
  standing(i: number): boolean {
    return !this.felled.has(i);
  }

  /** Indices of obstacles whose buckets touch a circle (standing or not). */
  obstaclesNear(x: number, y: number, r: number, out: number[] = []): number[] {
    const n = this.bucketsPerSide;
    const x0 = Math.max(0, Math.floor((x - r) / BUCKET));
    const x1 = Math.min(n - 1, Math.floor((x + r) / BUCKET));
    const y0 = Math.max(0, Math.floor((y - r) / BUCKET));
    const y1 = Math.min(n - 1, Math.floor((y + r) / BUCKET));
    for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) for (const i of this.buckets[by * n + bx]) out.push(i);
    return out;
  }

  /** The standing tree whose trunk is nearest a point, within `reach` of its bark. -1 if none. */
  treeAt(x: number, y: number, reach: number): number {
    let best = -1;
    let bestD = reach;
    for (const i of this.obstaclesNear(x, y, reach + 1)) {
      const o = this.obstacles[i];
      if (o.kind === ObstacleKind.Rock || !this.standing(i)) continue;
      const d = Math.hypot(o.x - x, o.y - y) - o.r;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Circle overlaps deep water, the island's edge or a standing obstacle? */
  blocked(x: number, y: number, r: number): boolean {
    if (x < r || y < r || x > SIZE - r || y > SIZE - r) return true;
    if (this.heightAt(x, y) < DEEP) return true;
    for (const i of this.obstaclesNear(x, y, r + 1.6)) {
      const o = this.obstacles[i];
      if (!this.standing(i)) continue;
      const rr = o.r + r;
      if ((x - o.x) ** 2 + (y - o.y) ** 2 < rr * rr) return true;
    }
    return false;
  }

  /** Axis-separated circle movement, sliding along whatever's in the way. Returns true if blocked. */
  move(p: { x: number; y: number }, dx: number, dy: number, r: number): boolean {
    let blocked = false;
    if (!this.blocked(p.x + dx, p.y, r)) p.x += dx;
    else blocked = true;
    if (!this.blocked(p.x, p.y + dy, r)) p.y += dy;
    else blocked = true;
    return blocked;
  }

  /** The first thing a ray meets within `max` meters: the ground or a standing obstacle. `d` must be normalized. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, out: RayHit = { t: 0, obstacle: -1 }): RayHit {
    out.t = max;
    out.obstacle = -1;
    // the ground: march, then narrow down the crossing
    const STEP = 0.35;
    let prev = 0;
    for (let t = STEP; t <= max + STEP; t += STEP) {
      const tt = Math.min(t, max);
      if (oz + dz * tt <= this.heightAt(ox + dx * tt, oy + dy * tt)) {
        let lo = prev;
        let hi = tt;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          if (oz + dz * mid <= this.heightAt(ox + dx * mid, oy + dy * mid)) hi = mid;
          else lo = mid;
        }
        out.t = hi;
        break;
      }
      prev = tt;
      if (tt === max) break;
    }
    // obstacles: upright cylinders
    const a = dx * dx + dy * dy;
    if (a < 1e-9) return out;
    const mx = ox + (dx * out.t) / 2;
    const my = oy + (dy * out.t) / 2;
    for (const i of this.obstaclesNear(mx, my, (Math.sqrt(a) * out.t) / 2 + 2)) {
      if (!this.standing(i)) continue;
      const o = this.obstacles[i];
      const fx = ox - o.x;
      const fy = oy - o.y;
      const b = fx * dx + fy * dy;
      const c = fx * fx + fy * fy - o.r * o.r;
      const disc = b * b - a * c;
      if (disc < 0) continue;
      let t = (-b - Math.sqrt(disc)) / a;
      if (t < 0) {
        if (c > 0) continue; // behind the ray
        t = 0; // starting inside it
      }
      if (t >= out.t) continue;
      const z = oz + dz * t;
      if (z < o.base || z > o.base + o.h) continue;
      out.t = t;
      out.obstacle = i;
    }
    return out;
  }

  /** A random open spot between `rMin` and `rMax` from a point, on ground `accept` likes. */
  randomOpen(px: number, py: number, rMin: number, rMax: number, accept: (g: Ground) => boolean, rng = Math.random): { x: number; y: number } | null {
    for (let attempt = 0; attempt < 30; attempt++) {
      const a = rng() * Math.PI * 2;
      const d = rMin + rng() * (rMax - rMin);
      const x = px + Math.cos(a) * d;
      const y = py + Math.sin(a) * d;
      if (accept(this.groundAt(x, y)) && !this.blocked(x, y, 0.6)) return { x, y };
    }
    return null;
  }

  /** Where newcomers arrive: somewhere in the meadow. */
  spawnPoint(rng = Math.random): { x: number; y: number } {
    const c = SIZE / 2;
    return this.randomOpen(c, c, 0, MEADOW * 0.7, (g) => g !== Ground.Water, rng) ?? { x: c, y: c };
  }

  /** One pixel per `GRID` of ground colour, for maps. */
  overviewPixels(): Uint8ClampedArray<ArrayBuffer> {
    const px = new Uint8ClampedArray(N * N * 4);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const g = this.groundAt(i * GRID, j * GRID);
        const h = this.heights[j * N + i];
        const shade = 0.8 + Math.min(0.35, Math.max(-0.2, h / 40));
        const c = g === Ground.Water ? [34, 84, 132] : g === Ground.Sand ? [196, 180, 128] : g === Ground.Rock ? [130, 126, 118] : g === Ground.Forest ? [44, 92, 46] : [98, 150, 70];
        const k = (j * N + i) * 4;
        px[k] = c[0] * (g === Ground.Water ? 1 : shade);
        px[k + 1] = c[1] * (g === Ground.Water ? 1 : shade);
        px[k + 2] = c[2] * (g === Ground.Water ? 1 : shade);
        px[k + 3] = 255;
      }
    }
    return px;
  }

  /** Samples per side of the height grid (and of `overviewPixels`). */
  static readonly samples = N;
}
