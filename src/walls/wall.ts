import type { Vec3 } from '../crossplay/math';

/**
 * The paint on a wall, as pixels, with no DOM or WebGL in it. Every peer paints the same strokes with the same
 * integer arithmetic and the same seeded speckle, so walls agree pixel for pixel wherever strokes arrive in the
 * same order (and near enough where two painters cross at the same moment). A wall is drawn in tiles, so the
 * views only upload the parts that changed, and a snapshot only has to carry the parts anyone has painted.
 */

/** Pixels per meter of wall. */
export const PX_PER_M = 64;
/** A wall's pixels come in square tiles this many pixels across (the last row and column may be smaller). */
export const TILE = 128;

/** Where a wall stands. Meters, world axes: x, y on the ground, z up. */
export interface SurfaceSpec {
  name: string;
  /** The middle of its bottom edge. */
  x: number;
  y: number;
  z: number;
  /** The way its painted face faces: horizontal, unit length. */
  nx: number;
  ny: number;
  width: number;
  height: number;
  /** The bare wall: 'block' for cinder blocks and mortar, 'board' for smooth plywood. */
  finish: 'block' | 'board';
  base: number;
}

export const enum Brush {
  /** Soft and speckled, wider and fainter from further away, and it builds up the longer you hold it on a spot. */
  Spray = 0,
  /** A hard, round line of ink. */
  Marker = 1,
  /** A broad, flat band of paint, streaky at the edges. */
  Roller = 2,
}

/** A point along a stroke, in the wall's pixels (x right, y up from the bottom), with the brush's radius and strength there. */
export interface StrokePoint {
  x: number;
  y: number;
  /** Radius, px. */
  r: number;
  /** 0..1. For spray, how much paint arrived at this point since the last one; otherwise opacity. */
  a: number;
}

/** Where a ray meets a wall's face. */
export interface WallHit {
  surface: number;
  distance: number;
  /** Pixels. */
  px: number;
  py: number;
}

export class Surface {
  readonly w: number;
  readonly h: number;
  readonly tilesX: number;
  readonly tilesY: number;
  /** RGBA, rows bottom up (as a texture wants them). Alpha is always 255. */
  readonly data: Uint8Array;
  /** Tiles changed since the views last looked (`takeDirty`). */
  private readonly dirty: Uint8Array;
  /** Tiles that aren't bare wall any more: what a snapshot has to send. */
  readonly painted: Uint8Array;
  /** Which way is right along the face, seen from in front of it. */
  readonly ux: number;
  readonly uy: number;
  /** The bottom left corner, seen from in front. */
  readonly ox: number;
  readonly oy: number;

  constructor(
    readonly index: number,
    readonly spec: SurfaceSpec,
  ) {
    this.w = Math.round(spec.width * PX_PER_M);
    this.h = Math.round(spec.height * PX_PER_M);
    this.tilesX = Math.ceil(this.w / TILE);
    this.tilesY = Math.ceil(this.h / TILE);
    this.data = new Uint8Array(this.w * this.h * 4);
    this.dirty = new Uint8Array(this.tilesX * this.tilesY);
    this.painted = new Uint8Array(this.tilesX * this.tilesY);
    // facing along -n, right is (-f.y, f.x) in world axes (see crossplay/avatar.ts's strafe)
    this.ux = spec.ny;
    this.uy = -spec.nx;
    this.ox = spec.x - (this.ux * spec.width) / 2;
    this.oy = spec.y - (this.uy * spec.width) / 2;
    this.clear();
  }

  get tileCount(): number {
    return this.tilesX * this.tilesY;
  }

  /** Back to bare wall. */
  clear(): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.bare(x, y);
    this.dirty.fill(1);
    this.painted.fill(0);
  }

  /** Paint one pixel as the bare wall. */
  private bare(x: number, y: number): void {
    const { spec, data } = this;
    const i = (y * this.w + x) * 4;
    const n = (hash(x, y, this.index * 7919 + 13) & 31) - 16;
    let shade = n / 3;
    if (spec.finish === 'block') {
      // 40 × 20 cm blocks, every other course offset by half a block
      const course = Math.floor(y / 13);
      const bx = (x + (course % 2) * 13) % 26;
      if (y % 13 === 0 || bx === 0) shade -= 26;
    } else {
      // plywood grain: long faint streaks
      shade += ((hash(0, y >> 1, this.index) & 15) - 8) / 2;
    }
    data[i] = clampByte(((spec.base >> 16) & 255) + shade);
    data[i + 1] = clampByte(((spec.base >> 8) & 255) + shade);
    data[i + 2] = clampByte((spec.base & 255) + shade);
    data[i + 3] = 255;
  }

  /** The dirty tiles since the last call, cleared. */
  takeDirty(out: number[] = []): number[] {
    out.length = 0;
    const d = this.dirty;
    for (let i = 0; i < d.length; i++) {
      if (!d[i]) continue;
      d[i] = 0;
      out.push(i);
    }
    return out;
  }

  /** A tile's pixel rectangle. */
  tileRect(tile: number): { x: number; y: number; w: number; h: number } {
    const tx = tile % this.tilesX;
    const ty = Math.floor(tile / this.tilesX);
    const x = tx * TILE;
    const y = ty * TILE;
    return { x, y, w: Math.min(TILE, this.w - x), h: Math.min(TILE, this.h - y) };
  }

  /** A tile's pixels as RGB, for a snapshot. */
  readTile(tile: number): Uint8Array {
    const r = this.tileRect(tile);
    const out = new Uint8Array(r.w * r.h * 3);
    let o = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      let i = (y * this.w + r.x) * 4;
      for (let x = 0; x < r.w; x++, i += 4) {
        out[o++] = this.data[i];
        out[o++] = this.data[i + 1];
        out[o++] = this.data[i + 2];
      }
    }
    return out;
  }

  /** Put a tile's pixels back from `readTile`. Ignores the wrong size, which only a mismatched build would send. */
  writeTile(tile: number, rgb: Uint8Array): boolean {
    if (tile < 0 || tile >= this.tileCount) return false;
    const r = this.tileRect(tile);
    if (rgb.length !== r.w * r.h * 3) return false;
    let o = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      let i = (y * this.w + r.x) * 4;
      for (let x = 0; x < r.w; x++, i += 4) {
        this.data[i] = rgb[o++];
        this.data[i + 1] = rgb[o++];
        this.data[i + 2] = rgb[o++];
        this.data[i + 3] = 255;
      }
    }
    this.dirty[tile] = 1;
    this.painted[tile] = 1;
    return true;
  }

  /** The colour of a pixel, 0xRRGGBB (tests and the eyedropper). */
  pixel(x: number, y: number): number {
    const i = (Math.floor(y) * this.w + Math.floor(x)) * 4;
    return (this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2];
  }

  /** Where a ray meets the painted face, from in front, within `reach` meters. */
  hit(origin: Vec3, dir: Vec3, reach: number): WallHit | null {
    const { spec } = this;
    const facing = dir.x * spec.nx + dir.y * spec.ny;
    if (facing >= -1e-6) return null;
    const dist = ((origin.x - spec.x) * spec.nx + (origin.y - spec.y) * spec.ny) / -facing;
    if (dist < -0.05 || dist > reach) return null;
    const hx = origin.x + dir.x * dist;
    const hy = origin.y + dir.y * dist;
    const hz = origin.z + dir.z * dist;
    const along = (hx - this.ox) * this.ux + (hy - this.oy) * this.uy;
    const up = hz - spec.z;
    if (along < 0 || along > spec.width || up < 0 || up > spec.height) return null;
    return { surface: this.index, distance: Math.max(0, dist), px: along * PX_PER_M, py: up * PX_PER_M };
  }

  /** A point on the wall's pixels, in the world, lifted `lift` meters off its face. */
  toWorld(px: number, py: number, lift: number, out: Vec3): Vec3 {
    const along = px / PX_PER_M;
    out.x = this.ox + this.ux * along + this.spec.nx * lift;
    out.y = this.oy + this.uy * along + this.spec.ny * lift;
    out.z = this.spec.z + py / PX_PER_M;
    return out;
  }

  /**
   * Paint a stroke. `pts[0]` is where it starts: stamped here unless `cont`, when the stroke carries on from a
   * batch that already stamped it. `seed` makes the speckle, so it must be the same on every peer.
   */
  stroke(brush: Brush, rgb: number, pts: readonly StrokePoint[], cont: boolean, seed: number): void {
    if (!pts.length) return;
    let n = 0;
    if (!cont) this.stamp(brush, rgb, pts[0].x, pts[0].y, pts[0].r, pts[0].a, seed + n++);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const r = Math.max(0.5, Math.min(a.r, b.r));
      const steps = Math.max(1, Math.ceil(len / (r * SPACING[brush])));
      for (let s = 1; s <= steps; s++) {
        const k = s / steps;
        const alpha = a.a + (b.a - a.a) * k;
        // Spray is paint over time: a fast stroke spreads what came out thinly along its length.
        this.stamp(brush, rgb, a.x + dx * k, a.y + dy * k, a.r + (b.r - a.r) * k, brush === Brush.Spray ? alpha / steps : alpha, seed + n++);
      }
    }
  }

  private stamp(brush: Brush, rgb: number, cx: number, cy: number, r: number, a: number, seed: number): void {
    if (a <= 0 || r <= 0) return;
    const reachX = brush === Brush.Roller ? r : r + 1;
    const reachY = brush === Brush.Roller ? r * ROLLER_ASPECT : r + 1;
    const x0 = Math.max(0, Math.floor(cx - reachX));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + reachX));
    const y0 = Math.max(0, Math.floor(cy - reachY));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + reachY));
    if (x0 > x1 || y0 > y1) return;
    const R = (rgb >> 16) & 255;
    const G = (rgb >> 8) & 255;
    const B = rgb & 255;
    const data = this.data;
    const inv = 1 / (r * r);
    const s = seed | 0;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      let i = (y * this.w + x0) * 4;
      for (let x = x0; x <= x1; x++, i += 4) {
        const dx = x + 0.5 - cx;
        let alpha: number;
        const h = hash(x, y, s);
        if (brush === Brush.Spray) {
          const d2 = (dx * dx + dy * dy) * inv;
          if (d2 >= 1) continue;
          const f = 1 - d2;
          // a soft core, and speckle that's all there is towards the edge
          const speck = (h & 255) / 255;
          alpha = a * f * f * (0.25 + 1.5 * speck * speck);
        } else if (brush === Brush.Marker) {
          const d2 = dx * dx + dy * dy;
          const edge = r + 0.5 - Math.sqrt(d2);
          if (edge <= 0) continue;
          alpha = a * (edge >= 1 ? 1 : edge);
        } else {
          if (Math.abs(dy) > r * ROLLER_ASPECT) continue;
          const nap = (hash(x, 0, 977) & 63) / 63; // streaks along the roll
          alpha = a * (0.8 + 0.2 * nap);
        }
        if (alpha > 1) alpha = 1;
        // dithered, so faint paint still builds up all the way instead of stalling short of its colour
        const dither = ((h >>> 8) & 255) / 256;
        data[i] += Math.floor((R - data[i]) * alpha + dither);
        data[i + 1] += Math.floor((G - data[i + 1]) * alpha + dither);
        data[i + 2] += Math.floor((B - data[i + 2]) * alpha + dither);
      }
    }
    // everything the stamp touched
    const tx0 = Math.floor(x0 / TILE);
    const tx1 = Math.floor(x1 / TILE);
    const ty0 = Math.floor(y0 / TILE);
    const ty1 = Math.floor(y1 / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = ty * this.tilesX + tx;
        this.dirty[t] = 1;
        this.painted[t] = 1;
      }
    }
  }
}

/** Stamps along a stroke, as a fraction of the radius apart. */
const SPACING: Record<Brush, number> = [0.3, 0.25, 0.2];
/** A roller stamps a flat rectangle: its half-height is this fraction of its half-width. */
const ROLLER_ASPECT = 0.45;

/** A small integer hash of a pixel and a seed, for speckle and dithering. */
export function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// ---------------------------------------------------------------------------
// Strokes on the wire
// ---------------------------------------------------------------------------

/** Bytes per point: x and y in quarter pixels, the radius in half pixels, and the strength. */
export const POINT_BYTES = 6;
/** Most points in one `Paint` action. A painter sends a batch every network tick, so this is plenty. */
export const MAX_POINTS = 64;

export function encodePoints(pts: readonly StrokePoint[]): Uint8Array {
  const n = Math.min(pts.length, MAX_POINTS);
  const out = new Uint8Array(n * POINT_BYTES);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const o = i * POINT_BYTES;
    const x = clampInt(Math.round(p.x * 4), 0xffff);
    const y = clampInt(Math.round(p.y * 4), 0xffff);
    out[o] = x & 255;
    out[o + 1] = x >> 8;
    out[o + 2] = y & 255;
    out[o + 3] = y >> 8;
    out[o + 4] = clampInt(Math.round(p.r * 2), 255);
    out[o + 5] = clampInt(Math.round(p.a * 255), 255);
  }
  return out;
}

export function decodePoints(bytes: Uint8Array): StrokePoint[] {
  const pts: StrokePoint[] = [];
  for (let o = 0; o + POINT_BYTES <= bytes.length; o += POINT_BYTES) {
    pts.push({
      x: (bytes[o] | (bytes[o + 1] << 8)) / 4,
      y: (bytes[o + 2] | (bytes[o + 3] << 8)) / 4,
      r: bytes[o + 4] / 2,
      a: bytes[o + 5] / 255,
    });
  }
  return pts;
}

function clampInt(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/** A point exactly as it will arrive after `encodePoints`, so the painter paints what everyone else will. */
export function quantizePoint(p: StrokePoint): StrokePoint {
  p.x = clampInt(Math.round(p.x * 4), 0xffff) / 4;
  p.y = clampInt(Math.round(p.y * 4), 0xffff) / 4;
  p.r = clampInt(Math.round(p.r * 2), 255) / 2;
  p.a = clampInt(Math.round(p.a * 255), 255) / 255;
  return p;
}
