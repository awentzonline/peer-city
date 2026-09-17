/**
 * Fingers on a map, with no DOM in it: the gestures every map app has settled on, for a role that looks down on the
 * world from a touch screen. One finger drags the ground along, two pinch to zoom and twist to turn, a quick touch is a
 * tap, and a touch held still is a long press. A frontend feeds it pointer events and reads what happened once a frame,
 * as it reads `TouchInput`, then calls `endFrame`.
 */
export interface MapGestureTuning {
  /** A touch that moves less than this, in pixels, hasn't started dragging. */
  slop: number;
  /** A touch shorter than this, ms, that didn't drag, is a tap. */
  tapMs: number;
  /** A touch held still this long, ms, is a long press. */
  holdMs: number;
}

export const MAP_GESTURES: MapGestureTuning = { slop: 12, tapMs: 280, holdMs: 480 };

interface Finger {
  x: number;
  y: number;
  ox: number;
  oy: number;
  at: number;
  /** It's moved past the slop, or been part of a pinch: it's no tap. */
  moved: boolean;
  held: boolean;
}

/** One frame's worth of gestures. Screen points are CSS pixels. */
export interface MapFrame {
  /** Where one finger dragged the ground from and to, this frame. */
  drag: { fromX: number; fromY: number; toX: number; toY: number } | null;
  /** Two fingers: about their midpoint, how much further apart they are (2 = twice as far) and how far they've turned, radians clockwise. */
  pinch: { x: number; y: number; scale: number; turn: number } | null;
  /** Quick touches that let go this frame. */
  taps: { x: number; y: number }[];
  /** Touches held still long enough this frame. */
  holds: { x: number; y: number }[];
}

export class MapGestures {
  private readonly fingers = new Map<number, Finger>();
  readonly frame: MapFrame = { drag: null, pinch: null, taps: [], holds: [] };

  constructor(readonly tuning: MapGestureTuning = MAP_GESTURES) {}

  /** How many fingers are down. */
  get count(): number {
    return this.fingers.size;
  }

  /** Where the one finger down is, or null: e.g. to point at the ground under it. */
  get finger(): { x: number; y: number } | null {
    if (this.fingers.size !== 1) return null;
    const f = this.fingers.values().next().value!;
    return { x: f.x, y: f.y };
  }

  pointerDown(id: number, x: number, y: number, now: number): void {
    if (this.fingers.has(id)) this.cancel(id);
    // a second finger turns both into a pinch: neither can be a tap or a press any more
    for (const f of this.fingers.values()) f.moved = true;
    this.fingers.set(id, { x, y, ox: x, oy: y, at: now, moved: this.fingers.size > 0, held: false });
  }

  pointerMove(id: number, x: number, y: number): void {
    const f = this.fingers.get(id);
    if (!f) return;
    if (this.fingers.size === 1) {
      if (!f.moved && Math.hypot(x - f.ox, y - f.oy) > this.tuning.slop) f.moved = true;
      // until it's past the slop the ground stays put, so a tap doesn't nudge the view
      if (f.moved && !f.held) this.dragBy(f.x, f.y, x, y);
    } else if (this.fingers.size === 2) {
      this.pinchBy(id, x, y);
    }
    f.x = x;
    f.y = y;
  }

  pointerUp(id: number, now: number): void {
    const f = this.fingers.get(id);
    if (!f) return;
    this.fingers.delete(id);
    if (!f.moved && !f.held && now - f.at <= this.tuning.tapMs) this.frame.taps.push({ x: f.ox, y: f.oy });
  }

  /** A pointer went away without lifting (a system gesture): no tap. */
  cancel(id: number): void {
    this.fingers.delete(id);
  }

  clear(): void {
    this.fingers.clear();
  }

  /** Call once a frame before reading `frame`: turns touches held still into long presses. */
  update(now: number): void {
    if (this.fingers.size !== 1) return;
    const f = this.fingers.values().next().value!;
    if (!f.moved && !f.held && now - f.at >= this.tuning.holdMs) {
      f.held = true;
      this.frame.holds.push({ x: f.ox, y: f.oy });
    }
  }

  endFrame(): void {
    const fr = this.frame;
    fr.drag = fr.pinch = null;
    fr.taps.length = fr.holds.length = 0;
  }

  private dragBy(fromX: number, fromY: number, toX: number, toY: number): void {
    const d = this.frame.drag;
    if (d) {
      d.toX = toX;
      d.toY = toY;
    } else {
      this.frame.drag = { fromX, fromY, toX, toY };
    }
  }

  private pinchBy(id: number, x: number, y: number): void {
    let other: Finger | null = null;
    for (const [fid, f] of this.fingers) if (fid !== id) other = f;
    const f = this.fingers.get(id)!;
    if (!other) return;
    const before = Math.hypot(f.x - other.x, f.y - other.y);
    const after = Math.hypot(x - other.x, y - other.y);
    const turn = angleBetween(Math.atan2(y - other.y, x - other.x), Math.atan2(f.y - other.y, f.x - other.x));
    const p = (this.frame.pinch ??= { x: 0, y: 0, scale: 1, turn: 0 });
    p.x = (x + other.x) / 2;
    p.y = (y + other.y) / 2;
    if (before > 1 && after > 1) p.scale *= after / before;
    p.turn += turn;
    // the midpoint moving drags the map too
    const mx = (f.x + other.x) / 2;
    const my = (f.y + other.y) / 2;
    this.dragBy(mx, my, p.x, p.y);
  }
}

/** `to` minus `from`, wrapped to -π..π. */
function angleBetween(to: number, from: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
