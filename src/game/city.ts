import { mulberry32 } from '@engine/index';

export const TILE = 32;

export const enum Tile {
  Grass = 0,
  Road = 1,
  LineH = 2,
  LineV = 3,
  CrossH = 4,
  CrossV = 5,
  Sidewalk = 6,
  Concrete = 7,
  Parking = 8,
  Water = 9,
  Path = 10,
  Tree = 11,
  Junction = 12,
  Shadow = 13,
  Sand = 14,
}

export const ROOF_BASE = 20;
export const ROOF_COLORS = 6;
export const TILESET_COLS = 10;
export const TILESET_ROWS = 8;

/** Directions: 0 east, 1 south, 2 west, 3 north. */
export const DIR_X = [1, 0, -1, 0];
export const DIR_Y = [0, 1, 0, -1];

export interface Spot {
  x: number;
  y: number;
  angle: number;
}

export interface LaneSpot {
  x: number;
  y: number;
  dir: number;
  ri: number;
  ni: number;
}

/**
 * Procedural city. Generated from a seed, so every peer builds the identical
 * map locally and no map data ever crosses the network.
 */
export class City {
  readonly w: number;
  readonly h: number;
  readonly ground: number[][];
  readonly shadows: number[][];
  readonly solid: Uint8Array;
  readonly walkable: Uint8Array;
  readonly vRoads: number[] = [];
  readonly hRoads: number[] = [];
  readonly parking: Spot[] = [];

  constructor(
    readonly seed = 1337,
    size = 256,
  ) {
    this.w = this.h = size;
    const rng = mulberry32(seed);
    const { w, h } = this;
    this.ground = Array.from({ length: h }, () => new Array(w).fill(Tile.Grass));
    this.shadows = Array.from({ length: h }, () => new Array(w).fill(-1));
    this.solid = new Uint8Array(w * h);
    this.walkable = new Uint8Array(w * h);

    const border = 5;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.min(x, y, w - 1 - x, h - 1 - y);
        if (d < border) this.set(x, y, Tile.Water);
        else if (d < border + 2) this.set(x, y, Tile.Sand);
      }
    }

    const margin = border + 6;
    for (let p = margin; p + 4 < w - margin; p += 4 + 13 + Math.floor(rng() * 8)) this.vRoads.push(p);
    for (let p = margin; p + 4 < h - margin; p += 4 + 13 + Math.floor(rng() * 8)) this.hRoads.push(p);

    const gx0 = this.vRoads[0];
    const gx1 = this.vRoads[this.vRoads.length - 1] + 3;
    const gy0 = this.hRoads[0];
    const gy1 = this.hRoads[this.hRoads.length - 1] + 3;

    // sidewalk apron around the whole grid
    this.fill(gx0 - 1, gy0 - 1, gx1 - gx0 + 3, gy1 - gy0 + 3, Tile.Sidewalk);

    for (const r of this.hRoads) {
      this.fill(gx0, r, gx1 - gx0 + 1, 4, Tile.Road);
      for (let x = gx0; x <= gx1; x++) this.set(x, r + 1, Tile.LineH);
    }
    for (const c of this.vRoads) {
      this.fill(c, gy0, 4, gy1 - gy0 + 1, Tile.Road);
      for (let y = gy0; y <= gy1; y++) this.set(c + 1, y, Tile.LineV);
    }
    for (const c of this.vRoads) {
      for (const r of this.hRoads) {
        this.fill(c, r, 4, 4, Tile.Junction);
        for (let k = 0; k < 4; k++) {
          if (c - 1 >= gx0) this.set(c - 1, r + k, Tile.CrossV);
          if (c + 4 <= gx1) this.set(c + 4, r + k, Tile.CrossV);
          if (r - 1 >= gy0) this.set(c + k, r - 1, Tile.CrossH);
          if (r + 4 <= gy1) this.set(c + k, r + 4, Tile.CrossH);
        }
      }
    }

    // blocks
    for (let i = 0; i + 1 < this.vRoads.length; i++) {
      for (let j = 0; j + 1 < this.hRoads.length; j++) {
        const x0 = this.vRoads[i] + 4;
        const x1 = this.vRoads[i + 1] - 1;
        const y0 = this.hRoads[j] + 4;
        const y1 = this.hRoads[j + 1] - 1;
        this.fill(x0, y0, x1 - x0 + 1, y1 - y0 + 1, Tile.Sidewalk);
        this.buildBlock(x0 + 1, y0 + 1, x1 - x0 - 1, y1 - y0 - 1, rng);
      }
    }

    // parkland outside the grid with scattered trees
    for (let y = border + 2; y < h - border - 2; y++) {
      for (let x = border + 2; x < w - border - 2; x++) {
        if (this.ground[y][x] === Tile.Grass && rng() < 0.06) this.set(x, y, Tile.Tree);
      }
    }
  }

  get pixelWidth(): number {
    return this.w * TILE;
  }

  get pixelHeight(): number {
    return this.h * TILE;
  }

  private set(x: number, y: number, tile: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.ground[y][x] = tile;
    const i = y * this.w + x;
    const isRoof = tile >= ROOF_BASE;
    this.solid[i] = isRoof || tile === Tile.Water || tile === Tile.Tree ? 1 : 0;
    this.walkable[i] =
      tile === Tile.Sidewalk || tile === Tile.CrossH || tile === Tile.CrossV || tile === Tile.Path || tile === Tile.Concrete || tile === Tile.Parking
        ? 1
        : 0;
  }

  private fill(x: number, y: number, w: number, h: number, tile: number): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, tile);
  }

  private buildBlock(x: number, y: number, w: number, h: number, rng: () => number): void {
    if (w < 3 || h < 3) return;
    const roll = rng();
    if (roll < 0.12) {
      this.fill(x, y, w, h, Tile.Grass);
      const my = y + Math.floor(h / 2);
      const mx = x + Math.floor(w / 2);
      for (let xx = x; xx < x + w; xx++) this.set(xx, my, Tile.Path);
      for (let yy = y; yy < y + h; yy++) this.set(mx, yy, Tile.Path);
      for (let yy = y + 1; yy < y + h - 1; yy++) {
        for (let xx = x + 1; xx < x + w - 1; xx++) {
          if (this.ground[yy][xx] === Tile.Grass && rng() < 0.18) this.set(xx, yy, Tile.Tree);
        }
      }
      return;
    }
    if (roll < 0.24) {
      this.fill(x, y, w, h, Tile.Concrete);
      for (let yy = y + 1; yy < y + h - 1; yy += 3) {
        for (let xx = x + 1; xx < x + w - 1; xx += 2) {
          this.set(xx, yy, Tile.Parking);
          if (rng() < 0.3) this.parking.push({ x: (xx + 0.5) * TILE, y: (yy + 1) * TILE, angle: Math.PI / 2 });
        }
      }
      return;
    }
    this.fill(x, y, w, h, Tile.Concrete);
    this.subdivide(x, y, w, h, rng);
  }

  private subdivide(x: number, y: number, w: number, h: number, rng: () => number): void {
    const maxSide = 9;
    if ((w > maxSide || h > maxSide) && (w >= 7 || h >= 7)) {
      if (w >= h) {
        const cut = 3 + Math.floor(rng() * (w - 6));
        this.subdivide(x, y, cut, h, rng);
        this.subdivide(x + cut + 1, y, w - cut - 1, h, rng);
      } else {
        const cut = 3 + Math.floor(rng() * (h - 6));
        this.subdivide(x, y, w, cut, rng);
        this.subdivide(x, y + cut + 1, w, h - cut - 1, rng);
      }
      return;
    }
    if (w < 2 || h < 2) return;
    const color = Math.floor(rng() * ROOF_COLORS);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const row = yy === 0 ? 0 : yy === h - 1 ? 2 : 1;
        const col = xx === 0 ? 0 : xx === w - 1 ? 2 : 1;
        this.set(x + xx, y + yy, ROOF_BASE + color * 9 + row * 3 + col);
      }
    }
    // drop shadow one tile down/right
    for (let xx = 1; xx <= w; xx++) this.shadow(x + xx, y + h);
    for (let yy = 1; yy < h; yy++) this.shadow(x + w, y + yy);
  }

  private shadow(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (this.ground[y][x] < ROOF_BASE) this.shadows[y][x] = Tile.Shadow;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  tileAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return Tile.Water;
    return this.ground[ty][tx];
  }

  isSolidTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return true;
    return this.solid[ty * this.w + tx] === 1;
  }

  isSolidAt(px: number, py: number): boolean {
    return this.isSolidTile(Math.floor(px / TILE), Math.floor(py / TILE));
  }

  isWalkableTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    return this.walkable[ty * this.w + tx] === 1;
  }

  isRoadAt(px: number, py: number): boolean {
    const t = this.tileAt(Math.floor(px / TILE), Math.floor(py / TILE));
    return t === Tile.Road || t === Tile.LineH || t === Tile.LineV || t === Tile.Junction || t === Tile.CrossH || t === Tile.CrossV;
  }

  /** Circle overlaps any solid tile? */
  circleBlocked(px: number, py: number, r: number): boolean {
    const x0 = Math.floor((px - r) / TILE);
    const x1 = Math.floor((px + r) / TILE);
    const y0 = Math.floor((py - r) / TILE);
    const y1 = Math.floor((py + r) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.isSolidTile(tx, ty)) continue;
        const nx = Math.max(tx * TILE, Math.min(px, (tx + 1) * TILE));
        const ny = Math.max(ty * TILE, Math.min(py, (ty + 1) * TILE));
        if ((px - nx) ** 2 + (py - ny) ** 2 < r * r) return true;
      }
    }
    return false;
  }

  /** Distance to the first solid tile along a ray (stepped). */
  raycast(x: number, y: number, angle: number, maxDist: number): number {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const step = 6;
    for (let d = 0; d < maxDist; d += step) {
      if (this.isSolidAt(x + dx * d, y + dy * d)) return d;
    }
    return maxDist;
  }

  /** Lane centre line coordinate for travel direction `dir` on road `ri`. */
  laneCoord(dir: number, ri: number): number {
    switch (dir) {
      case 0:
        return (this.hRoads[ri] + 3) * TILE; // eastbound: south half
      case 2:
        return (this.hRoads[ri] + 1) * TILE; // westbound: north half
      case 1:
        return (this.vRoads[ri] + 1) * TILE; // southbound: west half
      default:
        return (this.vRoads[ri] + 3) * TILE; // northbound: east half
    }
  }

  /** Roads crossing a road travelling in `dir`. */
  crossRoads(dir: number): number[] {
    return dir % 2 === 0 ? this.vRoads : this.hRoads;
  }

  roadsFor(dir: number): number[] {
    return dir % 2 === 0 ? this.hRoads : this.vRoads;
  }

  /** Index of the next intersection ahead of `along` when travelling in `dir`, or -1. */
  nextIntersection(dir: number, along: number): number {
    const cross = this.crossRoads(dir);
    if (dir === 0 || dir === 1) {
      for (let i = 0; i < cross.length; i++) if ((cross[i] + 2) * TILE > along) return i;
      return -1;
    }
    for (let i = cross.length - 1; i >= 0; i--) if ((cross[i] + 2) * TILE < along) return i;
    return -1;
  }

  /** Exit directions available at intersection `ni` for a car on road `ri` heading `dir`. */
  exits(dir: number, ri: number, ni: number): number[] {
    const out: number[] = [];
    const cross = this.crossRoads(dir);
    const roads = this.roadsFor(dir);
    const forward = dir === 0 || dir === 1 ? ni < cross.length - 1 : ni > 0;
    if (forward) out.push(dir);
    const right = (dir + 1) % 4;
    const left = (dir + 3) % 4;
    for (const turn of [right, left]) {
      // turning onto crossing road `ni`; can we travel `turn` from road index `ri`?
      const ok = turn === 0 || turn === 1 ? ri < roads.length - 1 : ri > 0;
      if (ok) out.push(turn);
    }
    return out;
  }

  randomWalkableNear(px: number, py: number, rMin: number, rMax: number, rng = Math.random): { x: number; y: number } | null {
    for (let attempt = 0; attempt < 30; attempt++) {
      const a = rng() * Math.PI * 2;
      const d = rMin + rng() * (rMax - rMin);
      const tx = Math.floor((px + Math.cos(a) * d) / TILE);
      const ty = Math.floor((py + Math.sin(a) * d) / TILE);
      if (this.tileAt(tx, ty) === Tile.Sidewalk) return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
    }
    return null;
  }

  randomLaneNear(px: number, py: number, rMin: number, rMax: number, rng = Math.random): LaneSpot | null {
    for (let attempt = 0; attempt < 20; attempt++) {
      const dir = Math.floor(rng() * 4);
      const roads = this.roadsFor(dir);
      const ri = Math.floor(rng() * roads.length);
      const lane = this.laneCoord(dir, ri);
      const a = rng() * Math.PI * 2;
      const d = rMin + rng() * (rMax - rMin);
      let x = px + Math.cos(a) * d;
      let y = py + Math.sin(a) * d;
      if (dir % 2 === 0) y = lane;
      else x = lane;
      const dist = Math.hypot(x - px, y - py);
      if (dist < rMin || dist > rMax * 1.2) continue;
      const along = dir % 2 === 0 ? x : y;
      const ni = this.nextIntersection(dir, along);
      if (ni < 0) continue;
      if (this.tileAt(Math.floor(x / TILE), Math.floor(y / TILE)) !== Tile.Road) continue;
      return { x, y, dir, ri, ni };
    }
    return null;
  }

  /** Small RGBA overview (one pixel per tile) for the minimap. */
  overviewPixels(): Uint8ClampedArray {
    const px = new Uint8ClampedArray(this.w * this.h * 4);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const t = this.ground[y][x];
        let c: [number, number, number];
        if (t >= ROOF_BASE) c = [88, 92, 108];
        else if (t === Tile.Water) c = [30, 70, 120];
        else if (t === Tile.Grass || t === Tile.Tree) c = [52, 96, 52];
        else if (t === Tile.Sand) c = [170, 150, 100];
        else if (t === Tile.Sidewalk || t === Tile.Concrete || t === Tile.Parking || t === Tile.Path) c = [120, 120, 118];
        else c = [40, 40, 44];
        const i = (y * this.w + x) * 4;
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
        px[i + 3] = 255;
      }
    }
    return px;
  }
}
