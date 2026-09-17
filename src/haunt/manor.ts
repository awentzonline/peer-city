import { mulberry32 } from '@engine/index';

/**
 * The manor and its grounds: a grid of one-meter cells every peer builds from the same seed, so nothing about the
 * place itself goes over the network. Cell (i, j) covers x in [i, i+1) and y in [j, j+1). The gate is on the south
 * side (low y), the yard runs round the house inside an iron fence, and the lane outside is where escapees end up.
 *
 * The house is cut into rooms by splitting it again and again (a BSP), with a doorway in every wall a split makes, so
 * every room can be reached; then a few more doorways make loops to run round, and furniture goes in where it doesn't
 * cut anything off. On top of the grid: circle collision, line of sight, and distance fields monsters find their way by.
 */

export const enum Tile {
  /** Beyond the map. */
  Out = 0,
  /** The lane outside the fence. */
  Lane = 1,
  Grass = 2,
  /** The gravel drive from the gate to the front door. */
  Path = 3,
  Floor = 4,
  Wall = 5,
  Fence = 6,
  /** Shut until every key's in the pedestal. */
  Gate = 7,
  Tree = 8,
  Grave = 9,
  Furniture = 10,
  Pedestal = 11,
}

export const enum Piece {
  None = 0,
  Shelf = 1,
  Table = 2,
  Bed = 3,
  Chest = 4,
  Piano = 5,
  Statue = 6,
  Couch = 7,
  Desk = 8,
}

export const enum RoomKind {
  Hall = 0,
  Library = 1,
  Dining = 2,
  Bedroom = 3,
  Study = 4,
  Parlour = 5,
  Chapel = 6,
}

export const ROOM_NAMES: Record<RoomKind, string> = {
  [RoomKind.Hall]: 'the entrance hall',
  [RoomKind.Library]: 'the library',
  [RoomKind.Dining]: 'the dining room',
  [RoomKind.Bedroom]: 'a bedroom',
  [RoomKind.Study]: 'the study',
  [RoomKind.Parlour]: 'the parlour',
  [RoomKind.Chapel]: 'the chapel',
};

export interface Room {
  /** Its floor, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: RoomKind;
}

export interface Spot {
  x: number;
  y: number;
}

export const SIZE = 80;
/** The fence runs round the cells from here to `FENCE_MAX`, inclusive. */
export const FENCE_MIN = 4;
export const FENCE_MAX = 75;
export const HOUSE = { x0: 12, y0: 24, x1: 67, y1: 69 };
/** Gate cells in the fence's south side. */
export const GATE = { x0: 37, x1: 42, y: FENCE_MIN };
/** The pedestal's cells, and where each key sits in it. */
export const PEDESTAL = { x0: 39, y0: 12, x1: 40, y1: 13, cx: 40, cy: 13 };
export const SOCKETS: readonly Spot[] = [
  { x: 39.35, y: 12.4 },
  { x: 40.65, y: 12.4 },
  { x: 40, y: 13.65 },
];
/** Where survivors gather before the hunt, and come back to each night. */
export const START = { x: 40, y: 8 };
/** Nothing can be summoned this close to the pedestal. */
export const SANCTUARY = 9;
/** Floor a key could be hidden on, and furthest from the front door first. */
const MIN_ROOM = 5;
const MAX_ROOM = 13;
/** The wall's height, for drawing and for what a flashlight hits. */
export const WALL_HEIGHT = 3.2;

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

export class Manor {
  readonly tiles = new Uint8Array(SIZE * SIZE);
  readonly pieces = new Uint8Array(SIZE * SIZE);
  /** Which room a floor cell is in, or -1. */
  readonly roomOf = new Int16Array(SIZE * SIZE).fill(-1);
  readonly rooms: Room[] = [];
  /** Doorways: floor cells in a wall. */
  readonly doors = new Set<number>();
  /** Places a key can be left, one per room, spread through the house. */
  readonly keySpots: Spot[] = [];
  /** Wall sconces, as a cell next to a wall and the direction the wall's in. */
  readonly sconces: { x: number; y: number; dx: number; dy: number }[] = [];
  /** Whether the gate's open to survivors, set from the round every frame. */
  gateOpen = false;
  private readonly rnd: () => number;

  constructor(readonly seed: number) {
    this.rnd = mulberry32(seed);
    this.grounds();
    this.house();
    this.furnish();
    this.yard();
    this.findKeySpots();
    this.findSconces();
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

  /** Whether a body can't be in a cell. `gate` open lets it through the gate. */
  solid(i: number, j: number, gate = false): boolean {
    const t = this.tile(i, j);
    return t === Tile.Out || t === Tile.Wall || t === Tile.Fence || t === Tile.Tree || t === Tile.Grave || t === Tile.Furniture || t === Tile.Pedestal || (t === Tile.Gate && !gate);
  }

  /** Whether a cell hides what's behind it. Furniture, graves and railings are low or open enough to see past. */
  blocksSight(i: number, j: number): boolean {
    const t = this.tile(i, j);
    return t === Tile.Out || t === Tile.Wall || t === Tile.Tree;
  }

  /** Inside the house (under its roof). */
  indoors(x: number, y: number): boolean {
    const i = Math.floor(x);
    const j = Math.floor(y);
    return i > HOUSE.x0 && i < HOUSE.x1 && j > HOUSE.y0 && j < HOUSE.y1;
  }

  /** Inside the fence. */
  inGrounds(x: number, y: number): boolean {
    return x > FENCE_MIN && x < FENCE_MAX + 1 && y > FENCE_MIN + 1 && y < FENCE_MAX;
  }

  /** The room a point's in, or null. */
  room(x: number, y: number): Room | null {
    const i = Math.floor(x);
    const j = Math.floor(y);
    if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return null;
    const r = this.roomOf[j * SIZE + i];
    return r >= 0 ? this.rooms[r] : null;
  }

  // -------------------------------------------------------------------------
  // Movement and sight
  // -------------------------------------------------------------------------

  /**
   * Move a circle of radius `r` by (dx, dy), sliding along whatever it meets. `gate` lets it through an open gate.
   * Returns whether anything got in the way.
   */
  move(p: { x: number; y: number }, dx: number, dy: number, r: number, gate = false): boolean {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.3));
    let blocked = false;
    for (let s = 0; s < steps; s++) {
      p.x += dx / steps;
      if (this.pushOut(p, r, gate)) blocked = true;
      p.y += dy / steps;
      if (this.pushOut(p, r, gate)) blocked = true;
    }
    return blocked;
  }

  /** Push a circle out of solid cells. Returns whether it was in one. */
  pushOut(p: { x: number; y: number }, r: number, gate = false): boolean {
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      const i0 = Math.floor(p.x - r);
      const i1 = Math.floor(p.x + r);
      const j0 = Math.floor(p.y - r);
      const j1 = Math.floor(p.y + r);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!this.solid(i, j, gate)) continue;
          const qx = Math.min(Math.max(p.x, i), i + 1);
          const qy = Math.min(Math.max(p.y, j), j + 1);
          const ex = p.x - qx;
          const ey = p.y - qy;
          const d = Math.hypot(ex, ey);
          if (d >= r) continue;
          hit = true;
          if (d > 1e-6) {
            p.x += (ex / d) * (r - d);
            p.y += (ey / d) * (r - d);
          } else {
            // the centre's inside the cell: out through the nearest side
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
      if (!hit) break;
    }
    return hit;
  }

  /** Whether nothing that blocks sight lies between two points. */
  sees(ax: number, ay: number, bx: number, by: number): boolean {
    return this.traverse(ax, ay, bx, by, (i, j) => !this.blocksSight(i, j));
  }

  /** Whether a body of radius `r` could walk straight from a to b: its middle and both its sides clear. */
  clearWalk(ax: number, ay: number, bx: number, by: number, r: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return !this.solid(Math.floor(ax), Math.floor(ay));
    const ox = (-dy / len) * r;
    const oy = (dx / len) * r;
    const open = (i: number, j: number) => !this.solid(i, j);
    return this.traverse(ax, ay, bx, by, open) && this.traverse(ax + ox, ay + oy, bx + ox, by + oy, open) && this.traverse(ax - ox, ay - oy, bx - ox, by - oy, open);
  }

  /** Visit the cells a segment passes through, in order, until `visit` says stop. Returns whether it got to the end. */
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
  nearestOpen(x: number, y: number, gate = false): Spot {
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    for (let r = 0; r < 8; r++) {
      let best: Spot | null = null;
      let bestD = Infinity;
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || this.solid(i, j, gate)) continue;
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

  /** Every cell a body can reach from the start, walking inside the fence. */
  reachable(): Uint8Array {
    const seen = new Uint8Array(SIZE * SIZE);
    const queue = new Int32Array(SIZE * SIZE);
    let head = 0;
    let tail = 0;
    const start = Manor.index(START.x, START.y);
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++];
      const i = c % SIZE;
      const j = (c - i) / SIZE;
      for (let d = 0; d < 4; d++) {
        const ni = i + DIRS8[d][0];
        const nj = j + DIRS8[d][1];
        if (this.solid(ni, nj)) continue;
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

  private set(i: number, j: number, t: Tile): void {
    if (i >= 0 && j >= 0 && i < SIZE && j < SIZE) this.tiles[j * SIZE + i] = t;
  }

  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.rnd() * (hi - lo + 1));
  }

  /** The lane, the fence and its gate, grass inside, and the drive up to the house. */
  private grounds(): void {
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const inside = i > FENCE_MIN && i < FENCE_MAX && j > FENCE_MIN && j < FENCE_MAX;
        const fence = (i === FENCE_MIN || i === FENCE_MAX || j === FENCE_MIN || j === FENCE_MAX) && i >= FENCE_MIN && i <= FENCE_MAX && j >= FENCE_MIN && j <= FENCE_MAX;
        this.set(i, j, fence ? Tile.Fence : inside ? Tile.Grass : Tile.Lane);
      }
    }
    for (let i = GATE.x0; i <= GATE.x1; i++) this.set(i, GATE.y, Tile.Gate);
    for (let j = FENCE_MIN + 1; j < HOUSE.y0; j++) for (let i = 38; i <= 41; i++) this.set(i, j, Tile.Path);
    for (let j = PEDESTAL.y0; j <= PEDESTAL.y1; j++) for (let i = PEDESTAL.x0; i <= PEDESTAL.x1; i++) this.set(i, j, Tile.Pedestal);
  }

  /** The walls, rooms and doorways. */
  private house(): void {
    const { x0, y0, x1, y1 } = HOUSE;
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const edge = i === x0 || i === x1 || j === y0 || j === y1;
        this.set(i, j, edge ? Tile.Wall : Tile.Floor);
      }
    }
    // the front door, wide, facing the gate; one in each other side
    this.door(38, y0, 4, true);
    this.door(x0, this.int(y0 + 10, y1 - 12), 2, false);
    this.door(x1, this.int(y0 + 10, y1 - 12), 2, false);
    this.door(this.int(x0 + 8, x1 - 10), y1, 2, true);
    this.split(x0 + 1, y0 + 1, x1 - 1, y1 - 1, 0);
    this.loops();
    // the room behind the front door is the entrance hall
    const hall = this.roomOf[Manor.index(39, y0 + 1)];
    if (hall >= 0) this.rooms[hall].kind = RoomKind.Hall;
  }

  /** A doorway `width` cells wide along a wall from (i, j): along x if `alongX`. */
  private door(i: number, j: number, width: number, alongX: boolean): void {
    for (let k = 0; k < width; k++) {
      const di = alongX ? i + k : i;
      const dj = alongX ? j : j + k;
      this.set(di, dj, Tile.Floor);
      this.doors.add(Manor.index(di, dj));
    }
  }

  /** Whether a wall cell has a doorway within a cell of it, so a new wall mustn't meet it there. */
  private nearDoor(i: number, j: number): boolean {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (this.doors.has(Manor.index(i + di, j + dj))) return true;
    return false;
  }

  /** Split a rectangle of floor into rooms. */
  private split(x0: number, y0: number, x1: number, y1: number, depth: number): void {
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const canX = w >= MIN_ROOM * 2 + 1;
    const canY = h >= MIN_ROOM * 2 + 1;
    const small = w <= MAX_ROOM && h <= MAX_ROOM;
    if ((!canX && !canY) || (small && (depth > 1 && this.rnd() < 0.45))) {
      this.addRoom(x0, y0, x1, y1);
      return;
    }
    const vertical = canX && (!canY || w > h * 1.2 || (h <= w * 1.2 && this.rnd() < 0.5));
    for (let attempt = 0; attempt < 12; attempt++) {
      if (vertical) {
        const c = this.int(x0 + MIN_ROOM, x1 - MIN_ROOM);
        if (this.nearDoor(c, y0 - 1) || this.nearDoor(c, y1 + 1)) continue;
        for (let j = y0; j <= y1; j++) this.set(c, j, Tile.Wall);
        const d = this.int(y0 + 1, y1 - 2);
        this.door(c, d, 2, false);
        this.split(x0, y0, c - 1, y1, depth + 1);
        this.split(c + 1, y0, x1, y1, depth + 1);
        return;
      }
      const c = this.int(y0 + MIN_ROOM, y1 - MIN_ROOM);
      if (this.nearDoor(x0 - 1, c) || this.nearDoor(x1 + 1, c)) continue;
      for (let i = x0; i <= x1; i++) this.set(i, c, Tile.Wall);
      const d = this.int(x0 + 1, x1 - 2);
      this.door(d, c, 2, true);
      this.split(x0, y0, x1, c - 1, depth + 1);
      this.split(x0, c + 1, x1, y1, depth + 1);
      return;
    }
    this.addRoom(x0, y0, x1, y1);
  }

  private addRoom(x0: number, y0: number, x1: number, y1: number): void {
    const kinds = [RoomKind.Library, RoomKind.Dining, RoomKind.Bedroom, RoomKind.Bedroom, RoomKind.Study, RoomKind.Parlour, RoomKind.Chapel];
    const index = this.rooms.length;
    this.rooms.push({ x0, y0, x1, y1, kind: kinds[Math.floor(this.rnd() * kinds.length)] });
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (this.tile(i, j) === Tile.Floor) this.roomOf[Manor.index(i, j)] = index;
  }

  /** More doorways through inner walls, so there are loops to run round rather than dead ends. */
  private loops(): void {
    const { x0, y0, x1, y1 } = HOUSE;
    const candidates: { i: number; j: number; alongX: boolean }[] = [];
    for (let j = y0 + 2; j < y1 - 2; j++) {
      for (let i = x0 + 2; i < x1 - 2; i++) {
        if (this.tile(i, j) !== Tile.Wall || this.nearDoor(i, j)) continue;
        // two wall cells in a row with floor either side of both, and no wall crossing them
        const acrossX = this.tile(i, j - 1) === Tile.Floor && this.tile(i, j + 1) === Tile.Floor && this.tile(i + 1, j) === Tile.Wall && this.tile(i + 1, j - 1) === Tile.Floor && this.tile(i + 1, j + 1) === Tile.Floor && this.tile(i + 2, j) === Tile.Wall && this.tile(i - 1, j) === Tile.Wall;
        const acrossY = this.tile(i - 1, j) === Tile.Floor && this.tile(i + 1, j) === Tile.Floor && this.tile(i, j + 1) === Tile.Wall && this.tile(i - 1, j + 1) === Tile.Floor && this.tile(i + 1, j + 1) === Tile.Floor && this.tile(i, j + 2) === Tile.Wall && this.tile(i, j - 1) === Tile.Wall;
        if (acrossX) candidates.push({ i, j, alongX: true });
        if (acrossY) candidates.push({ i, j, alongX: false });
      }
    }
    let made = 0;
    while (candidates.length && made < 9) {
      const { i, j, alongX } = candidates.splice(Math.floor(this.rnd() * candidates.length), 1)[0];
      if (this.nearDoor(i, j) || this.nearDoor(alongX ? i + 1 : i, alongX ? j : j + 1)) continue;
      this.door(i, j, 2, alongX);
      made++;
    }
  }

  /** Furniture by what each room is, wherever it leaves every bit of floor reachable. */
  private furnish(): void {
    let reach = this.countReachable();
    const place = (cells: [number, number][], piece: Piece): boolean => {
      for (const [i, j] of cells) if (this.tile(i, j) !== Tile.Floor || this.nearDoor(i, j)) return false;
      for (const [i, j] of cells) {
        this.set(i, j, Tile.Furniture);
        this.pieces[Manor.index(i, j)] = piece;
      }
      const now = this.countReachable();
      if (now !== reach - cells.length) {
        for (const [i, j] of cells) {
          this.set(i, j, Tile.Floor);
          this.pieces[Manor.index(i, j)] = Piece.None;
        }
        return false;
      }
      reach = now;
      return true;
    };
    const rect = (i: number, j: number, w: number, h: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let y = j; y < j + h; y++) for (let x = i; x < i + w; x++) out.push([x, y]);
      return out;
    };

    for (const room of this.rooms) {
      const { x0, y0, x1, y1 } = room;
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      const cx = Math.floor((x0 + x1) / 2);
      const cy = Math.floor((y0 + y1) / 2);
      switch (room.kind) {
        case RoomKind.Library:
          // shelves along the long walls, with gaps
          for (let i = x0; i <= x1; i++) {
            if ((i - x0) % 4 === 3) continue;
            place([[i, y0]], Piece.Shelf);
            place([[i, y1]], Piece.Shelf);
          }
          if (w >= 8 && h >= 7) place(rect(cx - 1, cy, 3, 1), Piece.Table);
          break;
        case RoomKind.Dining:
          if (w >= h) place(rect(x0 + 2, cy, Math.max(2, w - 4), 1), Piece.Table);
          else place(rect(cx, y0 + 2, 1, Math.max(2, h - 4)), Piece.Table);
          break;
        case RoomKind.Bedroom:
          place(rect(x0, y1 - 2, 2, 3), Piece.Bed) || place(rect(x1 - 1, y0, 2, 3), Piece.Bed);
          place([[x1, y1]], Piece.Chest);
          break;
        case RoomKind.Study:
          place(rect(cx, cy, 2, 1), Piece.Desk);
          for (let j = y0 + 1; j < y1; j += 2) place([[x0, j]], Piece.Shelf);
          break;
        case RoomKind.Parlour:
          place(rect(x0 + 1, y0 + 1, 2, 2), Piece.Piano);
          place(rect(x1 - 1, cy - 1, 1, 3), Piece.Couch);
          break;
        case RoomKind.Chapel:
          for (let j = y0 + 2; j < y1 - 1; j += 2) {
            place(rect(x0 + 1, j, Math.max(1, Math.floor(w / 2) - 2), 1), Piece.Couch);
            place(rect(cx + 2, j, Math.max(1, x1 - cx - 3), 1), Piece.Couch);
          }
          break;
        case RoomKind.Hall:
          place([[x0 + 1, y0 + 1]], Piece.Statue);
          place([[x1 - 1, y0 + 1]], Piece.Statue);
          break;
      }
    }
  }

  private countReachable(): number {
    const seen = this.reachable();
    let n = 0;
    for (let c = 0; c < seen.length; c++) n += seen[c];
    return n;
  }

  /** Trees round the house, and a graveyard on its west side. */
  private yard(): void {
    const clear = (i: number, j: number) =>
      this.tile(i, j) === Tile.Grass && (i < HOUSE.x0 - 1 || i > HOUSE.x1 + 1 || j < HOUSE.y0 - 1 || j > HOUSE.y1 + 1) && !(i >= 33 && i <= 46 && j < HOUSE.y0) && !this.nearHouseDoor(i, j);
    // the graveyard
    for (let j = 44; j <= 66; j += 3) for (let i = 6; i <= 9; i += 3) if (clear(i, j)) this.set(i, j, Tile.Grave);
    let trees = 0;
    let reach = this.countReachable();
    for (let attempt = 0; attempt < 400 && trees < 46; attempt++) {
      const i = this.int(FENCE_MIN + 2, FENCE_MAX - 2);
      const j = this.int(FENCE_MIN + 2, FENCE_MAX - 2);
      if (!clear(i, j)) continue;
      let crowded = false;
      for (let dj = -2; dj <= 2 && !crowded; dj++) for (let di = -2; di <= 2; di++) if (this.tile(i + di, j + dj) === Tile.Tree || this.tile(i + di, j + dj) === Tile.Grave) crowded = true;
      if (crowded) continue;
      this.set(i, j, Tile.Tree);
      const now = this.countReachable();
      if (now !== reach - 1) {
        this.set(i, j, Tile.Grass);
        continue;
      }
      reach = now;
      trees++;
    }
  }

  /** Within a few cells of a doorway in the house's outer wall. */
  private nearHouseDoor(i: number, j: number): boolean {
    for (const d of this.doors) {
      const di = d % SIZE;
      const dj = (d - di) / SIZE;
      const outer = di === HOUSE.x0 || di === HOUSE.x1 || dj === HOUSE.y0 || dj === HOUSE.y1;
      if (outer && Math.abs(di - i) <= 3 && Math.abs(dj - j) <= 3) return true;
    }
    return false;
  }

  /** One spot per room away from the hall, in the open, where a key can lie. */
  private findKeySpots(): void {
    for (const room of this.rooms) {
      if (room.kind === RoomKind.Hall) continue;
      const cx = (room.x0 + room.x1) / 2;
      const cy = (room.y0 + room.y1) / 2;
      let best: Spot | null = null;
      let bestD = Infinity;
      for (let j = room.y0; j <= room.y1; j++) {
        for (let i = room.x0; i <= room.x1; i++) {
          if (!this.openAround(i, j)) continue;
          const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
          if (d < bestD) {
            bestD = d;
            best = { x: i + 0.5, y: j + 0.5 };
          }
        }
      }
      if (best) this.keySpots.push(best);
    }
  }

  /** A floor cell with nothing solid round it. */
  private openAround(i: number, j: number): boolean {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (this.solid(i + di, j + dj) || this.tile(i + di, j + dj) !== Tile.Floor) return false;
    return true;
  }

  /** Candle sconces along the walls: a few per room, and along the house's outside by its doors. */
  private findSconces(): void {
    for (const room of this.rooms) {
      const spots: { x: number; y: number; dx: number; dy: number }[] = [];
      for (let i = room.x0 + 1; i < room.x1; i += 4) {
        if (this.tile(i, room.y1 + 1) === Tile.Wall && this.tile(i, room.y1) === Tile.Floor) spots.push({ x: i + 0.5, y: room.y1 + 0.5, dx: 0, dy: 1 });
      }
      for (let j = room.y0 + 2; j < room.y1; j += 5) {
        if (this.tile(room.x0 - 1, j) === Tile.Wall && this.tile(room.x0, j) === Tile.Floor) spots.push({ x: room.x0 + 0.5, y: j + 0.5, dx: -1, dy: 0 });
      }
      this.sconces.push(...spots.slice(0, 3));
    }
  }
}

/**
 * Distance fields to places: how many steps every cell is from a target, walking. A monster heads downhill on the field
 * for where it's going, cutting corners wherever it can walk straight. Fields are shared by everyone going the same way,
 * and remade when they're a moment old, since the gate and the targets move.
 */
export class Paths {
  private readonly fields = new Map<number, { field: Uint16Array; at: number }>();
  private readonly queue = new Int32Array(SIZE * SIZE);

  constructor(
    private readonly manor: Manor,
    private readonly maxAgeMs = 700,
  ) {}

  /** The field to a point: 0 at its cell, 0xffff where it can't be walked to. */
  field(x: number, y: number, now: number): Uint16Array {
    const target = this.manor.nearestOpen(x, y);
    const key = Manor.index(Math.floor(target.x), Math.floor(target.y));
    const cached = this.fields.get(key);
    if (cached && now - cached.at < this.maxAgeMs) return cached.field;
    const field = cached?.field ?? new Uint16Array(SIZE * SIZE);
    this.fill(field, key);
    this.fields.delete(key);
    this.fields.set(key, { field, at: now });
    if (this.fields.size > 32) this.fields.delete(this.fields.keys().next().value!);
    return field;
  }

  /**
   * Where a body of radius `r` at (x, y) should head for next on its way to (tx, ty): the target itself if it can walk
   * straight there, or the furthest cell down the field it can walk straight to. Null if the target can't be reached.
   */
  next(x: number, y: number, tx: number, ty: number, r: number, now: number): Spot | null {
    const { manor } = this;
    if (Math.hypot(tx - x, ty - y) < 14 && manor.clearWalk(x, y, tx, ty, r)) return { x: tx, y: ty };
    const field = this.field(tx, ty, now);
    let i = Math.floor(x);
    let j = Math.floor(y);
    if (field[Manor.index(i, j)] === 0xffff) {
      // off the field (pushed into a corner, or standing in a doorway's edge): make for the nearest open cell
      const open = manor.nearestOpen(x, y);
      i = Math.floor(open.x);
      j = Math.floor(open.y);
      if (field[Manor.index(i, j)] === 0xffff) return null;
    }
    let best: Spot | null = null;
    for (let step = 0; step < 10; step++) {
      const here = field[Manor.index(i, j)];
      if (here === 0) break;
      let ni = -1;
      let nj = -1;
      let low = here;
      for (const [di, dj] of DIRS8) {
        const ci = i + di;
        const cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= SIZE || cj >= SIZE) continue;
        // no cutting a corner round a solid cell
        if (di !== 0 && dj !== 0 && (manor.solid(i + di, j) || manor.solid(i, j + dj))) continue;
        const v = field[Manor.index(ci, cj)];
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
      if (step === 0 || manor.clearWalk(x, y, cx, cy, r)) best = { x: cx, y: cy };
      else break;
    }
    return best ?? { x: tx, y: ty };
  }

  private fill(field: Uint16Array, from: number): void {
    const { manor, queue } = this;
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
        if (manor.solid(ni, nj)) continue;
        const n = nj * SIZE + ni;
        if (field[n] <= d) continue;
        field[n] = d;
        queue[tail++] = n;
      }
    }
  }
}
