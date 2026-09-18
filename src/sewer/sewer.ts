import { mulberry32 } from '@engine/index';

/**
 * The sewer: a grid of one-meter cells every peer builds from the same seed, so nothing about the place itself goes
 * over the network. Cell (i, j) covers x in [i, i+1) and y in [j, j+1).
 *
 * Chambers sit on a coarse grid, joined by straight tunnels four cells wide: a spanning tree, so every chamber can be
 * reached, plus a few extra tunnels for loops. Open cells next to the rock are raised walkways; the rest is the
 * channel the sewage runs down. The chamber furthest from the ladder is the vault, and the only tunnel into it is
 * plugged by the fatberg (fatberg.ts). Relief valves are in chambers spread round the rest, and goblins come out of
 * drains in the walls.
 *
 * On top of the grid: circle collision, the ground's height, line of sight, and distance fields goblins find their
 * way by.
 */

export const enum Cell {
  Rock = 0,
  /** The channel, down in the sewage. */
  Channel = 1,
  /** A raised walkway along the wall. */
  Walk = 2,
}

export interface Spot {
  x: number;
  y: number;
}

/** A thing on a wall: where it is, and the unit normal pointing out of the wall into the open. */
export interface WallSpot extends Spot {
  z: number;
  nx: number;
  ny: number;
}

export interface Chamber {
  /** Its floor, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  /** Its node on the coarse grid. */
  node: number;
}

/**
 * Where the fatberg sits: in a tunnel `WIDTH` cells across. `along` says which world axis the tunnel runs down. Voxel
 * u runs across the tunnel from (`x0`, `y0`), v along it, and w up from the channel floor.
 */
export interface FatSpot {
  along: 'x' | 'y';
  x0: number;
  y0: number;
  /** +1 if v runs toward the vault the way the axis counts, else -1 (v always counts from the ladder's side). */
  dir: 1 | -1;
}

export const SIZE = 72;
/** Tunnels are this many cells across: a walkway each side, and the channel between. */
export const WIDTH = 4;
/** How high a walkway stands over the channel floor. */
export const WALK_HEIGHT = 0.45;
/** Height of the ceiling over tunnels and chambers. */
export const TUNNEL_HEIGHT = 3;
export const CHAMBER_HEIGHT = 4.6;
/** The coarse grid chambers sit on: `NODES` × `NODES` of them, `SPACING` apart, from `MARGIN`. */
const NODES = 4;
const SPACING = 18;
const MARGIN = 9;
const EXTRA_LOOPS = 3;
const DRAINS = 12;

const DIRS8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

export class SewerMap {
  readonly cells = new Uint8Array(SIZE * SIZE);
  /** Ceiling height over each open cell. */
  readonly ceiling = new Float32Array(SIZE * SIZE);
  /** Which chamber an open cell is in, or -1 for a tunnel. */
  readonly chamberOf = new Int16Array(SIZE * SIZE).fill(-1);
  readonly chambers: Chamber[] = [];
  /** Tunnels, as pairs of chamber indices. */
  readonly tunnels: [number, number][] = [];
  readonly start: Chamber;
  readonly vault: Chamber;
  /** The ladder up out of the sewer: a spot on the start chamber's wall, and where to stand at its foot. */
  readonly ladder: WallSpot;
  readonly ladderFoot: Spot;
  /** Where Lordz gather before a dive. */
  readonly gather: Spot[] = [];
  readonly valves: WallSpot[] = [];
  readonly drains: WallSpot[] = [];
  /** Shafts of light down storm grates in the ceiling. */
  readonly grates: Spot[] = [];
  /** Channel cells loot can be buried in, and walkway cells in the vault for its treasure. */
  readonly lootSpots: Spot[] = [];
  readonly vaultSpots: Spot[] = [];
  readonly fat: FatSpot;
  /** Cells the fatberg fills, which nothing walks through while it's whole. */
  readonly fatCells = new Set<number>();
  /** Whether the fatberg still blocks its tunnel, for finding the way (collision itself is by voxel). */
  fatBlocks = true;
  private readonly rnd: () => number;

  constructor(readonly seed: number) {
    this.rnd = mulberry32(seed);
    const edges = this.layout();
    this.classify();
    this.start = this.chambers[0];
    this.vault = this.pickVault(edges);
    this.fat = this.placeFat(edges);
    this.ladder = { x: this.start.x0 + 0.08, y: this.start.y0 + 0.5, z: 0, nx: 1, ny: 0 };
    this.ladderFoot = { x: this.start.x0 + 0.55, y: this.start.y0 + 0.5 };
    for (let j = this.start.y0 + 1; j <= this.start.y0 + 3; j++) for (let i = this.start.x0 + 1; i <= this.start.x0 + 3; i++) this.gather.push({ x: i + 0.5, y: j + 0.5 });
    this.placeValves();
    this.placeDrains();
    this.placeGrates();
    this.findLootSpots();
  }

  static index(i: number, j: number): number {
    return j * SIZE + i;
  }

  cell(i: number, j: number): Cell {
    if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return Cell.Rock;
    return this.cells[j * SIZE + i] as Cell;
  }

  cellAt(x: number, y: number): Cell {
    return this.cell(Math.floor(x), Math.floor(y));
  }

  solid(i: number, j: number): boolean {
    return this.cell(i, j) === Cell.Rock;
  }

  /** Height of the ground at a point: the channel floor, or a walkway. */
  groundAt(x: number, y: number): number {
    return this.cellAt(x, y) === Cell.Walk ? WALK_HEIGHT : 0;
  }

  ceilingAt(x: number, y: number): number {
    const i = Math.floor(x);
    const j = Math.floor(y);
    if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return 0;
    return this.ceiling[j * SIZE + i];
  }

  chamberAt(x: number, y: number): Chamber | null {
    const i = Math.floor(x);
    const j = Math.floor(y);
    if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return null;
    const c = this.chamberOf[j * SIZE + i];
    return c >= 0 ? this.chambers[c] : null;
  }

  // -------------------------------------------------------------------------
  // Movement and sight
  // -------------------------------------------------------------------------

  /** Move a circle of radius `r` by (dx, dy), sliding along the walls. Returns whether anything got in the way. */
  move(p: { x: number; y: number }, dx: number, dy: number, r: number): boolean {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.3));
    let blocked = false;
    for (let s = 0; s < steps; s++) {
      p.x += dx / steps;
      if (this.pushOut(p, r)) blocked = true;
      p.y += dy / steps;
      if (this.pushOut(p, r)) blocked = true;
    }
    return blocked;
  }

  /** Push a circle out of the rock. Returns whether it was in any. */
  pushOut(p: { x: number; y: number }, r: number): boolean {
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      const i0 = Math.floor(p.x - r);
      const i1 = Math.floor(p.x + r);
      const j0 = Math.floor(p.y - r);
      const j1 = Math.floor(p.y + r);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!this.solid(i, j)) continue;
          const qx = Math.min(Math.max(p.x, i), i + 1);
          const qy = Math.min(Math.max(p.y, j), j + 1);
          const ex = p.x - qx;
          const ey = p.y - qy;
          const d = Math.hypot(ex, ey);
          if (d >= r) continue;
          hit = moved = true;
          if (d > 1e-6) {
            p.x += (ex / d) * (r - d);
            p.y += (ey / d) * (r - d);
          } else {
            const left = p.x - i;
            const right = i + 1 - p.x;
            const down = p.y - j;
            const up = j + 1 - p.y;
            const m = Math.min(left, right, down, up);
            if (m === left) p.x = i - r;
            else if (m === right) p.x = i + 1 + r;
            else if (m === down) p.y = j - r;
            else p.y = j + 1 + r;
          }
        }
      }
      if (!moved) break;
    }
    return hit;
  }

  /** Whether no rock lies between two points. */
  sees(ax: number, ay: number, bx: number, by: number): boolean {
    return this.traverse(ax, ay, bx, by, (i, j) => !this.solid(i, j));
  }

  /** Whether a body of radius `r` could walk straight from a to b. */
  clearWalk(ax: number, ay: number, bx: number, by: number, r: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const open = (i: number, j: number) => !this.solid(i, j) && !this.fatBlocked(i, j);
    if (len < 1e-6) return open(Math.floor(ax), Math.floor(ay));
    const ox = (-dy / len) * r;
    const oy = (dx / len) * r;
    return this.traverse(ax, ay, bx, by, open) && this.traverse(ax + ox, ay + oy, bx + ox, by + oy, open) && this.traverse(ax - ox, ay - oy, bx - ox, by - oy, open);
  }

  /** Whether the fatberg is in the way at a cell, as far as finding the way goes. */
  fatBlocked(i: number, j: number): boolean {
    return this.fatBlocks && this.fatCells.has(SewerMap.index(i, j));
  }

  private traverse(ax: number, ay: number, bx: number, by: number, visit: (i: number, j: number) => boolean): boolean {
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
    for (let n = 0; n < SIZE * 3; n++) {
      if (!visit(i, j)) return false;
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

  /** The nearest cell centre a body can stand on, searching out from a point. */
  nearestOpen(x: number, y: number): Spot {
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    for (let r = 0; r < 10; r++) {
      let best: Spot | null = null;
      let bestD = Infinity;
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || this.solid(i, j)) continue;
          const d = Math.hypot(i + 0.5 - x, j + 0.5 - y);
          if (d < bestD) {
            bestD = d;
            best = { x: i + 0.5, y: j + 0.5 };
          }
        }
      }
      if (best) return best;
    }
    return { x, y };
  }

  /** Every cell that can be walked to from the ladder, going through the fatberg or not. */
  reachable(throughFat: boolean): Uint8Array {
    const seen = new Uint8Array(SIZE * SIZE);
    const queue = new Int32Array(SIZE * SIZE);
    let head = 0;
    let tail = 0;
    const from = SewerMap.index(Math.floor(this.ladderFoot.x), Math.floor(this.ladderFoot.y));
    seen[from] = 1;
    queue[tail++] = from;
    while (head < tail) {
      const c = queue[head++];
      const i = c % SIZE;
      const j = (c - i) / SIZE;
      for (let d = 0; d < 4; d++) {
        const ni = i + DIRS8[d][0];
        const nj = j + DIRS8[d][1];
        if (this.solid(ni, nj)) continue;
        const n = nj * SIZE + ni;
        if (seen[n] || (!throughFat && this.fatCells.has(n))) continue;
        seen[n] = 1;
        queue[tail++] = n;
      }
    }
    return seen;
  }

  // -------------------------------------------------------------------------
  // Building it
  // -------------------------------------------------------------------------

  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.rnd() * (hi - lo + 1));
  }

  private open(i: number, j: number, ceiling: number, chamber: number): void {
    if (i < 1 || j < 1 || i >= SIZE - 1 || j >= SIZE - 1) return;
    const k = SewerMap.index(i, j);
    this.cells[k] = Cell.Channel;
    this.ceiling[k] = Math.max(this.ceiling[k], ceiling);
    if (chamber >= 0) this.chamberOf[k] = chamber;
  }

  /** Chambers on the coarse grid, a spanning tree of tunnels between them from the ladder's, and a few loops. */
  private layout(): [number, number][] {
    const count = NODES * NODES;
    const corner = [0, NODES - 1, count - NODES, count - 1][this.int(0, 3)];
    const order = [corner, ...[...Array(count).keys()].filter((n) => n !== corner)];
    const indexOf = new Map<number, number>();
    for (const node of order) {
      const a = node % NODES;
      const b = (node - a) / NODES;
      const cx = MARGIN + a * SPACING;
      const cy = MARGIN + b * SPACING;
      const hw = this.int(3, 4);
      const hh = this.int(3, 4);
      indexOf.set(node, this.chambers.length);
      this.chambers.push({ x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh, cx, cy, node });
    }
    const neighbours = (n: number) => {
      const a = n % NODES;
      const b = (n - a) / NODES;
      const out: number[] = [];
      if (a > 0) out.push(n - 1);
      if (a < NODES - 1) out.push(n + 1);
      if (b > 0) out.push(n - NODES);
      if (b < NODES - 1) out.push(n + NODES);
      return out;
    };
    // a random depth-first spanning tree from the ladder's corner
    const edges: [number, number][] = [];
    const seen = new Set([corner]);
    const stack = [corner];
    while (stack.length) {
      const n = stack[stack.length - 1];
      const next = neighbours(n).filter((m) => !seen.has(m));
      if (!next.length) {
        stack.pop();
        continue;
      }
      const m = next[this.int(0, next.length - 1)];
      seen.add(m);
      edges.push([indexOf.get(n)!, indexOf.get(m)!]);
      stack.push(m);
    }
    for (const c of this.chambers) {
      for (let j = c.y0; j <= c.y1; j++) for (let i = c.x0; i <= c.x1; i++) this.open(i, j, CHAMBER_HEIGHT, this.chambers.indexOf(c));
    }
    for (const [a, b] of edges) this.carve(a, b);
    return edges;
  }

  /** A straight tunnel between two neighbouring chambers. */
  private carve(a: number, b: number): void {
    const ca = this.chambers[a];
    const cb = this.chambers[b];
    this.tunnels.push([a, b]);
    const half = WIDTH / 2;
    if (ca.cy === cb.cy) {
      const [x0, x1] = ca.cx < cb.cx ? [ca.x1 + 1, cb.x0 - 1] : [cb.x1 + 1, ca.x0 - 1];
      for (let i = x0; i <= x1; i++) for (let j = ca.cy - half; j < ca.cy + half; j++) this.open(i, j, TUNNEL_HEIGHT, -1);
    } else {
      const [y0, y1] = ca.cy < cb.cy ? [ca.y1 + 1, cb.y0 - 1] : [cb.y1 + 1, ca.y0 - 1];
      for (let j = y0; j <= y1; j++) for (let i = ca.cx - half; i < ca.cx + half; i++) this.open(i, j, TUNNEL_HEIGHT, -1);
    }
  }

  /** Open cells against the rock are walkways; the rest is channel. */
  private classify(): void {
    const walk: number[] = [];
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        if (this.solid(i, j)) continue;
        if (DIRS8.some(([di, dj]) => this.solid(i + di, j + dj))) walk.push(SewerMap.index(i, j));
      }
    }
    for (const k of walk) this.cells[k] = Cell.Walk;
  }

  /**
   * The vault: the chamber furthest down the tree from the ladder with only one tunnel into it. Then a few more tunnels
   * make loops, none of them into the vault.
   */
  private pickVault(edges: [number, number][]): Chamber {
    const degree = new Map<number, number>();
    for (const [a, b] of edges) {
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    const depth = new Map<number, number>([[0, 0]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [a, b] of edges) {
        if (depth.has(a) && !depth.has(b)) {
          depth.set(b, depth.get(a)! + 1);
          changed = true;
        }
      }
    }
    let vault = 1;
    for (const [c, d] of depth) if (c !== 0 && degree.get(c) === 1 && d > (depth.get(vault) ?? -1)) vault = c;
    // loops: extra tunnels between neighbours not already joined, never into the vault or the ladder's chamber
    const joined = new Set(edges.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
    for (let tries = 0, added = 0; tries < 60 && added < EXTRA_LOOPS; tries++) {
      const a = this.int(1, this.chambers.length - 1);
      const na = this.chambers[a].node;
      const candidates = this.chambers
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => i !== 0 && i !== vault && i !== a && Math.abs((c.node % NODES) - (na % NODES)) + Math.abs(Math.floor(c.node / NODES) - Math.floor(na / NODES)) === 1);
      if (a === vault || !candidates.length) continue;
      const b = candidates[this.int(0, candidates.length - 1)].i;
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      if (joined.has(key)) continue;
      joined.add(key);
      this.carve(a, b);
      added++;
    }
    this.classifyAgain();
    return this.chambers[vault];
  }

  /** Walkways again, once the loops are carved. */
  private classifyAgain(): void {
    for (let k = 0; k < this.cells.length; k++) if (this.cells[k] === Cell.Walk) this.cells[k] = Cell.Channel;
    this.classify();
  }

  /** The fatberg plugs the one tunnel into the vault, halfway along it. */
  private placeFat(edges: [number, number][]): FatSpot {
    const v = this.chambers.indexOf(this.vault);
    const [a, b] = edges.find(([p, q]) => p === v || q === v)!;
    const other = this.chambers[a === v ? b : a];
    const vault = this.vault;
    const half = WIDTH / 2;
    let spot: FatSpot;
    if (other.cy === vault.cy) {
      const toward = vault.cx > other.cx ? 1 : -1;
      const [lo, hi] = toward > 0 ? [other.x1 + 1, vault.x0 - 1] : [vault.x1 + 1, other.x0 - 1];
      const mid = (lo + hi + 1) / 2;
      spot = { along: 'x', x0: mid - (toward * FAT_LENGTH) / 2, y0: vault.cy - half, dir: toward };
      for (let i = lo; i <= hi; i++) for (let j = vault.cy - half; j < vault.cy + half; j++) this.fatCells.add(SewerMap.index(i, j));
    } else {
      const toward = vault.cy > other.cy ? 1 : -1;
      const [lo, hi] = toward > 0 ? [other.y1 + 1, vault.y0 - 1] : [vault.y1 + 1, other.y0 - 1];
      const mid = (lo + hi + 1) / 2;
      spot = { along: 'y', x0: vault.cx - half, y0: mid - (toward * FAT_LENGTH) / 2, dir: toward };
      for (let j = lo; j <= hi; j++) for (let i = vault.cx - half; i < vault.cx + half; i++) this.fatCells.add(SewerMap.index(i, j));
    }
    return spot;
  }

  /** Chambers furthest from each other and from the ladder get the relief valves, each in a corner. */
  private placeValves(): void {
    const candidates = this.chambers.filter((c) => c !== this.start && c !== this.vault);
    const picked: Chamber[] = [];
    while (picked.length < 4 && picked.length < candidates.length) {
      let best: Chamber | null = null;
      let bestD = -1;
      for (const c of candidates) {
        if (picked.includes(c)) continue;
        const d = Math.min(Math.hypot(c.cx - this.start.cx, c.cy - this.start.cy) * 0.6, ...picked.map((p) => Math.hypot(p.cx - c.cx, p.cy - c.cy))) * (0.8 + this.rnd() * 0.4);
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      picked.push(best!);
    }
    for (const c of picked) {
      // on the east or west wall by a corner, over the walkway
      const east = this.rnd() < 0.5;
      const north = this.rnd() < 0.5;
      const y = (north ? c.y1 : c.y0) + 0.5;
      this.valves.push(east ? { x: c.x1 + 1 - 0.14, y, z: 1.7, nx: -1, ny: 0 } : { x: c.x0 + 0.14, y, z: 1.7, nx: 1, ny: 0 });
    }
  }

  /** Drains goblins come out of: holes low in walkway walls, away from the ladder, the vault and the fatberg. */
  private placeDrains(): void {
    const options: WallSpot[] = [];
    for (let j = 1; j < SIZE - 1; j++) {
      for (let i = 1; i < SIZE - 1; i++) {
        if (this.cell(i, j) !== Cell.Walk || this.fatCells.has(SewerMap.index(i, j))) continue;
        const ch = this.chamberAt(i + 0.5, j + 0.5);
        if (ch === this.start || ch === this.vault) continue;
        if (Math.hypot(i - this.start.cx, j - this.start.cy) < 12) continue;
        for (const [di, dj] of DIRS8.slice(0, 4)) {
          // a straight stretch of wall, not a corner
          if (!this.solid(i + di, j + dj) || this.solid(i - di, j - dj)) continue;
          const side = dj === 0 ? [0, 1] : [1, 0];
          if (!this.solid(i + di + side[0], j + dj + side[1]) || !this.solid(i + di - side[0], j + dj - side[1])) continue;
          options.push({ x: i + 0.5 + di * 0.5, y: j + 0.5 + dj * 0.5, z: WALK_HEIGHT, nx: -di, ny: -dj });
        }
      }
    }
    while (this.drains.length < DRAINS && options.length) {
      let best = 0;
      let bestD = -1;
      for (let n = 0; n < options.length; n++) {
        const o = options[n];
        const d = this.drains.length ? Math.min(...this.drains.map((d) => Math.hypot(d.x - o.x, d.y - o.y))) : this.rnd() * 100;
        if (d > bestD) {
          bestD = d;
          best = n;
        }
      }
      this.drains.push(options.splice(best, 1)[0]);
    }
  }

  /** Light comes down through a grate in the ceiling of the ladder's chamber and a few others. */
  private placeGrates(): void {
    this.grates.push({ x: this.start.cx + 0.5, y: this.start.cy + 0.5 });
    const rest = this.chambers.filter((c) => c !== this.start && c !== this.vault);
    for (let n = 0; n < 5 && rest.length; n++) {
      const c = rest.splice(this.int(0, rest.length - 1), 1)[0];
      this.grates.push({ x: c.cx + 0.5, y: c.cy + 0.5 });
    }
  }

  private findLootSpots(): void {
    for (let j = 1; j < SIZE - 1; j++) {
      for (let i = 1; i < SIZE - 1; i++) {
        if (this.cell(i, j) !== Cell.Channel || this.fatCells.has(SewerMap.index(i, j))) continue;
        const ch = this.chamberAt(i + 0.5, j + 0.5);
        if (ch === this.start || ch === this.vault) continue;
        this.lootSpots.push({ x: i + 0.5, y: j + 0.5 });
      }
    }
    const v = this.vault;
    for (const [i, j] of [
      [v.x0 + 1, v.y0],
      [v.x1 - 1, v.y1],
      [v.cx, v.y0],
      [v.cx, v.y1],
      [v.x0, v.cy],
      [v.x1, v.cy],
    ]) {
      if (this.cell(i, j) === Cell.Walk) this.vaultSpots.push({ x: i + 0.5, y: j + 0.5 });
    }
  }
}

/** How far along its tunnel the fatberg reaches, m. Must match the voxel grid (fatberg.ts). */
export const FAT_LENGTH = 2.5;

/**
 * Distance fields over the sewer, one per target cell, for goblins to find their way along. Cached, and remade when
 * they're a moment old since targets move.
 */
export class Paths {
  private readonly fields = new Map<number, { field: Uint16Array; at: number }>();
  private readonly queue = new Int32Array(SIZE * SIZE);

  constructor(
    private readonly map: SewerMap,
    private readonly maxAgeMs = 700,
  ) {}

  field(x: number, y: number, now: number): Uint16Array {
    const target = this.map.nearestOpen(x, y);
    const key = SewerMap.index(Math.floor(target.x), Math.floor(target.y));
    const cached = this.fields.get(key);
    if (cached && now - cached.at < this.maxAgeMs) return cached.field;
    const field = cached?.field ?? new Uint16Array(SIZE * SIZE);
    this.fill(field, key);
    this.fields.delete(key);
    this.fields.set(key, { field, at: now });
    if (this.fields.size > 32) this.fields.delete(this.fields.keys().next().value!);
    return field;
  }

  /** Where a body of radius `r` at (x, y) should head next on its way to (tx, ty), or null if it can't get there. */
  next(x: number, y: number, tx: number, ty: number, r: number, now: number): Spot | null {
    const { map } = this;
    if (Math.hypot(tx - x, ty - y) < 12 && map.clearWalk(x, y, tx, ty, r)) return { x: tx, y: ty };
    const field = this.field(tx, ty, now);
    let i = Math.floor(x);
    let j = Math.floor(y);
    if (field[SewerMap.index(i, j)] === 0xffff) {
      const open = map.nearestOpen(x, y);
      i = Math.floor(open.x);
      j = Math.floor(open.y);
      if (field[SewerMap.index(i, j)] === 0xffff) return null;
    }
    let best: Spot | null = null;
    for (let step = 0; step < 10; step++) {
      const here = field[SewerMap.index(i, j)];
      if (here === 0) break;
      let ni = -1;
      let nj = -1;
      let low = here;
      for (const [di, dj] of DIRS8) {
        const ci = i + di;
        const cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= SIZE || cj >= SIZE) continue;
        if (di !== 0 && dj !== 0 && (map.solid(i + di, j) || map.solid(i, j + dj))) continue;
        const v = field[SewerMap.index(ci, cj)];
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
      if (step === 0 || map.clearWalk(x, y, cx, cy, r)) best = { x: cx, y: cy };
      else break;
    }
    return best ?? { x: tx, y: ty };
  }

  private fill(field: Uint16Array, from: number): void {
    const { map, queue } = this;
    field.fill(0xffff);
    let head = 0;
    let tail = 0;
    field[from] = 0;
    queue[tail++] = from;
    while (head < tail) {
      const c = queue[head++];
      const i = c % SIZE;
      const j = (c - i) / SIZE;
      const d = field[c] + 1;
      for (let k = 0; k < 4; k++) {
        const ni = i + DIRS8[k][0];
        const nj = j + DIRS8[k][1];
        if (map.solid(ni, nj) || map.fatBlocked(ni, nj)) continue;
        const n = nj * SIZE + ni;
        if (field[n] <= d) continue;
        field[n] = d;
        queue[tail++] = n;
      }
    }
  }
}
