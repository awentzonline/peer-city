import { mulberry32 } from '@engine/index';
import type { Vec3 } from '../crossplay/math';
import { FAT_LENGTH, TUNNEL_HEIGHT, WALK_HEIGHT, WIDTH, type FatSpot } from './sewer';

/**
 * The fatberg: a plug of congealed fat, wipes and worse filling the tunnel into the vault, as a grid of voxels that
 * pressure hoses blast away a little at a time.
 *
 * Voxel u runs across the tunnel, v along it (away from the ladder) and w up from the channel floor, `VOX` meters
 * each. Every voxel has a density of 0 (gone) to 3 (packed solid). The grid is cut into `CHUNK`³ chunks, each a
 * networked entity carrying its densities two bits apiece (`FatChunk.cells`): a chunk's owner is the only peer that
 * blasts it, and everyone else sees its bytes change.
 *
 * Everything here is pure and headless: the grid, packing it, seeding it, ablating it, finding lumps that have come
 * loose, casting rays through it and whether there's a way through.
 */

export const VOX = 0.25;
export const U = Math.round(WIDTH / VOX);
export const V = Math.round(FAT_LENGTH / VOX);
export const W = Math.round(TUNNEL_HEIGHT / VOX);
export const CHUNK = 8;
export const CU = Math.ceil(U / CHUNK);
export const CV = Math.ceil(V / CHUNK);
export const CW = Math.ceil(W / CHUNK);
export const CHUNKS = CU * CV * CW;
/** Bytes a chunk packs into: two bits a voxel. */
export const CHUNK_BYTES = (CHUNK * CHUNK * CHUNK) / 4;
export const MAX_DENSITY = 3;
/**
 * A way through: clear from `WADE` over the floor (lower down, fat is waded through like the sewage) up to
 * `HEADROOM`, `PASSAGE` voxels wide. Bodies collide with fat between the same heights.
 */
export const WADE = 0.75;
export const HEADROOM = 1.5;
const PASSAGE = 3;
/** The walkways along each side of the tunnel: their floor, in voxels up from the channel's. */
const WALK_W = Math.round(WALK_HEIGHT / VOX);
const WALK_U = Math.round(1 / VOX);

export interface Voxel {
  u: number;
  v: number;
  w: number;
}

/** The lowest voxel a column of the tunnel has: the channel floor, or the top of a walkway. */
export function floorW(u: number): number {
  return u < WALK_U || u >= U - WALK_U ? WALK_W : 0;
}

export function index(u: number, v: number, w: number): number {
  return u + U * (v + V * w);
}

export function inGrid(u: number, v: number, w: number): boolean {
  return u >= 0 && v >= 0 && w >= 0 && u < U && v < V && w < W && w >= floorW(u);
}

export function chunkOf(u: number, v: number, w: number): number {
  return Math.floor(u / CHUNK) + CU * (Math.floor(v / CHUNK) + CV * Math.floor(w / CHUNK));
}

export function chunkOrigin(ci: number): Voxel {
  const cu = ci % CU;
  const cv = Math.floor(ci / CU) % CV;
  const cw = Math.floor(ci / (CU * CV));
  return { u: cu * CHUNK, v: cv * CHUNK, w: cw * CHUNK };
}

/** Densities for the whole fatberg. */
export class VoxelGrid {
  readonly d = new Uint8Array(U * V * W);

  get(u: number, v: number, w: number): number {
    return inGrid(u, v, w) ? this.d[index(u, v, w)] : 0;
  }

  set(u: number, v: number, w: number, density: number): void {
    if (inGrid(u, v, w)) this.d[index(u, v, w)] = density;
  }

  solid(u: number, v: number, w: number): boolean {
    return this.get(u, v, w) > 0;
  }

  /** Voxels with anything left in them. */
  count(): number {
    let n = 0;
    for (let i = 0; i < this.d.length; i++) if (this.d[i]) n++;
    return n;
  }

  /** Total density left: how much fat there is. */
  mass(): number {
    let n = 0;
    for (let i = 0; i < this.d.length; i++) n += this.d[i];
    return n;
  }

  /** A chunk's densities, two bits a voxel. */
  pack(ci: number): Uint8Array {
    const out = new Uint8Array(CHUNK_BYTES);
    const o = chunkOrigin(ci);
    for (let lw = 0; lw < CHUNK; lw++) {
      for (let lv = 0; lv < CHUNK; lv++) {
        for (let lu = 0; lu < CHUNK; lu++) {
          const dens = this.get(o.u + lu, o.v + lv, o.w + lw);
          if (!dens) continue;
          const k = lu + CHUNK * (lv + CHUNK * lw);
          out[k >> 2] |= dens << ((k & 3) * 2);
        }
      }
    }
    return out;
  }

  /** Take a chunk's densities from its bytes. Returns whether anything changed. */
  unpack(ci: number, bytes: Uint8Array): boolean {
    const o = chunkOrigin(ci);
    let changed = false;
    for (let lw = 0; lw < CHUNK; lw++) {
      for (let lv = 0; lv < CHUNK; lv++) {
        for (let lu = 0; lu < CHUNK; lu++) {
          const u = o.u + lu;
          const v = o.v + lv;
          const w = o.w + lw;
          if (!inGrid(u, v, w)) continue;
          const k = lu + CHUNK * (lv + CHUNK * lw);
          const dens = ((bytes[k >> 2] ?? 0) >> ((k & 3) * 2)) & 3;
          const i = index(u, v, w);
          if (this.d[i] === dens) continue;
          this.d[i] = dens;
          changed = true;
        }
      }
    }
    return changed;
  }

  copy(from: VoxelGrid): void {
    this.d.set(from.d);
  }
}

/** A hash of a voxel, 0..1, for lumpiness and colour that every peer agrees on. */
export function voxelHash(u: number, v: number, w: number, salt = 0): number {
  let h = Math.imul(u + 17, 0x27d4eb2d) ^ Math.imul(v + 31, 0x165667b1) ^ Math.imul(w + 7, 0x9e3779b1) ^ Math.imul(salt + 3, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** What's embedded in the fat at a voxel, for its colour: mostly fat, now and then something worse. */
export const enum Junk {
  Fat = 0,
  Wipes = 1,
  Grease = 2,
  Cone = 3,
  Hair = 4,
}

export function junkAt(u: number, v: number, w: number): Junk {
  const h = voxelHash(u, v, w, 11);
  if (h < 0.08) return Junk.Wipes;
  if (h < 0.16) return Junk.Grease;
  if (h < 0.19) return Junk.Hair;
  // one traffic cone, jammed in near the middle
  const c = { u: Math.floor(U * 0.6), v: Math.floor(V * 0.45), w: Math.floor(W * 0.4) };
  if (Math.abs(u - c.u) <= 1 && Math.abs(v - c.v) <= 1 && w >= c.w && w <= c.w + 3 - Math.max(Math.abs(u - c.u), Math.abs(v - c.v))) return Junk.Cone;
  return Junk.Fat;
}

/**
 * A fresh fatberg for a dive: the tunnel's whole cross-section packed solid through the middle, with lumpy, softer
 * faces bulging toward each end. Deterministic from the seed.
 */
export function seedFatberg(seed: number): VoxelGrid {
  const g = new VoxelGrid();
  const rnd = mulberry32(seed);
  const bumps = Array.from({ length: 10 }, () => ({ u: rnd() * U, w: rnd() * W, r: 1.5 + rnd() * 3, face: rnd() < 0.5 ? 0 : 1, depth: 1 + rnd() * 2 }));
  for (let w = 0; w < W; w++) {
    for (let v = 0; v < V; v++) {
      for (let u = 0; u < U; u++) {
        if (!inGrid(u, v, w)) continue;
        // how far into the plug from its nearer face, with the faces lumpy
        let face = Math.min(v, V - 1 - v);
        for (const b of bumps) {
          const k = 1 - Math.hypot(u - b.u, w - b.w) / b.r;
          if (k > 0 && (b.face === 0 ? v < V / 2 : v >= V / 2)) face += k * b.depth;
        }
        const n = voxelHash(u, v, w, seed & 0xffff);
        const skin = face + (n - 0.5) * 1.6;
        if (skin < 0.2) continue;
        let dens = skin < 1.2 ? 1 : skin < 2.4 ? 2 : 3;
        // the top sags: softer up by the ceiling
        if (w >= W - 2 && dens > 2) dens = 2;
        if (n > 0.93) dens = Math.max(1, dens - 1);
        g.set(u, v, w, dens);
      }
    }
  }
  return g;
}

/** Where loot's stuck in a fresh fatberg: deep inside, away from each other. */
export function stuckSpots(seed: number, count: number): Voxel[] {
  const rnd = mulberry32(seed ^ 0x51f7);
  const out: Voxel[] = [];
  for (let tries = 0; out.length < count && tries < 200; tries++) {
    const u = 3 + Math.floor(rnd() * (U - 6));
    const v = 2 + Math.floor(rnd() * (V - 4));
    const w = Math.max(floorW(u) + 1, 2 + Math.floor(rnd() * (W - 5)));
    if (out.some((o) => Math.abs(o.u - u) + Math.abs(o.v - v) + Math.abs(o.w - w) < 6)) continue;
    out.push({ u, v, w });
  }
  return out;
}

/** How far round a jet's hit it blasts, in voxels. */
export const BLAST_RADIUS = 2.1;
/** How much density a full-power hit takes off the voxel it strikes. */
const BLAST = 1.0;

/**
 * A jet of water hit voxel (u, v, w) with `power` (0..1): wear away the fat round it, most where it struck. `erosion`
 * keeps the part-worn fraction of each voxel between hits (the owner's own, never sent). Only chunks `owns` says are
 * this peer's to change are worn. Returns the chunks changed.
 */
export function ablate(g: VoxelGrid, hit: Voxel, power: number, erosion: Float32Array, owns: (ci: number) => boolean = () => true): Set<number> {
  const changed = new Set<number>();
  if (power <= 0) return changed;
  const r = BLAST_RADIUS;
  const reach = Math.ceil(r);
  for (let w = hit.w - reach; w <= hit.w + reach; w++) {
    for (let v = hit.v - reach; v <= hit.v + reach; v++) {
      for (let u = hit.u - reach; u <= hit.u + reach; u++) {
        if (!inGrid(u, v, w)) continue;
        const i = index(u, v, w);
        if (!g.d[i] || !owns(chunkOf(u, v, w))) continue;
        const d = Math.hypot(u - hit.u, v - hit.v, w - hit.w);
        if (d >= r) continue;
        erosion[i] += power * BLAST * (1 - d / r);
        while (erosion[i] >= 1 && g.d[i] > 0) {
          erosion[i] -= 1;
          g.d[i]--;
          changed.add(chunkOf(u, v, w));
        }
        if (!g.d[i]) erosion[i] = 0;
      }
    }
  }
  return changed;
}

/** Whether a voxel is held up by the tunnel itself: against a wall, the floor or the ceiling. */
function anchored(u: number, w: number): boolean {
  return u === 0 || u === U - 1 || w === W - 1 || w === floorW(u) || (floorW(u) === 0 && w < WALK_W && (u === WALK_U || u === U - WALK_U - 1));
}

const NEIGHBOURS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/** Solid voxels no longer joined to the tunnel's walls, floor or ceiling by other solid voxels: lumps that fall away. */
export function unsupported(g: VoxelGrid): number[] {
  const seen = new Uint8Array(g.d.length);
  const queue = new Int32Array(g.d.length);
  let tail = 0;
  for (let w = 0; w < W; w++) {
    for (let v = 0; v < V; v++) {
      for (let u = 0; u < U; u++) {
        if (!g.solid(u, v, w) || !anchored(u, w)) continue;
        const i = index(u, v, w);
        seen[i] = 1;
        queue[tail++] = i;
      }
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    const u = i % U;
    const v = Math.floor(i / U) % V;
    const w = Math.floor(i / (U * V));
    for (const [du, dv, dw] of NEIGHBOURS) {
      const nu = u + du;
      const nv = v + dv;
      const nw = w + dw;
      if (!g.solid(nu, nv, nw)) continue;
      const n = index(nu, nv, nw);
      if (seen[n]) continue;
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
  const out: number[] = [];
  for (let i = 0; i < g.d.length; i++) if (g.d[i] && !seen[i]) out.push(i);
  return out;
}

export function voxelOf(i: number): Voxel {
  return { u: i % U, v: Math.floor(i / U) % V, w: Math.floor(i / (U * V)) };
}

/**
 * The first solid voxel a ray meets, from `o` along unit `d` (both in voxel units) within `max` voxels, or null. A
 * ray starting outside the grid is carried to where it enters it.
 */
export function raycastVoxels(g: VoxelGrid, o: Vec3, d: Vec3, max: number): (Voxel & { t: number }) | null {
  // enter the grid's box
  let t0 = 0;
  let t1 = max;
  const lo = [0, 0, 0];
  const hi = [U, V, W];
  const os = [o.x, o.y, o.z];
  const ds = [d.x, d.y, d.z];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ds[k]) < 1e-9) {
      if (os[k] < lo[k] || os[k] >= hi[k]) return null;
      continue;
    }
    let a = (lo[k] - os[k]) / ds[k];
    let b = (hi[k] - os[k]) / ds[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
  }
  if (t0 > t1) return null;
  const px = o.x + d.x * (t0 + 1e-4);
  const py = o.y + d.y * (t0 + 1e-4);
  const pz = o.z + d.z * (t0 + 1e-4);
  let u = Math.min(U - 1, Math.max(0, Math.floor(px)));
  let v = Math.min(V - 1, Math.max(0, Math.floor(py)));
  let w = Math.min(W - 1, Math.max(0, Math.floor(pz)));
  const su = d.x > 0 ? 1 : -1;
  const sv = d.y > 0 ? 1 : -1;
  const sw = d.z > 0 ? 1 : -1;
  const tdu = d.x !== 0 ? Math.abs(1 / d.x) : Infinity;
  const tdv = d.y !== 0 ? Math.abs(1 / d.y) : Infinity;
  const tdw = d.z !== 0 ? Math.abs(1 / d.z) : Infinity;
  let tu = d.x !== 0 ? t0 + (d.x > 0 ? u + 1 - px : px - u) * tdu : Infinity;
  let tv = d.y !== 0 ? t0 + (d.y > 0 ? v + 1 - py : py - v) * tdv : Infinity;
  let tw = d.z !== 0 ? t0 + (d.z > 0 ? w + 1 - pz : pz - w) * tdw : Infinity;
  let t = t0;
  for (let n = 0; n < U + V + W + 3; n++) {
    if (t > t1) return null;
    if (g.solid(u, v, w)) return { u, v, w, t };
    if (tu < tv && tu < tw) {
      t = tu;
      tu += tdu;
      u += su;
    } else if (tv < tw) {
      t = tv;
      tv += tdv;
      v += sv;
    } else {
      t = tw;
      tw += tdw;
      w += sw;
    }
    if (u < 0 || v < 0 || w < 0 || u >= U || v >= V || w >= W) return null;
  }
  return null;
}

/**
 * Whether there's a way through for a Lord: a gap `PASSAGE` voxels wide, clear from `WADE` to `HEADROOM` over the
 * floor, joined from one face of the plug to the other.
 */
export function breached(g: VoxelGrid): boolean {
  const open = new Uint8Array(U * V);
  for (let v = 0; v < V; v++) {
    for (let u = 0; u < U; u++) {
      let clear = true;
      const f = floorW(u);
      for (let w = f + Math.round(WADE / VOX); w < Math.min(W, f + Math.round(HEADROOM / VOX)) && clear; w++) if (g.solid(u, v, w)) clear = false;
      open[u + U * v] = clear ? 1 : 0;
    }
  }
  const fits = (u: number, v: number) => {
    if (u < 0 || u + PASSAGE > U || v < 0 || v >= V) return false;
    for (let k = 0; k < PASSAGE; k++) if (!open[u + k + U * v]) return false;
    return true;
  };
  const seen = new Uint8Array(U * V);
  const queue: number[] = [];
  for (let u = 0; u < U; u++) {
    if (!fits(u, 0)) continue;
    seen[u] = 1;
    queue.push(u);
  }
  while (queue.length) {
    const c = queue.pop()!;
    const u = c % U;
    const v = (c - u) / U;
    if (v === V - 1) return true;
    for (const [du, dv] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nu = u + du;
      const nv = v + dv;
      if (!fits(nu, nv) || seen[nu + U * nv]) continue;
      seen[nu + U * nv] = 1;
      queue.push(nu + U * nv);
    }
  }
  return false;
}

/** Turns between world axes and the fatberg's voxel axes, for where it sits in its tunnel. */
export class FatFrame {
  constructor(readonly spot: FatSpot) {}

  /** A world point in voxel units (fractional). */
  toVoxel(p: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const { spot } = this;
    if (spot.along === 'x') {
      out.x = (p.y - spot.y0) / VOX;
      out.y = ((p.x - spot.x0) * spot.dir) / VOX;
    } else {
      out.x = (p.x - spot.x0) / VOX;
      out.y = ((p.y - spot.y0) * spot.dir) / VOX;
    }
    out.z = p.z / VOX;
    return out;
  }

  /** A world direction in voxel axes (unit stays unit). */
  toVoxelDir(d: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const { spot } = this;
    if (spot.along === 'x') {
      out.x = d.y;
      out.y = d.x * spot.dir;
    } else {
      out.x = d.x;
      out.y = d.y * spot.dir;
    }
    out.z = d.z;
    return out;
  }

  /** The world position of a voxel's centre. */
  toWorld(u: number, v: number, w: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const { spot } = this;
    const a = (u + 0.5) * VOX;
    const b = (v + 0.5) * VOX * spot.dir;
    if (spot.along === 'x') {
      out.x = spot.x0 + b;
      out.y = spot.y0 + a;
    } else {
      out.x = spot.x0 + a;
      out.y = spot.y0 + b;
    }
    out.z = (w + 0.5) * VOX;
    return out;
  }

  /** Whether a circle of radius `r` standing between heights `z0` and `z1` overlaps any fat. */
  blocks(g: VoxelGrid, x: number, y: number, z0: number, z1: number, r: number): boolean {
    const c = this.toVoxel({ x, y, z: 0 }, tmp);
    const rv = r / VOX;
    const u0 = Math.floor(c.x - rv);
    const u1 = Math.floor(c.x + rv);
    const v0 = Math.floor(c.y - rv);
    const v1 = Math.floor(c.y + rv);
    if (u1 < 0 || v1 < 0 || u0 >= U || v0 >= V) return false;
    const w0 = Math.max(0, Math.floor(z0 / VOX));
    const w1 = Math.min(W - 1, Math.floor(z1 / VOX));
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        // closest point of the voxel's square to the circle's centre
        const qx = Math.min(Math.max(c.x, u), u + 1);
        const qy = Math.min(Math.max(c.y, v), v + 1);
        if (Math.hypot(qx - c.x, qy - c.y) >= rv) continue;
        for (let w = w0; w <= w1; w++) if (g.solid(u, v, w)) return true;
      }
    }
    return false;
  }
}

const tmp: Vec3 = { x: 0, y: 0, z: 0 };
