import type { NetWorld } from '@engine/index';
import type { Vec3 } from '../crossplay/math';
import type { ChunkEntity } from './context';
import { Crumble, FatChunk } from './defs';
import {
  CHUNK,
  CHUNKS,
  CHUNK_BYTES,
  FatFrame,
  U,
  V,
  VOX,
  VoxelGrid,
  W,
  ablate,
  breached,
  chunkOf,
  chunkOrigin,
  raycastVoxels,
  seedFatberg,
  unsupported,
  voxelOf,
  type Voxel,
} from './fatberg';
import type { SewerMap } from './sewer';

const EMPTY = new Uint8Array(CHUNK_BYTES);
/** How often an owner looks for lumps that have come loose, ms. */
const CRUMBLE_MS = 250;
/** Voxels a `Crumble` event carries, three bytes each. */
const CRUMBLE_MAX = 80;

export interface FatHit extends Voxel {
  ci: number;
  /** How far along the ray, m, and where it struck. */
  dist: number;
  at: Vec3;
}

/**
 * The fatberg as this peer knows it: a voxel grid kept in step with every chunk entity of the current dive, which is
 * what's drawn, collided with and aimed at. Chunks this peer owns are blasted here (`sprayed`) and written back to
 * their entities; lumps that come loose are knocked out by their chunk's owner and sent as `Crumble`s for everyone to
 * see fall.
 */
export class Plug {
  readonly grid = new VoxelGrid();
  readonly frame: FatFrame;
  /** Part-worn voxels, for chunks this peer owns. Never sent: a new owner starts them afresh. */
  readonly erosion = new Float32Array(U * V * W);
  /** The chunk entity for each chunk of the grid, this dive. */
  readonly chunks: (ChunkEntity | null)[] = new Array(CHUNKS).fill(null);
  /** Bumped whenever the grid changes, so the view knows to rebuild. */
  version = 0;
  private readonly seen: (Uint8Array | null)[] = new Array(CHUNKS).fill(null);
  private dirty = false;
  private nextCheck = 0;

  constructor(readonly map: SewerMap) {
    this.frame = new FatFrame(map.fat);
  }

  /** Catch up with the chunks of this dive: the oldest of each, should two have been made. */
  sync(world: NetWorld, dive: number): void {
    this.chunks.fill(null);
    for (const c of world.all(FatChunk) as ReadonlySet<ChunkEntity>) {
      const { ci, dive: d } = c.render;
      if (d !== dive || ci >= CHUNKS) continue;
      const have = this.chunks[ci];
      if (!have || c.id < have.id) this.chunks[ci] = c;
    }
    let changed = false;
    for (let ci = 0; ci < CHUNKS; ci++) {
      const bytes = this.chunks[ci]?.render.cells ?? EMPTY;
      if (bytes === this.seen[ci]) continue;
      this.seen[ci] = bytes;
      if (this.grid.unpack(ci, bytes)) changed = true;
    }
    if (changed) {
      this.version++;
      this.dirty = true;
    }
    this.map.fatBlocks = !this.open;
  }

  /** Whether there's a way through right now, by this peer's reckoning. */
  get open(): boolean {
    if (this.openVersion !== this.version) {
      this.openVersion = this.version;
      this.wasOpen = this.grid.count() === 0 || breached(this.grid);
    }
    return this.wasOpen;
  }

  private openVersion = -1;
  private wasOpen = true;

  /** Make a fresh fatberg for a dive: every chunk, owned by whoever calls this. */
  spawn(world: NetWorld, dive: number, seed: number): void {
    const fresh = seedFatberg(seed);
    for (let ci = 0; ci < CHUNKS; ci++) {
      const o = chunkOrigin(ci);
      const at = this.frame.toWorld(o.u + CHUNK / 2, o.v + CHUNK / 2, 0);
      world.spawn(FatChunk, { x: at.x, y: at.y, ci, cells: fresh.pack(ci), dive });
    }
  }

  /** A jet struck a chunk this peer owns: blast the fat round the hit, in every chunk that's ours. */
  sprayed(chunk: ChunkEntity, hit: Voxel, power: number): void {
    if (this.chunks[chunk.render.ci] !== chunk) return;
    const changed = ablate(this.grid, hit, power, this.erosion, (ci) => !!this.chunks[ci]?.mine);
    for (const ci of changed) this.write(ci);
    if (changed.size) {
      this.version++;
      this.dirty = true;
    }
  }

  /**
   * Chunks this peer owns: gone when their dive is, or when they're a spare copy; and once in a while after the fat's
   * changed, knock out any lumps of theirs that nothing holds up any more.
   */
  updateOwned(world: NetWorld, dive: number, now: number): void {
    for (const c of world.owned(FatChunk) as ReadonlySet<ChunkEntity>) {
      if (c.state.dive !== dive || (this.chunks[c.state.ci] && this.chunks[c.state.ci] !== c)) world.despawn(c);
    }
    if (!this.dirty || now < this.nextCheck) return;
    this.nextCheck = now + CRUMBLE_MS;
    this.dirty = false;
    const loose = new Map<number, number[]>();
    for (const i of unsupported(this.grid)) {
      const { u, v, w } = voxelOf(i);
      const ci = chunkOf(u, v, w);
      if (!this.chunks[ci]?.mine) continue;
      let list = loose.get(ci);
      if (!list) loose.set(ci, (list = []));
      list.push(i);
    }
    for (const [ci, list] of loose) {
      for (let n = 0; n < list.length; n += CRUMBLE_MAX) {
        const part = list.slice(n, n + CRUMBLE_MAX);
        const bytes = new Uint8Array(part.length * 3);
        part.forEach((i, k) => {
          const { u, v, w } = voxelOf(i);
          bytes[k * 3] = u;
          bytes[k * 3 + 1] = v;
          bytes[k * 3 + 2] = w;
          this.grid.d[i] = 0;
          this.erosion[i] = 0;
        });
        world.send(Crumble, { ci, voxels: bytes }, { to: 'all' });
      }
      this.write(ci);
      this.version++;
    }
  }

  /** Whether a body of radius `r` standing between heights `z0` and `z1` at (x, y) is in the fat. */
  blocks(x: number, y: number, z0: number, z1: number, r: number): boolean {
    return this.frame.blocks(this.grid, x, y, z0, z1, r);
  }

  /** The first fat a ray from `o` along unit `d` meets within `max` meters, or null. */
  raycast(o: Vec3, d: Vec3, max: number): FatHit | null {
    const hit = raycastVoxels(this.grid, this.frame.toVoxel(o), this.frame.toVoxelDir(d), max / VOX);
    if (!hit) return null;
    const dist = hit.t * VOX;
    return { ...hit, ci: chunkOf(hit.u, hit.v, hit.w), dist, at: { x: o.x + d.x * dist, y: o.y + d.y * dist, z: o.z + d.z * dist } };
  }

  /** How much fat is left round a voxel (within one), for loot stuck in it. */
  around(u: number, v: number, w: number): number {
    let n = 0;
    for (let dw = -1; dw <= 1; dw++) for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) if (this.grid.solid(u + du, v + dv, w + dw)) n++;
    return n;
  }

  private write(ci: number): void {
    const c = this.chunks[ci];
    if (!c?.mine) return;
    const bytes = this.grid.pack(ci);
    c.state.cells = bytes;
    this.seen[ci] = bytes;
  }
}
