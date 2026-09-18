import { mulberry32 } from '@engine/index';

/**
 * The castle and the woods round it: a grid of one-meter cells every peer builds from the same seed, so nothing about
 * the place itself goes over the network. Cell (i, j) covers x in [i, i+1) and y in [j, j+1), and every cell has a
 * height: 0 for open ground, the top of a wall, a roof or a tower otherwise. It's a 2.5D world: a body standing at some
 * height walks over whatever's no more than a step above its feet, and bumps into the rest, which it can climb.
 *
 * A stone wall runs round the compound with a gate in its south side. Inside, the keep stands in the middle, watchtowers
 * at the corners and by the gate, and halls, storehouses, a tea house and a shrine are scattered between gardens of
 * bushes and stone lanterns. Outside is forest, where the shinobi gather.
 */

export const enum Tile {
  /** Beyond the map. */
  Out = 0,
  /** The forest floor outside the wall. */
  Grass = 1,
  /** Raked gravel inside it. */
  Gravel = 2,
  /** The stone path from the gate to the keep. */
  Path = 3,
  /** Low bushes: walked through, and hidden in, crouching. */
  Bush = 4,
  Wall = 5,
  /** The open gateway in the south wall. */
  Gate = 6,
  Tower = 7,
  Building = 8,
  Keep = 9,
  /** A stone lantern, lit. */
  Lantern = 10,
  Tree = 11,
}

export const enum BuildingKind {
  Keep = 0,
  Barracks = 1,
  Hall = 2,
  Storehouse = 3,
  TeaHouse = 4,
  Shrine = 5,
  Tower = 6,
}

export interface Building {
  /** Its footprint, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: BuildingKind;
  height: number;
}

export interface Spot {
  x: number;
  y: number;
}

/** A place a guard is posted, and which way it watches. */
export interface Post extends Spot {
  z: number;
  facing: number;
}

export const SIZE = 96;
/** The compound wall's cells, inclusive. Inside is strictly between. */
export const WALL = { x0: 14, y0: 16, x1: 81, y1: 83 };
export const WALL_HEIGHT = 4.5;
export const TOWER_HEIGHT = 6;
export const KEEP_HEIGHT = 9;
/** The gateway's cells in the south wall. */
export const GATE = { x0: 46, x1: 49, y: WALL.y0 };
/** Where the shinobi gather in the forest before a night, south of the gate. */
export const START = { x: 48, y: 7 };
/** The highest a body can step up without climbing, m. */
export const STEP = 0.55;
/** How far a stone lantern lights, m. */
export const LANTERN_REACH = 6.5;
/** Moonlight: how visible anyone out in the open is with no lantern near. */
export const MOONLIGHT = 0.3;

const HEIGHTS: Partial<Record<BuildingKind, [number, number]>> = {
  [BuildingKind.Hall]: [4.6, 5.4],
  [BuildingKind.Storehouse]: [3.8, 4.4],
  [BuildingKind.TeaHouse]: [3, 3.4],
  [BuildingKind.Shrine]: [3.8, 4.4],
  [BuildingKind.Barracks]: [3.8, 4.2],
};

const SIZES: Partial<Record<BuildingKind, [number, number]>> = {
  [BuildingKind.Hall]: [8, 5],
  [BuildingKind.Storehouse]: [5, 4],
  [BuildingKind.TeaHouse]: [4, 4],
  [BuildingKind.Shrine]: [4, 5],
};

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

export class Castle {
  readonly tiles = new Uint8Array(SIZE * SIZE);
  readonly heights = new Float32Array(SIZE * SIZE);
  /** Which building a cell belongs to, or -1. */
  readonly buildingOf = new Int16Array(SIZE * SIZE).fill(-1);
  readonly buildings: Building[] = [];
  readonly lanterns: Spot[] = [];
  /** Where the lord takes his ease through the night, the keep's door first. */
  readonly stations: Spot[] = [];
  /** Loops of ground a patrol walks round. */
  readonly routes: Spot[][] = [];
  /** Where guards stand watch on the ground: either side of the gate, and the keep's door. */
  readonly posts: Post[] = [];
  /** Where archers stand, on top of the towers. */
  readonly perches: Post[] = [];
  /** Where reinforcements come out: the barracks' door. */
  readonly barracks: Spot = { x: 0, y: 0 };
  private readonly rnd: () => number;

  constructor(readonly seed: number) {
    this.rnd = mulberry32(seed);
    this.grounds();
    this.fortify();
    this.build();
    this.garden();
    this.forest();
    this.plan();
  }

  static index(i: number, j: number): number {
    return j * SIZE + i;
  }

  tile(i: number, j: number): Tile {
    if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return Tile.Out;
    return this.tiles[j * SIZE + i] as Tile;
  }

  tileAt(x: number, y: number): Tile {
    return this.tile(Math.floor(x), Math.floor(y));
  }

  /** The top of a cell: 0 for the ground, and a wall that can't be climbed at all beyond the map or in a tree. */
  height(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return 50;
    return this.heights[j * SIZE + i];
  }

  heightAt(x: number, y: number): number {
    return this.height(Math.floor(x), Math.floor(y));
  }

  /** Whether a cell's side can be climbed: walls, towers, buildings, lanterns. Not trees. */
  climbable(i: number, j: number): boolean {
    const t = this.tile(i, j);
    return t === Tile.Wall || t === Tile.Tower || t === Tile.Building || t === Tile.Keep || t === Tile.Lantern;
  }

  /** Inside the compound wall. */
  inside(x: number, y: number): boolean {
    return x > WALL.x0 + 1 && x < WALL.x1 && y > WALL.y0 + 1 && y < WALL.y1;
  }

  /** Beyond the wall altogether: out in the forest. */
  outside(x: number, y: number): boolean {
    return x < WALL.x0 || x >= WALL.x1 + 1 || y < WALL.y0 || y >= WALL.y1 + 1;
  }

  /** Whether a body with its feet at `feet` can't be in a cell. */
  blocks(i: number, j: number, feet: number): boolean {
    const t = this.tile(i, j);
    return t === Tile.Out || t === Tile.Tree || this.height(i, j) > feet + STEP;
  }

  /** Whether a cell is ground anyone can walk on, at ground level. */
  open(i: number, j: number): boolean {
    return !this.blocks(i, j, 0);
  }

  /** In a bush. */
  bushAt(x: number, y: number): boolean {
    return this.tileAt(x, y) === Tile.Bush;
  }

  // -------------------------------------------------------------------------
  // Moving, standing and seeing
  // -------------------------------------------------------------------------

  /** Move a circle of radius `r`, with its feet at `feet`, by (dx, dy), sliding along what it bumps. Returns whether anything did. */
  move(p: { x: number; y: number }, dx: number, dy: number, r: number, feet = 0): boolean {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.25));
    let blocked = false;
    for (let s = 0; s < steps; s++) {
      p.x += dx / steps;
      if (this.pushOut(p, r, feet)) blocked = true;
      p.y += dy / steps;
      if (this.pushOut(p, r, feet)) blocked = true;
    }
    return blocked;
  }

  /** Push a circle out of the cells it can't be in. Returns whether it was in one. */
  pushOut(p: { x: number; y: number }, r: number, feet = 0): boolean {
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      const i0 = Math.floor(p.x - r);
      const i1 = Math.floor(p.x + r);
      const j0 = Math.floor(p.y - r);
      const j1 = Math.floor(p.y + r);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!this.blocks(i, j, feet)) continue;
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

  /**
   * What a body at (x, y) with its feet at `feet` stands on: the highest top under a small circle round it that's no more
   * than a step above its feet. Lower than `feet` means it's in the air.
   */
  support(x: number, y: number, feet: number, r = 0.22): number {
    let best = 0;
    const i0 = Math.floor(x - r);
    const i1 = Math.floor(x + r);
    const j0 = Math.floor(y - r);
    const j1 = Math.floor(y + r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const t = this.tile(i, j);
        if (t === Tile.Out || t === Tile.Tree) continue;
        const h = this.height(i, j);
        if (h <= feet + STEP && h > best) best = h;
      }
    }
    return best;
  }

  /**
   * The climbable face just ahead of a body facing `heading`, if there is one taller than a step: the cell, its top, and
   * which way the face looks (toward the body).
   */
  faceAhead(x: number, y: number, heading: number, feet: number, reach = 0.65): { i: number; j: number; top: number; nx: number; ny: number } | null {
    for (const spread of [0, 0.35, -0.35]) {
      const a = heading + spread;
      const px = x + Math.cos(a) * reach;
      const py = y + Math.sin(a) * reach;
      const i = Math.floor(px);
      const j = Math.floor(py);
      if (!this.climbable(i, j)) continue;
      const top = this.height(i, j);
      if (top <= feet + STEP) continue;
      // which side of the cell the body's on
      const cx = i + 0.5;
      const cy = j + 0.5;
      const ox = x - cx;
      const oy = y - cy;
      const nx = Math.abs(ox) >= Math.abs(oy) ? Math.sign(ox) : 0;
      const ny = nx === 0 ? Math.sign(oy) : 0;
      return { i, j, top, nx, ny };
    }
    return null;
  }

  /**
   * Whether a hand at `p` can take hold of something: the side of anything climbable within a hand's breadth of it, or
   * its top, a palm's height above.
   */
  holdable(p: { x: number; y: number; z: number }, slack = 0.14, above = 0.25): boolean {
    if (p.z < 0.3) return false;
    const i0 = Math.floor(p.x - slack);
    const i1 = Math.floor(p.x + slack);
    const j0 = Math.floor(p.y - slack);
    const j1 = Math.floor(p.y + slack);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!this.climbable(i, j)) continue;
        const h = this.height(i, j);
        if (p.z > h + above) continue;
        const dx = Math.max(i - p.x, 0, p.x - (i + 1));
        const dy = Math.max(j - p.y, 0, p.y - (j + 1));
        if (Math.hypot(dx, dy) <= slack) return true;
      }
    }
    return false;
  }

  /** Whether a straight line between two points in the air passes over or beside everything between them. */
  sees(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const ai = Math.floor(ax);
    const aj = Math.floor(ay);
    const bi = Math.floor(bx);
    const bj = Math.floor(by);
    return this.traverse(ax, ay, bx, by, (i, j, t0, t1) => {
      if ((i === ai && j === aj) || (i === bi && j === bj)) return true;
      const h = this.height(i, j);
      if (h <= 0) return true;
      const z = Math.min(az + (bz - az) * t0, az + (bz - az) * t1);
      return h < z;
    });
  }

  /**
   * How far along a ray (a unit direction) something is hit, up to `max`: the ground, or the side or top of a cell.
   * `max` if nothing is.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    const STEP_LEN = 0.1;
    for (let t = 0; t <= max; t += STEP_LEN) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      if (z <= 0) return t;
      const i = Math.floor(x);
      const j = Math.floor(y);
      const tile = this.tile(i, j);
      if (tile === Tile.Out) return t;
      const h = this.height(i, j);
      if (h > 0 && z < h) return t;
    }
    return max;
  }

  /** Visit the cells a segment passes over, with the stretch of it (0..1) over each, until `visit` says stop. */
  private traverse(ax: number, ay: number, bx: number, by: number, visit: (i: number, j: number, t0: number, t1: number) => boolean): boolean {
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
    let t = 0;
    for (let n = 0; n < SIZE * 3; n++) {
      const next = Math.min(1, tx, ty);
      if (!visit(i, j, t, next)) return false;
      if ((i === bi && j === bj) || next >= 1) return true;
      t = next;
      if (tx < ty) {
        tx += tdx;
        i += si;
      } else {
        ty += tdy;
        j += sj;
      }
    }
    return true;
  }

  /** The nearest ground cell centre a body can stand on, searching out from a point. */
  nearestOpen(x: number, y: number): Spot {
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    for (let r = 0; r < 12; r++) {
      let best: Spot | null = null;
      let bestD = Infinity;
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || !this.open(i, j)) continue;
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

  /** How lit a point is by moonlight and the stone lanterns, 0..1. Lights carried or set out come on top (see `lightAt`). */
  staticLight(x: number, y: number): number {
    let light = MOONLIGHT;
    for (const l of this.lanterns) {
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < LANTERN_REACH) light = Math.max(light, 1 - (d / LANTERN_REACH) * 0.75);
    }
    return light;
  }

  /** Every ground cell that can be walked to from the gate. */
  reachable(): Uint8Array {
    const seen = new Uint8Array(SIZE * SIZE);
    const queue = new Int32Array(SIZE * SIZE);
    let head = 0;
    let tail = 0;
    const start = Castle.index(GATE.x0 + 1, GATE.y);
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++];
      const i = c % SIZE;
      const j = (c - i) / SIZE;
      for (let d = 0; d < 4; d++) {
        const ni = i + DIRS8[d][0];
        const nj = j + DIRS8[d][1];
        if (!this.open(ni, nj)) continue;
        const n = nj * SIZE + ni;
        if (seen[n]) continue;
        seen[n] = 1;
        queue[tail++] = n;
      }
    }
    return seen;
  }

  // -------------------------------------------------------------------------
  // Building it
  // -------------------------------------------------------------------------

  private set(i: number, j: number, t: Tile, h = 0): void {
    if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return;
    this.tiles[j * SIZE + i] = t;
    this.heights[j * SIZE + i] = h;
  }

  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.rnd() * (hi - lo + 1));
  }

  /** Grass everywhere, gravel inside the wall, and the path up to the keep. */
  private grounds(): void {
    for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) this.set(i, j, this.inside(i + 0.5, j + 0.5) ? Tile.Gravel : Tile.Grass);
    for (let j = WALL.y0; j < 50; j++) for (let i = GATE.x0; i <= GATE.x1; i++) this.set(i, j, Tile.Path);
  }

  /** The wall, its gate, and the watchtowers. */
  private fortify(): void {
    for (let j = WALL.y0; j <= WALL.y1; j++) {
      for (let i = WALL.x0; i <= WALL.x1; i++) {
        if (i === WALL.x0 || i === WALL.x1 || j === WALL.y0 || j === WALL.y1) this.set(i, j, Tile.Wall, WALL_HEIGHT);
      }
    }
    for (let i = GATE.x0; i <= GATE.x1; i++) this.set(i, GATE.y, Tile.Gate);
    const towers: [number, number, number][] = [
      [WALL.x0 + 2, WALL.y0 + 2, Math.PI * 1.25],
      [WALL.x1 - 4, WALL.y0 + 2, Math.PI * 1.75],
      [WALL.x0 + 2, WALL.y1 - 4, Math.PI * 0.75],
      [WALL.x1 - 4, WALL.y1 - 4, Math.PI * 0.25],
      [GATE.x0 - 5, WALL.y0 + 2, Math.PI * 1.5],
      [GATE.x1 + 3, WALL.y0 + 2, Math.PI * 1.5],
    ];
    for (const [i, j, facing] of towers) {
      this.addBuilding(i, j, i + 2, j + 2, BuildingKind.Tower, TOWER_HEIGHT, Tile.Tower);
      this.perches.push({ x: i + 1.5, y: j + 1.5, z: TOWER_HEIGHT, facing });
    }
  }

  private addBuilding(x0: number, y0: number, x1: number, y1: number, kind: BuildingKind, height: number, tile = Tile.Building): Building {
    const b: Building = { x0, y0, x1, y1, kind, height };
    const index = this.buildings.length;
    this.buildings.push(b);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        this.set(i, j, tile, height);
        this.buildingOf[Castle.index(i, j)] = index;
      }
    }
    return b;
  }

  /** Whether a footprint, and a margin of `gap` round it, is all open gravel. */
  private clearFor(x0: number, y0: number, x1: number, y1: number, gap: number): boolean {
    for (let j = y0 - gap; j <= y1 + gap; j++) {
      for (let i = x0 - gap; i <= x1 + gap; i++) {
        if (!this.inside(i + 0.5, j + 0.5) || this.tile(i, j) !== Tile.Gravel) return false;
      }
    }
    return true;
  }

  /** The keep, the barracks by the gate, and halls, storehouses, a tea house and a shrine where they fit. */
  private build(): void {
    this.addBuilding(41, 51, 54, 62, BuildingKind.Keep, KEEP_HEIGHT, Tile.Keep);
    this.addBuilding(WALL.x0 + 7, WALL.y0 + 6, WALL.x0 + 15, WALL.y0 + 10, BuildingKind.Barracks, 4);
    Object.assign(this.barracks, { x: WALL.x0 + 11.5, y: WALL.y0 + 11.8 });

    const wanted: BuildingKind[] = [BuildingKind.TeaHouse, BuildingKind.Shrine, BuildingKind.Hall, BuildingKind.Hall, BuildingKind.Storehouse, BuildingKind.Storehouse, BuildingKind.Storehouse, BuildingKind.Hall, BuildingKind.TeaHouse];
    for (const kind of wanted) {
      for (let attempt = 0; attempt < 80; attempt++) {
        let [w, h] = SIZES[kind]!;
        if (this.rnd() < 0.5) [w, h] = [h, w];
        const x0 = this.int(WALL.x0 + 4, WALL.x1 - 3 - w);
        const y0 = this.int(WALL.y0 + 4, WALL.y1 - 3 - h);
        const x1 = x0 + w - 1;
        const y1 = y0 + h - 1;
        // keep the way from the gate to the keep open
        if (x1 >= GATE.x0 - 3 && x0 <= GATE.x1 + 3 && y0 < 51) continue;
        if (!this.clearFor(x0, y0, x1, y1, 3)) continue;
        const [lo, hi] = HEIGHTS[kind]!;
        this.addBuilding(x0, y0, x1, y1, kind, Math.round((lo + this.rnd() * (hi - lo)) * 10) / 10);
        break;
      }
    }
  }

  /** Bushes to hide in, and stone lanterns along the path, before the doors and in the gardens. */
  private garden(): void {
    let reach = this.countReachable();
    const tryLantern = (i: number, j: number): void => {
      if (this.tile(i, j) !== Tile.Gravel || !this.inside(i + 0.5, j + 0.5)) return;
      for (const l of this.lanterns) if (Math.hypot(l.x - i - 0.5, l.y - j - 0.5) < 5) return;
      this.set(i, j, Tile.Lantern, 1.3);
      const now = this.countReachable();
      if (now !== reach - 1) {
        this.set(i, j, Tile.Gravel);
        return;
      }
      reach = now;
      this.lanterns.push({ x: i + 0.5, y: j + 0.5 });
    };
    // along the path, in pairs
    for (let j = WALL.y0 + 6; j < 49; j += 8) {
      tryLantern(GATE.x0 - 2, j);
      tryLantern(GATE.x1 + 2, j);
    }
    // before each building's door (its south side), and at the keep's
    for (const b of this.buildings) {
      if (b.kind === BuildingKind.Tower) continue;
      const cx = Math.floor((b.x0 + b.x1) / 2);
      tryLantern(cx - 2, b.y0 - 2);
      tryLantern(cx + 3, b.y0 - 2);
    }
    // bushes in clumps, off the path
    for (let clump = 0; clump < 26; clump++) {
      const ci = this.int(WALL.x0 + 3, WALL.x1 - 3);
      const cj = this.int(WALL.y0 + 4, WALL.y1 - 3);
      if (ci >= GATE.x0 - 1 && ci <= GATE.x1 + 1 && cj < 50) continue;
      const n = this.int(3, 8);
      let i = ci;
      let j = cj;
      for (let k = 0; k < n; k++) {
        if (this.tile(i, j) === Tile.Gravel && this.inside(i + 0.5, j + 0.5)) this.set(i, j, Tile.Bush);
        const [di, dj] = DIRS8[this.int(0, 3)];
        i += di;
        j += dj;
      }
    }
    // a few lanterns out in the gardens, near bushes, so hiding places aren't all in the dark
    for (let attempt = 0; attempt < 200 && this.lanterns.length < 30; attempt++) {
      const i = this.int(WALL.x0 + 3, WALL.x1 - 3);
      const j = this.int(WALL.y0 + 3, WALL.y1 - 3);
      let bushes = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if (this.tile(i + di, j + dj) === Tile.Bush) bushes++;
      if (bushes >= 2) tryLantern(i, j);
    }
  }

  /** Trees outside the wall, leaving a clear strip along it and a clearing south of the gate. */
  private forest(): void {
    for (let attempt = 0; attempt < 2400; attempt++) {
      const i = this.int(0, SIZE - 1);
      const j = this.int(0, SIZE - 1);
      if (this.tile(i, j) !== Tile.Grass) continue;
      if (i > WALL.x0 - 5 && i < WALL.x1 + 5 && j > WALL.y0 - 5 && j < WALL.y1 + 5) continue;
      if (Math.hypot(i - START.x, j - START.y) < 9) continue;
      let crowded = false;
      for (let dj = -2; dj <= 2 && !crowded; dj++) for (let di = -2; di <= 2; di++) if (this.tile(i + di, j + dj) === Tile.Tree) crowded = true;
      if (!crowded) this.set(i, j, Tile.Tree, 12);
    }
    // the edge of the map
    for (let k = 0; k < SIZE; k++) {
      this.set(k, 0, Tile.Out, 50);
      this.set(k, SIZE - 1, Tile.Out, 50);
      this.set(0, k, Tile.Out, 50);
      this.set(SIZE - 1, k, Tile.Out, 50);
    }
  }

  /** Where the lord goes, the patrols' loops, and the guards' posts. */
  private plan(): void {
    const keep = this.buildings[this.buildings.findIndex((b) => b.kind === BuildingKind.Keep)];
    this.stations.push(this.nearestOpen((keep.x0 + keep.x1 + 1) / 2, keep.y0 - 1.5));
    for (const b of this.buildings) {
      if (b.kind !== BuildingKind.TeaHouse && b.kind !== BuildingKind.Shrine && b.kind !== BuildingKind.Hall) continue;
      this.stations.push(this.nearestOpen((b.x0 + b.x1 + 1) / 2, b.y0 - 1.5));
    }
    // by the wall, round the whole compound
    const inset = 6.5;
    this.routes.push(
      [
        { x: WALL.x0 + inset, y: WALL.y0 + inset },
        { x: WALL.x1 - inset + 1, y: WALL.y0 + inset },
        { x: WALL.x1 - inset + 1, y: WALL.y1 - inset + 1 },
        { x: WALL.x0 + inset, y: WALL.y1 - inset + 1 },
      ].map((p) => this.nearestOpen(p.x, p.y)),
    );
    // round the keep
    this.routes.push(
      [
        { x: keep.x0 - 3, y: keep.y0 - 3 },
        { x: keep.x1 + 4, y: keep.y0 - 3 },
        { x: keep.x1 + 4, y: keep.y1 + 4 },
        { x: keep.x0 - 3, y: keep.y1 + 4 },
      ].map((p) => this.nearestOpen(p.x, p.y)),
    );
    // two wandering loops, one on each side of the keep
    for (const side of [-1, 1]) {
      const points: Spot[] = [];
      for (let k = 0; k < 5; k++) {
        const x = side < 0 ? this.int(WALL.x0 + 5, 38) : this.int(58, WALL.x1 - 5);
        const y = this.int(WALL.y0 + 8, WALL.y1 - 6);
        points.push(this.nearestOpen(x + 0.5, y + 0.5));
      }
      const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
      const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
      points.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
      this.routes.push(points);
    }
    this.posts.push({ ...this.nearestOpen(GATE.x0 - 1.5, WALL.y0 + 2.5), z: 0, facing: -Math.PI / 2 });
    this.posts.push({ ...this.nearestOpen(GATE.x1 + 2.5, WALL.y0 + 2.5), z: 0, facing: -Math.PI / 2 });
    const door = this.stations[0];
    this.posts.push({ ...this.nearestOpen(door.x - 3, door.y - 1), z: 0, facing: -Math.PI / 2 });
  }

  private countReachable(): number {
    const seen = this.reachable();
    let n = 0;
    for (let c = 0; c < seen.length; c++) n += seen[c];
    return n;
  }
}

/**
 * Distance fields over the ground: how many steps every cell is from a target, walking. A guard heads downhill on the
 * field for where it's going, cutting corners wherever it can walk straight. The castle never changes once it's built,
 * so a field is good for as long as it's kept, and it's shared by everyone going the same way.
 */
export class Paths {
  private readonly fields = new Map<number, Uint16Array>();
  private readonly queue = new Int32Array(SIZE * SIZE);
  /** Which cells can be walked on, so filling a field is plain array work. */
  private readonly walkable = new Uint8Array(SIZE * SIZE);

  constructor(private readonly castle: Castle) {
    for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) this.walkable[j * SIZE + i] = castle.open(i, j) ? 1 : 0;
  }

  field(x: number, y: number): Uint16Array {
    const target = this.castle.nearestOpen(x, y);
    const key = Castle.index(Math.floor(target.x), Math.floor(target.y));
    let field = this.fields.get(key);
    if (field) {
      // most recently used goes to the back
      this.fields.delete(key);
    } else {
      field = new Uint16Array(SIZE * SIZE);
      this.fill(field, key);
      if (this.fields.size >= 64) this.fields.delete(this.fields.keys().next().value!);
    }
    this.fields.set(key, field);
    return field;
  }

  /** Whether a body of radius `r` could walk straight along the ground from a to b. */
  clearWalk(ax: number, ay: number, bx: number, by: number, r: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return this.castle.open(Math.floor(ax), Math.floor(ay));
    const steps = Math.ceil(len / 0.3);
    const ox = (-dy / len) * r;
    const oy = (dx / len) * r;
    for (let s = 0; s <= steps; s++) {
      const x = ax + (dx * s) / steps;
      const y = ay + (dy * s) / steps;
      if (!this.castle.open(Math.floor(x), Math.floor(y)) || !this.castle.open(Math.floor(x + ox), Math.floor(y + oy)) || !this.castle.open(Math.floor(x - ox), Math.floor(y - oy))) return false;
    }
    return true;
  }

  /** Where a body at (x, y) should head for next on its way to (tx, ty), or null if it can't get there. */
  next(x: number, y: number, tx: number, ty: number, r: number): Spot | null {
    const { castle } = this;
    if (Math.hypot(tx - x, ty - y) < 12 && this.clearWalk(x, y, tx, ty, r)) return { x: tx, y: ty };
    const field = this.field(tx, ty);
    let i = Math.floor(x);
    let j = Math.floor(y);
    if (field[Castle.index(i, j)] === 0xffff) {
      const open = castle.nearestOpen(x, y);
      i = Math.floor(open.x);
      j = Math.floor(open.y);
      if (field[Castle.index(i, j)] === 0xffff) return null;
      return open;
    }
    let best: Spot | null = null;
    for (let step = 0; step < 10; step++) {
      const here = field[Castle.index(i, j)];
      if (here === 0) break;
      let ni = -1;
      let nj = -1;
      let low = here;
      for (const [di, dj] of DIRS8) {
        const ci = i + di;
        const cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= SIZE || cj >= SIZE) continue;
        if (di !== 0 && dj !== 0 && (!castle.open(i + di, j) || !castle.open(i, j + dj))) continue;
        const v = field[Castle.index(ci, cj)];
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

  private fill(field: Uint16Array, from: number): void {
    const { walkable, queue } = this;
    field.fill(0xffff);
    let head = 0;
    let tail = 0;
    field[from] = 0;
    queue[tail++] = from;
    while (head < tail) {
      const c = queue[head++];
      const i = c % SIZE;
      const d = field[c] + 1;
      if (i + 1 < SIZE && walkable[c + 1] && field[c + 1] > d) {
        field[c + 1] = d;
        queue[tail++] = c + 1;
      }
      if (i > 0 && walkable[c - 1] && field[c - 1] > d) {
        field[c - 1] = d;
        queue[tail++] = c - 1;
      }
      if (c + SIZE < SIZE * SIZE && walkable[c + SIZE] && field[c + SIZE] > d) {
        field[c + SIZE] = d;
        queue[tail++] = c + SIZE;
      }
      if (c >= SIZE && walkable[c - SIZE] && field[c - SIZE] > d) {
        field[c - SIZE] = d;
        queue[tail++] = c - SIZE;
      }
    }
  }
}
