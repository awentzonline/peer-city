import { mulberry32 } from '@engine/index';

/** Side of one map tile, in meters. */
export const TILE = 3;

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
  Sand = 14,
  Building = 20,
}

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

export interface Building {
  /** Footprint in tiles. */
  tx: number;
  ty: number;
  tw: number;
  th: number;
  height: number;
  tint: number;
}

export const BUILDING_TINTS = 8;
const TREE_HEIGHT = 5.5;

/**
 * Procedural city on a tile grid. Generated from a seed, so every peer builds
 * the identical map locally and no map data crosses the network. Movement
 * collides against the 2D grid; bullets also respect building heights.
 */
export class City {
  readonly w: number;
  readonly h: number;
  readonly ground: Uint8Array;
  /** Height of whatever stands on each tile (buildings, trees), 0 for open ground. */
  readonly heights: Float32Array;
  readonly solid: Uint8Array;
  readonly walkable: Uint8Array;
  readonly vRoads: number[] = [];
  readonly hRoads: number[] = [];
  readonly parking: Spot[] = [];
  readonly buildings: Building[] = [];

  constructor(
    readonly seed = 1337,
    size = 256,
  ) {
    this.w = this.h = size;
    const rng = mulberry32(seed);
    const { w, h } = this;
    this.ground = new Uint8Array(w * h);
    this.heights = new Float32Array(w * h);
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

    for (let y = border + 2; y < h - border - 2; y++) {
      for (let x = border + 2; x < w - border - 2; x++) {
        if (this.tileAt(x, y) === Tile.Grass && rng() < 0.05) this.set(x, y, Tile.Tree);
      }
    }
  }

  /** World size in meters. */
  get size(): number {
    return this.w * TILE;
  }

  private set(x: number, y: number, tile: number, height = 0): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.ground[i] = tile;
    this.heights[i] = tile === Tile.Tree ? TREE_HEIGHT : height;
    this.solid[i] = tile === Tile.Building || tile === Tile.Water || tile === Tile.Tree ? 1 : 0;
    this.walkable[i] =
      tile === Tile.Sidewalk || tile === Tile.CrossH || tile === Tile.CrossV || tile === Tile.Path || tile === Tile.Concrete || tile === Tile.Parking
        ? 1
        : 0;
  }

  private fill(x: number, y: number, w: number, h: number, tile: number, height = 0): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, tile, height);
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
          if (this.tileAt(xx, yy) === Tile.Grass && rng() < 0.16) this.set(xx, yy, Tile.Tree);
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
    // downtown towers, low-rise at the edges
    const cx = (x + w / 2) / this.w - 0.5;
    const cy = (y + h / 2) / this.h - 0.5;
    const central = Math.max(0, 1 - Math.hypot(cx, cy) * 2.3);
    const floors = 2 + Math.floor(rng() * 4) + Math.floor(central * central * (4 + rng() * 22));
    const height = floors * 3.2;
    const tint = floors > 12 ? 0 : 1 + Math.floor(rng() * (BUILDING_TINTS - 1));
    this.buildings.push({ tx: x, ty: y, tw: w, th: h, height, tint });
    this.fill(x, y, w, h, Tile.Building, height);
  }

  // -------------------------------------------------------------------------
  // Queries (meters unless noted)
  // -------------------------------------------------------------------------

  tileAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return Tile.Water;
    return this.ground[ty * this.w + tx];
  }

  heightAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return 0;
    return this.heights[ty * this.w + tx];
  }

  isSolidTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return true;
    return this.solid[ty * this.w + tx] === 1;
  }

  isSolidAt(x: number, y: number): boolean {
    return this.isSolidTile(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  isWalkableTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    return this.walkable[ty * this.w + tx] === 1;
  }

  /** Circle overlaps any solid tile? */
  circleBlocked(x: number, y: number, r: number): boolean {
    const x0 = Math.floor((x - r) / TILE);
    const x1 = Math.floor((x + r) / TILE);
    const y0 = Math.floor((y - r) / TILE);
    const y1 = Math.floor((y + r) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.isSolidTile(tx, ty)) continue;
        const nx = Math.max(tx * TILE, Math.min(x, (tx + 1) * TILE));
        const ny = Math.max(ty * TILE, Math.min(y, (ty + 1) * TILE));
        if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
      }
    }
    return false;
  }

  /** Ground-plane distance to the first solid tile along a heading (line of sight at street level). */
  raycast(x: number, y: number, angle: number, maxDist: number): number {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (let d = 0; d < maxDist; d += 0.5) {
      if (this.isSolidAt(x + dx * d, y + dy * d)) return d;
    }
    return maxDist;
  }

  /**
   * Distance along a 3D ray to the first building, tree or the ground. Walks
   * the tile grid (DDA) and compares the ray's height against what stands on
   * each tile, so you can shoot over low roofs. `d` must be normalized.
   */
  raycast3D(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
    let limit = maxDist;
    if (dz < -1e-6) limit = Math.min(limit, Math.max(0, -oz / dz));
    let tx = Math.floor(ox / TILE);
    let ty = Math.floor(oy / TILE);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const deltaX = adx > 1e-9 ? TILE / adx : Infinity;
    const deltaY = ady > 1e-9 ? TILE / ady : Infinity;
    let nextX = adx > 1e-9 ? (dx > 0 ? (tx + 1) * TILE - ox : ox - tx * TILE) / adx : Infinity;
    let nextY = ady > 1e-9 ? (dy > 0 ? (ty + 1) * TILE - oy : oy - ty * TILE) / ady : Infinity;
    let t = 0;
    while (t < limit) {
      const top = this.heightAt(tx, ty);
      if (top > 0) {
        if (oz + dz * t <= top) return t;
        const exit = Math.min(nextX, nextY, limit);
        if (oz + dz * exit <= top) return Math.max(t, (top - oz) / dz);
      }
      if (nextX < nextY) {
        t = nextX;
        nextX += deltaX;
        tx += stepX;
      } else {
        t = nextY;
        nextY += deltaY;
        ty += stepY;
      }
    }
    return limit;
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

  crossRoads(dir: number): number[] {
    return dir % 2 === 0 ? this.vRoads : this.hRoads;
  }

  roadsFor(dir: number): number[] {
    return dir % 2 === 0 ? this.hRoads : this.vRoads;
  }

  nextIntersection(dir: number, along: number): number {
    const cross = this.crossRoads(dir);
    if (dir === 0 || dir === 1) {
      for (let i = 0; i < cross.length; i++) if ((cross[i] + 2) * TILE > along) return i;
      return -1;
    }
    for (let i = cross.length - 1; i >= 0; i--) if ((cross[i] + 2) * TILE < along) return i;
    return -1;
  }

  exits(dir: number, ri: number, ni: number): number[] {
    const out: number[] = [];
    const cross = this.crossRoads(dir);
    const roads = this.roadsFor(dir);
    const forward = dir === 0 || dir === 1 ? ni < cross.length - 1 : ni > 0;
    if (forward) out.push(dir);
    for (const turn of [(dir + 1) % 4, (dir + 3) % 4]) {
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
    for (let i = 0; i < this.w * this.h; i++) {
      const t = this.ground[i];
      let c: [number, number, number];
      if (t === Tile.Building) c = [88, 92, 108];
      else if (t === Tile.Water) c = [30, 70, 120];
      else if (t === Tile.Grass || t === Tile.Tree) c = [52, 96, 52];
      else if (t === Tile.Sand) c = [170, 150, 100];
      else if (t === Tile.Sidewalk || t === Tile.Concrete || t === Tile.Parking || t === Tile.Path) c = [120, 120, 118];
      else c = [40, 40, 44];
      px[i * 4] = c[0];
      px[i * 4 + 1] = c[1];
      px[i * 4 + 2] = c[2];
      px[i * 4 + 3] = 255;
    }
    return px;
  }
}
