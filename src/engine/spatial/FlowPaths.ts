/** A point on the ground. */
export interface Spot {
  x: number;
  y: number;
}

/** A square grid of cells, each either walkable or not, that bodies find their way across. */
export interface WalkGrid {
  /** Cells per side: cell (i, j) covers x in [i, i+1) and y in [j, j+1), for 0 <= i, j < size. */
  readonly size: number;
  /** Whether a cell can be walked on. Called with cells off the grid too: say no. */
  open(i: number, j: number): boolean;
  /** The nearest spot a body can stand on, searching out from a point. */
  nearestOpen(x: number, y: number): Spot;
}

export interface FlowPathsOptions {
  /**
   * How long a field is trusted before it's remade, ms. Leave it off for a grid that never changes: fields are then
   * kept for good, and which cells are open is worked out once up front.
   */
  maxAgeMs?: number;
  /** Most fields kept at once (least recently used goes first). */
  maxFields?: number;
  /** Targets within this distance are walked straight to when the way's clear, without a field, m. */
  straightWithin?: number;
}

const DIRS8: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Distance fields over a grid: how many steps every cell is from a target, walking. A body heads downhill on the field
 * for where it's going, cutting corners wherever it can walk straight. Fields are shared by everyone going the same
 * way, and remade when they're a moment old on grids that change (a gate opens, the fat gives way).
 */
export class FlowPaths {
  private readonly fields = new Map<number, { field: Uint16Array; at: number }>();
  private readonly queue: Int32Array;
  /** Which cells can be walked on, when the grid never changes, so filling a field is plain array work. */
  private readonly walkable: Uint8Array | null;
  private readonly size: number;
  private readonly maxAgeMs: number;
  private readonly maxFields: number;
  private readonly straightWithin: number;

  constructor(
    private readonly grid: WalkGrid,
    { maxAgeMs = Infinity, maxFields = maxAgeMs === Infinity ? 64 : 32, straightWithin = 12 }: FlowPathsOptions = {},
  ) {
    const { size } = grid;
    this.size = size;
    this.queue = new Int32Array(size * size);
    this.maxAgeMs = maxAgeMs;
    this.maxFields = maxFields;
    this.straightWithin = straightWithin;
    if (maxAgeMs === Infinity) {
      this.walkable = new Uint8Array(size * size);
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) this.walkable[j * size + i] = grid.open(i, j) ? 1 : 0;
    } else {
      this.walkable = null;
    }
  }

  private open(i: number, j: number): boolean {
    const { size } = this;
    if (i < 0 || j < 0 || i >= size || j >= size) return false;
    return this.walkable ? this.walkable[j * size + i] === 1 : this.grid.open(i, j);
  }

  /** The field to a point: 0 at its cell, 0xffff where it can't be walked to. */
  field(x: number, y: number, now = 0): Uint16Array {
    const { size } = this;
    const target = this.grid.nearestOpen(x, y);
    const key = Math.floor(target.y) * size + Math.floor(target.x);
    const cached = this.fields.get(key);
    if (cached && now - cached.at < this.maxAgeMs) {
      // most recently used goes to the back
      this.fields.delete(key);
      this.fields.set(key, cached);
      return cached.field;
    }
    const field = cached?.field ?? new Uint16Array(size * size);
    this.fill(field, key);
    this.fields.delete(key);
    this.fields.set(key, { field, at: now });
    if (this.fields.size > this.maxFields) this.fields.delete(this.fields.keys().next().value!);
    return field;
  }

  /** Whether a body of radius `r` could walk straight from a to b. */
  clearWalk(ax: number, ay: number, bx: number, by: number, r: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return this.open(Math.floor(ax), Math.floor(ay));
    const ox = (-dy / len) * r;
    const oy = (dx / len) * r;
    return this.traverse(ax, ay, bx, by) && this.traverse(ax + ox, ay + oy, bx + ox, by + oy) && this.traverse(ax - ox, ay - oy, bx - ox, by - oy);
  }

  /**
   * Where a body of radius `r` at (x, y) should head for next on its way to (tx, ty): the target itself if it can walk
   * straight there, or the furthest cell down the field it can walk straight to. Null if the target can't be reached.
   */
  next(x: number, y: number, tx: number, ty: number, r: number, now = 0): Spot | null {
    const { size } = this;
    if (Math.hypot(tx - x, ty - y) < this.straightWithin && this.clearWalk(x, y, tx, ty, r)) return { x: tx, y: ty };
    const field = this.field(tx, ty, now);
    let i = Math.floor(x);
    let j = Math.floor(y);
    if (this.at(field, i, j) === 0xffff) {
      // off the field (pushed into a corner, or standing in a doorway's edge): make for the nearest open cell
      const open = this.grid.nearestOpen(x, y);
      i = Math.floor(open.x);
      j = Math.floor(open.y);
      if (this.at(field, i, j) === 0xffff) return null;
    }
    let best: Spot | null = null;
    for (let step = 0; step < 10; step++) {
      const here = field[j * size + i];
      if (here === 0) break;
      let ni = -1;
      let nj = -1;
      let low = here;
      for (const [di, dj] of DIRS8) {
        const ci = i + di;
        const cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= size || cj >= size) continue;
        // no cutting a corner round a solid cell
        if (di !== 0 && dj !== 0 && (!this.open(i + di, j) || !this.open(i, j + dj))) continue;
        const v = field[cj * size + ci];
        if (v < low) {
          low = v;
          ni = ci;
          nj = cj;
        }
      }
      if (ni < 0) break;
      i = ni;
      j = nj;
      const cx = i + 0.5;
      const cy = j + 0.5;
      if (step === 0 || this.clearWalk(x, y, cx, cy, r)) best = { x: cx, y: cy };
      else break;
    }
    return best ?? { x: tx, y: ty };
  }

  private at(field: Uint16Array, i: number, j: number): number {
    const { size } = this;
    return i < 0 || j < 0 || i >= size || j >= size ? 0xffff : field[j * size + i];
  }

  /** Whether every cell a segment passes through is open. */
  private traverse(ax: number, ay: number, bx: number, by: number): boolean {
    let i = Math.floor(ax);
    let j = Math.floor(ay);
    const bi = Math.floor(bx);
    const bj = Math.floor(by);
    const dx = bx - ax;
    const dy = by - ay;
    const si = dx > 0 ? 1 : -1;
    const sj = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tx = dx !== 0 ? (dx > 0 ? i + 1 - ax : ax - i) * tdx : Infinity;
    let ty = dy !== 0 ? (dy > 0 ? j + 1 - ay : ay - j) * tdy : Infinity;
    for (let n = 0; n < this.size * 3; n++) {
      if (!this.open(i, j)) return false;
      if (i === bi && j === bj) return true;
      if (tx < ty) {
        if (tx > 1) return true;
        tx += tdx;
        i += si;
      } else {
        if (ty > 1) return true;
        ty += tdy;
        j += sj;
      }
    }
    return true;
  }

  /** Breadth-first from the target over the four neighbours, so the field counts orthogonal steps. */
  private fill(field: Uint16Array, from: number): void {
    const { queue, size } = this;
    field.fill(0xffff);
    let head = 0;
    let tail = 0;
    field[from] = 0;
    queue[tail++] = from;
    while (head < tail) {
      const c = queue[head++];
      const i = c % size;
      const j = (c - i) / size;
      const d = field[c] + 1;
      for (let k = 0; k < 4; k++) {
        const ni = i + DIRS8[k][0];
        const nj = j + DIRS8[k][1];
        if (!this.open(ni, nj)) continue;
        const n = nj * size + ni;
        if (field[n] <= d) continue;
        field[n] = d;
        queue[tail++] = n;
      }
    }
  }
}
