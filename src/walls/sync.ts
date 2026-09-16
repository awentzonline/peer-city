import { ByteReader, ByteWriter, fnv1a, type NetEntity, type NetWorld, type StateOf } from '@engine/index';
import { Paint, Painter, WallAsk, WallDone, WallTile } from './defs';
import { decodePoints, encodePoints, quantizePoint, type Brush, type Surface, type StrokePoint } from './wall';

export type PainterEntity = NetEntity<StateOf<typeof Painter>>;

/**
 * Keeping everyone's walls the same, with no server to hold them.
 *
 * Paint is strokes, sent to everyone and painted by everyone. That's enough while you're there, but someone
 * arriving has missed everything before, so they ask a painter who has the walls for a copy. Painting doesn't
 * stop while it comes: the copy is taken at one moment, with the number of each painter's last stroke in it,
 * and the newcomer keeps every stroke that arrives meanwhile. With the copy in, they paint the ones it didn't
 * have, and from then on they're the same as everyone else.
 *
 * A copy of the walls has an id (`Painter.wall`) and a birth time. The first painter in an empty yard starts one
 * (from what they saved last time, if anything). If two groups that each started their own meet, the older copy
 * wins and the younger group takes a copy of it: walls converge on one, rather than splitting forever.
 */
export interface SyncHost {
  world: NetWorld;
  surfaces: readonly Surface[];
  me(): PainterEntity | null;
  /** performance.now()-like ms, for timeouts. */
  now(): number;
  /** Wall-clock seconds, for birth times: those are compared between peers. */
  wallClock(): number;
  message(text: string): void;
  /** Walls this browser kept from last time, to start a new copy from when there's nobody else here. */
  saved(): SavedTile[] | null;
}

/** A painted tile's RGB pixels (see `Surface.readTile`). */
export interface SavedTile {
  surface: number;
  tile: number;
  data: Uint8Array;
}

interface Stroke {
  author: string;
  surface: number;
  brush: Brush;
  color: number;
  seq: number;
  cont: boolean;
  pts: StrokePoint[];
}

interface Asking {
  req: number;
  from: string;
  name: string;
  /** Tiles as they come in, inflating. */
  tiles: Promise<SavedTile | null>[];
  /** When anything last came from them. */
  heard: number;
  done: boolean;
}

export interface SyncTuning {
  /** How long to look for someone with the walls before starting your own copy, ms. Online connections take a while. */
  settleMs: number;
  /** Give up on a copy that's stopped coming after this long, and ask again, ms. */
  staleMs: number;
}

export const SYNC_TUNING: SyncTuning = { settleMs: 5000, staleMs: 10000 };

/** Strokes kept while waiting for a copy. A long wait on a busy wall drops the oldest. */
const MAX_BUFFER = 50_000;

export class WallSync {
  /** Bumped whenever the walls change, for autosaving. */
  version = 0;
  private seq = 0;
  /** The last stroke of each painter's that's on our walls. */
  private seen = new Map<string, number>();
  /** Strokes that arrived while we had no copy, to paint again on top of the one that comes. */
  private buffer: Stroke[] = [];
  private asking: Asking | null = null;
  private readonly startedAt: number;
  private readonly selfId: string;

  constructor(
    private readonly host: SyncHost,
    private readonly tuning: SyncTuning = SYNC_TUNING,
  ) {
    const { world } = host;
    this.selfId = world.selfId;
    this.startedAt = host.now();

    world.onAction(Paint, (p, from) => {
      if (from.local) return;
      this.receive({ author: from.from, surface: p.surface, brush: p.brush as Brush, color: p.color, seq: p.seq, cont: p.cont, pts: decodePoints(p.pts) });
    });

    world.onAction(WallAsk, (p, from) => {
      if (from.local || !this.synced) return;
      void this.serve(from.from, p.req);
    });

    world.onAction(WallTile, (p, from) => {
      const a = this.asking;
      if (!a || a.req !== p.req || a.from !== from.from) return;
      a.heard = host.now();
      a.tiles.push(inflate(p.data).then((data) => ({ surface: p.surface, tile: p.tile, data }), () => null));
    });

    world.onAction(WallDone, (p, from) => {
      const a = this.asking;
      if (!a || a.req !== p.req || a.from !== from.from) return;
      a.heard = host.now();
      a.done = true;
      void this.adopt(a, p.wall, p.born, decodeSeen(p.seen), p.tiles);
    });
  }

  /** Whether we have a copy of the walls, rather than waiting for one. */
  get synced(): boolean {
    return (this.host.me()?.state.wall ?? 0) !== 0;
  }

  /** Waiting for a copy from someone, and who. */
  get fetching(): string | null {
    return this.asking?.name ?? null;
  }

  /** Paint a stroke of our own: onto our walls now, and out to everyone. Its points are rounded (in place) to what everyone else will get. */
  paint(surface: number, brush: Brush, color: number, pts: StrokePoint[], cont: boolean): void {
    for (const p of pts) quantizePoint(p);
    const stroke: Stroke = { author: this.selfId, surface, brush, color, seq: ++this.seq, cont, pts };
    this.apply(stroke);
    if (!this.synced) this.keep(stroke);
    this.host.world.send(Paint, { surface, brush, color, seq: stroke.seq, cont, pts: encodePoints(pts) }, { to: 'all', self: false });
  }

  update(): void {
    const me = this.host.me();
    if (!me) return;
    const now = this.host.now();
    const a = this.asking;
    if (a && now - a.heard > this.tuning.staleMs) {
      this.asking = null;
      this.host.message(`${a.name}'s walls stopped coming: asking again`);
    }
    if (this.asking) return;

    const oldest = this.oldestOther();
    if (!this.synced) {
      if (oldest) this.ask(oldest);
      else if (now - this.startedAt >= this.tuning.settleMs) this.found();
      return;
    }
    // Two groups that each started their own walls have met: the older walls win.
    const s = me.state;
    if (oldest && older(oldest.state, s)) {
      this.host.message(`Found ${oldest.state.name}'s walls, which were here first: switching to those`);
      s.wall = 0;
      s.born = 0;
      this.buffer = [];
      this.ask(oldest);
    }
  }

  /** The painter elsewhere with the oldest walls, if anyone has any. */
  private oldestOther(): PainterEntity | null {
    let best: PainterEntity | null = null;
    for (const p of this.host.world.all(Painter)) {
      if (p.mine || !p.state.wall) continue;
      if (!best || older(p.state, best.state)) best = p;
    }
    return best;
  }

  private ask(from: PainterEntity): void {
    const req = (Math.random() * 0xffffffff) >>> 0 || 1;
    this.asking = { req, from: from.owner, name: from.state.name || 'someone', tiles: [], heard: this.host.now(), done: false };
    this.host.world.send(WallAsk, { req }, { to: 'peer', peer: from.owner });
  }

  /** Nobody else has walls: start a copy, from what this browser saved if anything. */
  private found(): void {
    const me = this.host.me()!;
    const saved = this.host.saved();
    if (saved?.length) {
      for (const s of this.host.surfaces) s.clear();
      for (const t of saved) this.host.surfaces[t.surface]?.writeTile(t.tile, t.data);
      // what's been painted since arriving goes on top
      for (const stroke of this.buffer) this.apply(stroke);
      this.version++;
    }
    this.buffer = [];
    me.state.wall = (Math.random() * 0xffffffff) >>> 0 || 1;
    me.state.born = Math.floor(this.host.wallClock());
  }

  /** A copy has all come in: put it up, and paint what it hadn't seen on top. */
  private async adopt(a: Asking, wall: number, born: number, seen: Map<string, number>, count: number): Promise<void> {
    const tiles = await Promise.all(a.tiles);
    if (this.asking !== a) return;
    this.asking = null;
    const me = this.host.me();
    if (!me || !wall) return;
    if (tiles.length !== count || tiles.some((t) => !t)) {
      this.host.message(`${a.name}'s walls didn't all arrive: asking again`);
      return;
    }
    const { surfaces } = this.host;
    for (const s of surfaces) s.clear();
    for (const t of tiles) surfaces[t!.surface]?.writeTile(t!.tile, t!.data);
    this.seen = seen;
    const late = this.buffer;
    this.buffer = [];
    for (const stroke of late) if (stroke.seq > (seen.get(stroke.author) ?? 0)) this.apply(stroke);
    // our own count carries on from wherever it's got to
    me.state.wall = wall;
    me.state.born = born;
    this.version++;
  }

  /** Someone wants our walls: take a copy of them as they are right now, then send it. */
  private async serve(peer: string, req: number): Promise<void> {
    const me = this.host.me();
    if (!me) return;
    const { wall, born } = me.state;
    const seen = encodeSeen(this.seen);
    const tiles = capture(this.host.surfaces);
    const { world } = this.host;
    for (const t of tiles) {
      const data = await deflate(t.data);
      world.send(WallTile, { req, surface: t.surface, tile: t.tile, data }, { to: 'peer', peer });
    }
    world.send(WallDone, { req, wall, born, seen, tiles: tiles.length }, { to: 'peer', peer });
  }

  private receive(stroke: Stroke): void {
    if (!this.synced) this.keep(stroke);
    this.apply(stroke);
  }

  private keep(stroke: Stroke): void {
    this.buffer.push(stroke);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
  }

  private apply(stroke: Stroke): void {
    const surface = this.host.surfaces[stroke.surface];
    if (!surface) return;
    surface.stroke(stroke.brush, stroke.color, stroke.pts, stroke.cont, strokeSeed(stroke.author, stroke.seq));
    if (stroke.seq > (this.seen.get(stroke.author) ?? 0)) this.seen.set(stroke.author, stroke.seq);
    this.version++;
  }
}

/** Whether one painter's walls are older than another's (earlier born, then lower id). */
function older(a: { wall: number; born: number }, b: { wall: number; born: number }): boolean {
  return a.born < b.born || (a.born === b.born && a.wall < b.wall);
}

/** The speckle seed for a stroke: the same on every peer. */
export function strokeSeed(author: string, seq: number): number {
  return (fnv1a(author) + Math.imul(seq, 7919)) | 0;
}

/** Every painted tile's pixels, as RGB, right now. */
export function capture(surfaces: readonly Surface[]): SavedTile[] {
  const out: SavedTile[] = [];
  for (const s of surfaces) {
    for (let tile = 0; tile < s.tileCount; tile++) if (s.painted[tile]) out.push({ surface: s.index, tile, data: s.readTile(tile) });
  }
  return out;
}

export function encodeSeen(seen: Map<string, number>): Uint8Array {
  const w = new ByteWriter(256);
  w.varuint(seen.size);
  for (const [peer, seq] of seen) w.string(peer).varuint(seq);
  return w.finish();
}

export function decodeSeen(bytes: Uint8Array): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const r = new ByteReader(bytes);
    const n = r.varuint();
    for (let i = 0; i < n; i++) out.set(r.string(), r.varuint());
  } catch {
    /* truncated: we'll repaint a few strokes twice, which is only a little more paint */
  }
  return out;
}

export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('deflate'));
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('deflate'));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
