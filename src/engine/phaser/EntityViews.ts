import type { NetEntity } from '../net/entity';
import type { EntityDef, Infer, Shape } from '../net/schema';
import type { NetWorld, RemoveReason } from '../net/world';

export interface ViewFactory<S, V> {
  /** Build display objects when an entity appears (spawned locally or received). */
  create(e: NetEntity<S>): V;
  /** Sync display from `e.render` every frame. */
  update(view: V, e: NetEntity<S>, dt: number): void;
  /** Tear down; `reason` distinguishes a real destroy from leaving interest range. */
  destroy(view: V, e: NetEntity<S>, reason: RemoveReason): void;
}

/**
 * Binds entity lifecycles to renderer objects so game code never tracks
 * spawn/despawn bookkeeping by hand. Renderer-agnostic, but designed for
 * Phaser GameObjects.
 */
export class EntityViews {
  private factories = new Map<EntityDef<any>, ViewFactory<any, any>>();
  private views = new Map<NetEntity<any>, { view: unknown; factory: ViewFactory<any, any> }>();
  private unsubs: (() => void)[] = [];

  constructor(private readonly world: NetWorld) {
    this.unsubs.push(
      world.on('entityAdded', (e) => this.attach(e)),
      world.on('entityRemoved', (e, reason) => {
        const entry = this.views.get(e);
        if (!entry) return;
        this.views.delete(e);
        entry.factory.destroy(entry.view, e, reason);
      }),
    );
  }

  register<SH extends Shape, V>(def: EntityDef<SH>, factory: ViewFactory<Infer<SH>, V>): this {
    this.factories.set(def, factory);
    for (const e of this.world.all(def)) this.attach(e);
    return this;
  }

  get<V>(e: NetEntity<any>): V | undefined {
    return this.views.get(e)?.view as V | undefined;
  }

  update(dt: number): void {
    for (const [e, entry] of this.views) entry.factory.update(entry.view, e, dt);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    for (const [e, entry] of this.views) entry.factory.destroy(entry.view, e, 'unloaded');
    this.views.clear();
  }

  private attach(e: NetEntity<any>): void {
    if (this.views.has(e)) return;
    const factory = this.factories.get(e.def);
    if (factory) this.views.set(e, { view: factory.create(e), factory });
  }
}
