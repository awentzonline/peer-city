import type { NetEntity } from './entity';
import type { EntityDef, StateOf } from './schema';
import { Singleton, type SingletonOptions } from './singleton';
import type { NetWorld } from './world';

/**
 * Runs a `Singleton` for whoever owns it: a match, a round, a night. Extend it with `run`, called every frame while
 * this peer owns the entity. Anything the keeper remembers outside the entity's fields (timers, what's been announced)
 * is lost when the entity changes hands, so `takeOver` is called whenever this peer starts running it, made here or
 * inherited, to start those from now rather than from a stale value or zero.
 */
export abstract class Keeper<D extends EntityDef<any>> {
  protected readonly one: Singleton<D>;
  /** The entity this peer is running, if it is. */
  private running: NetEntity<StateOf<D>> | null = null;

  constructor(world: NetWorld, def: D, opts: SingletonOptions<D>) {
    this.one = new Singleton(world, def, opts);
  }

  /** The one this peer knows of, ours or somebody's, or null. */
  get entity(): NetEntity<StateOf<D>> | null {
    return this.one.entity;
  }

  /** Whether this peer is the one running it. */
  get mine(): boolean {
    return this.running !== null;
  }

  update(dt: number, now: number): void {
    const e = this.one.update(now);
    if (!e?.mine) {
      if (this.running) this.letGo(now);
      this.running = null;
      this.watching(now);
      return;
    }
    if (this.running !== e) {
      this.running = e;
      this.takeOver(e, now);
    }
    this.run(e, dt, now);
  }

  /** Every frame while this peer owns it. */
  protected abstract run(e: NetEntity<StateOf<D>>, dt: number, now: number): void;

  /** Ours now: made here, or its last owner left. Seed the clocks that aren't on the wire from `now`. */
  protected takeOver(_e: NetEntity<StateOf<D>>, _now: number): void {}

  /** Somebody else owns it now, or it's gone. */
  protected letGo(_now: number): void {}

  /** Every frame this peer isn't running it. */
  protected watching(_now: number): void {}
}
