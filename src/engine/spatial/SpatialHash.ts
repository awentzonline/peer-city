export interface SpatialItem {
  /** Managed by SpatialHash; -1 when not inserted. */
  _cell: number;
}

const OFFSET = 32768;

/** Uniform grid for fast "what's near this point" queries. */
export class SpatialHash<T extends SpatialItem> {
  private cells = new Map<number, Set<T>>();
  private inv: number;

  constructor(readonly cellSize = 256) {
    this.inv = 1 / cellSize;
  }

  private key(cx: number, cy: number): number {
    return (cx + OFFSET) * 65536 + (cy + OFFSET);
  }

  /** Insert or move an item. Cheap when the item stays in its cell. */
  update(item: T, x: number, y: number): void {
    const k = this.key(Math.floor(x * this.inv), Math.floor(y * this.inv));
    if (item._cell === k) return;
    if (item._cell !== -1) this.cells.get(item._cell)?.delete(item);
    let set = this.cells.get(k);
    if (!set) this.cells.set(k, (set = new Set()));
    set.add(item);
    item._cell = k;
  }

  remove(item: T): void {
    if (item._cell === -1) return;
    const set = this.cells.get(item._cell);
    if (set) {
      set.delete(item);
      if (set.size === 0) this.cells.delete(item._cell);
    }
    item._cell = -1;
  }

  /** Items in cells overlapping the square around (x, y); caller filters exact distance. */
  queryRect(minX: number, minY: number, maxX: number, maxY: number, out: T[] = []): T[] {
    const x0 = Math.floor(minX * this.inv);
    const x1 = Math.floor(maxX * this.inv);
    const y0 = Math.floor(minY * this.inv);
    const y1 = Math.floor(maxY * this.inv);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const set = this.cells.get(this.key(cx, cy));
        if (set) for (const item of set) out.push(item);
      }
    }
    return out;
  }

  queryRadius(x: number, y: number, r: number, out: T[] = []): T[] {
    return this.queryRect(x - r, y - r, x + r, y + r, out);
  }
}
