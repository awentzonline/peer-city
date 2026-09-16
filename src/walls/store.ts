import type { Surface } from './wall';
import { capture, deflate, inflate, type SavedTile } from './sync';

/**
 * Where this browser keeps the walls between visits, one set per yard name. The walls only live while someone's
 * painting, so this is what brings them back when the first painter returns to an empty yard. The rules never
 * see where it's kept: the game uses `IndexedDbWalls` in the browser, tests `MemoryWalls`.
 */
export interface WallStore {
  load(yard: string): Promise<SavedTile[] | null>;
  save(yard: string, surfaces: readonly Surface[]): Promise<void>;
}

export class MemoryWalls implements WallStore {
  private readonly yards = new Map<string, SavedTile[]>();

  async load(yard: string): Promise<SavedTile[] | null> {
    return this.yards.get(yard) ?? null;
  }

  async save(yard: string, surfaces: readonly Surface[]): Promise<void> {
    this.yards.set(yard, capture(surfaces));
  }
}

const DB = 'peer-walls';
const STORE = 'yards';

interface YardRecord {
  tiles: { surface: number; tile: number; data: Uint8Array }[];
  savedAt: number;
}

/** Kept in IndexedDB, deflated: a well-painted yard is a few megabytes of pixels, too much for localStorage. */
export class IndexedDbWalls implements WallStore {
  private db: Promise<IDBDatabase> | null = null;

  async load(yard: string): Promise<SavedTile[] | null> {
    try {
      const db = await this.open();
      const record = await request<YardRecord | undefined>(db.transaction(STORE).objectStore(STORE).get(yard));
      if (!record) return null;
      return await Promise.all(record.tiles.map(async (t) => ({ surface: t.surface, tile: t.tile, data: await inflate(t.data) })));
    } catch {
      return null; // private browsing, blocked storage, or a damaged record: start bare
    }
  }

  async save(yard: string, surfaces: readonly Surface[]): Promise<void> {
    const raw = capture(surfaces);
    const tiles = await Promise.all(raw.map(async (t) => ({ surface: t.surface, tile: t.tile, data: await deflate(t.data) })));
    try {
      const db = await this.open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ tiles, savedAt: Date.now() } satisfies YardRecord, yard);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* storage unavailable: the walls just won't be here next time */
    }
  }

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}
