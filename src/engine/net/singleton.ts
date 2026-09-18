import type { NetEntity } from './entity';
import { defineEntity, t } from './schema';
import type { EntityDef, EntityOptions, FieldType, Shape, StateOf } from './schema';
import type { NetWorld } from './world';

/** How coarsely `age` counts, ms. Two made within one step of each other count as the same age, and their ids decide. */
const AGE_STEP_MS = 100;

/** The field `defineSingleton` adds, and `Singleton` keeps: how many `AGE_STEP_MS` its owners have run it for. */
const AGE = 'age';

/**
 * Declare the entity type behind a `Singleton`. Takes everything `defineEntity` does, and adds the `age`
 * field seniority is judged by; `migratable` defaults to true, since a singleton should outlive whoever
 * made it. Don't set `age` yourself: its owner keeps it.
 */
export function defineSingleton<S extends Shape>(opts: EntityOptions<S>): EntityDef<S & { age: FieldType<number> }> {
  if (AGE in opts.fields) throw new Error(`Singleton "${opts.name}" can't have a field called "${AGE}": that's the one seniority is judged by`);
  return defineEntity({
    ...opts,
    fields: { ...opts.fields, [AGE]: t.int(0) },
    migratable: opts.migratable ?? true,
  } as unknown as EntityOptions<S & { age: FieldType<number> }>);
}

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
 * and if more than one exists, keep the one that has been running longest and despawn our own duplicates.
 * Declare its type with `defineSingleton`; like everything else, it unloads when nobody's near.
 *
 * **Seniority, not luck.** Its owner counts up a replicated `age`, so every peer can see which one has been
 * going longer and they all pick the same one. That matters because the wait is a guess: a peer whose
 * connection takes longer to come up than the wait allows will make a second one while the first is already
 * running a match. Age settles it the only way that can't lose anyone's game — the running one wins, on
 * every peer including the latecomer's, and the latecomer despawns the one it just made and joins the match
 * in progress. Ties (two made at once, when neither has any state to lose) go to the lower id, which every
 * peer agrees on.
 *
 * Whoever owns `entity` runs it (`entity.mine`); everyone else reads its state.
 */
export class Singleton<D extends EntityDef<any>> {
  private makeAt = -1;
  /** When we last counted time into the entity's `age`, while we're the one running it. */
  private agedAt = -1;

  constructor(
    private readonly world: NetWorld,
    private readonly def: D,
    private readonly opts: SingletonOptions<D>,
  ) {
    if (!def.layout.keys.includes(AGE)) throw new Error(`Singleton "${def.name}" must be declared with defineSingleton, so it has an "${AGE}" field`);
  }

  /** The one this peer knows of — the longest-running, ties by lowest id — or null. */
  get entity(): NetEntity<StateOf<D>> | null {
    let best: NetEntity<StateOf<D>> | null = null;
    let bestAge = -1;
    for (const e of this.world.all(this.def) as ReadonlySet<NetEntity<StateOf<D>>>) {
      const age = (e.state as Record<string, number>)[AGE];
      if (best && !(age > bestAge || (age === bestAge && e.id < best.id))) continue;
      best = e;
      bestAge = age;
    }
    return best;
  }

  /** Call every frame: ages ours, makes one if it's time, and despawns our duplicates. Returns the entity, if there is one. */
  update(now: number): NetEntity<StateOf<D>> | null {
    const { world } = this;
    const entity = this.entity;
    for (const e of world.owned(this.def)) if (e !== entity) world.despawn(e);
    if (!entity) {
      this.agedAt = -1;
      if (this.makeAt < 0) this.makeAt = now + (this.opts.waitMs ?? 2000) + Math.random() * (this.opts.jitterMs ?? 1500);
      if (now < this.makeAt) return null;
      this.makeAt = -1;
      return world.spawn(this.def, this.opts.init()) as NetEntity<StateOf<D>>;
    }
    this.makeAt = -1;
    if (!entity.mine) {
      // whoever owns it is counting; we'd only double-count if it came back to us
      this.agedAt = -1;
      return entity;
    }
    if (this.agedAt < 0) this.agedAt = now;
    const steps = Math.floor((now - this.agedAt) / AGE_STEP_MS);
    if (steps > 0) {
      // in whole steps, so every peer compares the same number the wire carries
      (entity.state as Record<string, number>)[AGE] += steps;
      this.agedAt += steps * AGE_STEP_MS;
    }
    return entity;
  }
}
