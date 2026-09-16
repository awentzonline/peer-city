import type { NetEntity } from './entity';
import type { EntityDef, StateOf } from './schema';
import type { NetWorld } from './world';

export interface SingletonOptions<D extends EntityDef<any>> {
  /** The fields a new one starts with, including where it lives: its position decides which peers can own it. */
  init: () => Partial<StateOf<D>>;
  /** How long to listen for someone else's before making one, ms. Default 2000. */
  waitMs?: number;
  /** Up to this much more, at random, so peers that arrive together don't all make one. Default 1500. */
  jitterMs?: number;
}

/**
 * One entity of a type for the whole neighbourhood, with no server to say who makes it: a race, a match, a
 * vote. Every peer runs the same rule. Wait a moment to hear about an existing one, make one if nobody has,
 * and if several were made at once, keep the one with the lowest id (which every peer agrees on) and despawn
 * our own duplicates. Make the type `migratable` so it outlives whoever made it; like everything else, it
 * unloads when nobody's near.
 *
 * Whoever owns `entity` runs it (`entity.mine`); everyone else reads its state.
 */
export class Singleton<D extends EntityDef<any>> {
  private makeAt = -1;

  constructor(
    private readonly world: NetWorld,
    private readonly def: D,
    private readonly opts: SingletonOptions<D>,
  ) {}

  /** The one this peer knows of, or null. */
  get entity(): NetEntity<StateOf<D>> | null {
    let best: NetEntity<StateOf<D>> | null = null;
    for (const e of this.world.all(this.def) as ReadonlySet<NetEntity<StateOf<D>>>) if (!best || e.id < best.id) best = e;
    return best;
  }

  /** Call every frame: makes one if it's time, and despawns our duplicates. Returns the entity, if there is one. */
  update(now: number): NetEntity<StateOf<D>> | null {
    const { world } = this;
    const entity = this.entity;
    for (const e of world.all(this.def)) if (e !== entity && e.mine) world.despawn(e);
    if (entity) {
      this.makeAt = -1;
      return entity;
    }
    if (this.makeAt < 0) this.makeAt = now + (this.opts.waitMs ?? 2000) + Math.random() * (this.opts.jitterMs ?? 1500);
    if (now < this.makeAt) return null;
    this.makeAt = -1;
    return world.spawn(this.def, this.opts.init()) as NetEntity<StateOf<D>>;
  }
}
