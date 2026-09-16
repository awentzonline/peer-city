import type { Vec3 } from '../crossplay/math';
import { BAYS, BAY_SIZE, TOP, type Course } from './course';

/**
 * Every bay has a design shelf standing on its uphill side: a cubby per saved design with a model of it inside,
 * and a SAVE plaque above each. Use the part gun or the wrench on a plaque to save your racer there, and on a
 * model to build your racer like it, or to copy one off a friend's shelf. Saves live in the browser
 * (`DesignShelf`), and each builder carries theirs (`Builder.save0`..) so everyone sees the models.
 *
 * Here's where everything on a shelf is, the same on every peer, and how a tool's aim finds it. Headless.
 */

export const SHELF_SLOTS = 4;
/** The shelf's front, this far uphill (-x) of its bay's middle, facing down the hill toward the racer. */
const SHELF_BACK = BAY_SIZE / 2 + 1.2;
/** A cubby's width along the shelf, and the gap between their middles. */
export const SLOT_WIDTH = 1;
const SLOT_PITCH = 1.15;
/** How deep the shelf is, front to back, and how wide altogether. */
export const SHELF_DEPTH = 0.9;
export const SHELF_WIDTH = SHELF_SLOTS * SLOT_PITCH + 0.2;
/** Heights above the floor: the cubbies' floor and ceiling, and the SAVE plaques' bottom and top. */
export const CUBBY = [0.9, 1.85] as const;
export const PLAQUE = [1.95, 2.4] as const;

/** An axis-aligned box in the world. */
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export interface ShelfLayout {
  bay: number;
  /** x of the shelf's front face. */
  front: number;
  /** The middle of the shelf along y. */
  y: number;
  /** What you can't walk through. */
  solid: Box;
  /** Along the shelf, the first slot on the left as you face it. */
  slots: { y: number; save: Box; load: Box }[];
}

const layouts = new WeakMap<Course, ShelfLayout[]>();

/** The shelves, a bay's at its index. */
export function shelves(course: Course): ShelfLayout[] {
  let out = layouts.get(course);
  if (out) return out;
  out = [];
  for (let bay = 0; bay < BAYS; bay++) {
    const b = course.bay(bay);
    const front = b.x - SHELF_BACK;
    const back = front - SHELF_DEPTH;
    const slots = [];
    for (let i = 0; i < SHELF_SLOTS; i++) {
      // facing -x, +y is on your left
      const y = b.y + ((SHELF_SLOTS - 1) / 2 - i) * SLOT_PITCH;
      const across = { y0: y - SLOT_WIDTH / 2, y1: y + SLOT_WIDTH / 2 };
      slots.push({
        y,
        save: { x0: back, x1: front + 0.02, ...across, z0: TOP + PLAQUE[0], z1: TOP + PLAQUE[1] },
        load: { x0: back, x1: front, ...across, z0: TOP + CUBBY[0], z1: TOP + CUBBY[1] },
      });
    }
    const solid = { x0: back - 0.1, x1: front, y0: b.y - SHELF_WIDTH / 2, y1: b.y + SHELF_WIDTH / 2, z0: TOP, z1: TOP + 3 };
    out.push({ bay, front, y: b.y, solid, slots });
  }
  layouts.set(course, out);
  return out;
}

export const enum ShelfAction {
  Save = 0,
  Load = 1,
}

/** A tool pointed at a shelf. */
export interface ShelfHit {
  bay: number;
  slot: number;
  action: ShelfAction;
  distance: number;
}

/** The nearest SAVE plaque or cubby along a ray, within `reach`. */
export function pickShelf(course: Course, origin: Vec3, dir: Vec3, reach: number): ShelfHit | null {
  let best: ShelfHit | null = null;
  for (const shelf of shelves(course)) {
    if (Math.abs(origin.x - shelf.front) > reach + 2 || Math.abs(origin.y - shelf.y) > reach + SHELF_WIDTH) continue;
    shelf.slots.forEach((s, slot) => {
      for (const action of [ShelfAction.Save, ShelfAction.Load]) {
        const t = rayAabb(origin, dir, action === ShelfAction.Save ? s.save : s.load);
        if (t === null || t > reach || (best && t >= best.distance)) continue;
        best = { bay: shelf.bay, slot, action, distance: t };
      }
    });
  }
  return best;
}

/** How far along a ray it enters a box, or null if it misses (or starts inside). */
export function rayAabb(o: Vec3, d: Vec3, b: Box): number | null {
  let near = -Infinity;
  let far = Infinity;
  for (const [oa, da, lo, hi] of [
    [o.x, d.x, b.x0, b.x1],
    [o.y, d.y, b.y0, b.y1],
    [o.z, d.z, b.z0, b.z1],
  ]) {
    if (Math.abs(da) < 1e-9) {
      if (oa < lo || oa > hi) return null;
      continue;
    }
    let t1 = (lo - oa) / da;
    let t2 = (hi - oa) / da;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far || far < 0) return null;
  }
  return near < 0 ? null : near;
}

/** Push a body of radius `r` at `p` out of a box on the ground, along the shortest way out. */
export function pushOut(p: { x: number; y: number }, b: Box, r: number): void {
  if (p.x <= b.x0 - r || p.x >= b.x1 + r || p.y <= b.y0 - r || p.y >= b.y1 + r) return;
  const pushes = [b.x0 - r - p.x, b.x1 + r - p.x, b.y0 - r - p.y, b.y1 + r - p.y];
  const least = pushes.reduce((a, c) => (Math.abs(c) < Math.abs(a) ? c : a));
  if (least === pushes[0] || least === pushes[1]) p.x += least;
  else p.y += least;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Where a player's designs are kept between visits: their shelf, and the racer they last had. */
export interface DesignShelf {
  /** A design blob per slot, or null for an empty one. */
  slots(): (Uint8Array | null)[];
  save(slot: number, design: Uint8Array): void;
  /** The racer as it was last built, to carry on with next time. */
  current(): Uint8Array | null;
  keep(design: Uint8Array): void;
}

/** Kept only as long as the page: for tests, or when the browser won't store anything. */
export class MemoryShelf implements DesignShelf {
  protected readonly saved: (Uint8Array | null)[] = new Array(SHELF_SLOTS).fill(null);
  protected last: Uint8Array | null = null;

  slots(): (Uint8Array | null)[] {
    return [...this.saved];
  }

  save(slot: number, design: Uint8Array): void {
    this.saved[slot] = design;
  }

  current(): Uint8Array | null {
    return this.last;
  }

  keep(design: Uint8Array): void {
    this.last = design;
  }
}

const SHELF_KEY = 'peer-derby-shelf';
const CURRENT_KEY = 'peer-derby-racer';

/** In this browser's local storage, as base64: it outlives the tab, and works the same for every hill. */
export class LocalShelf extends MemoryShelf {
  constructor() {
    super();
    try {
      const list = JSON.parse(localStorage.getItem(SHELF_KEY) ?? '[]') as unknown;
      if (Array.isArray(list)) list.slice(0, SHELF_SLOTS).forEach((s, i) => (this.saved[i] = typeof s === 'string' ? fromBase64(s) : null));
      const current = localStorage.getItem(CURRENT_KEY);
      this.last = current ? fromBase64(current) : null;
    } catch {
      /* nothing stored, or storage unavailable */
    }
  }

  override save(slot: number, design: Uint8Array): void {
    super.save(slot, design);
    store(SHELF_KEY, JSON.stringify(this.saved.map((s) => (s ? toBase64(s) : null))));
  }

  override keep(design: Uint8Array): void {
    super.keep(design);
    store(CURRENT_KEY, toBase64(design));
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or unavailable: it lasts as long as the page */
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array | null {
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
