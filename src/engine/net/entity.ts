import { InterpBuffer } from './interp';
import type { EntityDef, Infer, Quantized, Shape } from './schema';
import type { SpatialItem } from '../spatial/SpatialHash';

/**
 * A replicated entity. Exactly one peer (the owner) simulates it and writes
 * `state`; everyone else receives it.
 *
 * - `state`  – authoritative values. Owners mutate this directly.
 * - `render` – what to draw. For owned entities it *is* `state`; for remote
 *              entities it's the interpolated view, `interpDelayMs` behind.
 * - `local`  – free-form, never replicated (sprites, AI scratch data...).
 */
export class NetEntity<S = Record<string, any>> implements SpatialItem {
  state: S;
  render: S;
  owner: string;
  epoch: number;
  /** True when this peer owns and simulates the entity. */
  mine: boolean;
  /** Held entities are never auto-migrated away from their owner (e.g. the car you're driving). */
  held = false;
  alive = true;
  readonly local: Record<string, any> = {};

  /** @internal */ _cell = -1;
  /** @internal */ _q: Quantized[] = [];
  /** @internal */ _qTick = -1;
  /** @internal */ _buf: InterpBuffer | null;
  /** @internal */ _interpOut: number[];
  /** @internal */ _lastHeard = 0;
  /** @internal */ _handoffTo: string | null = null;
  /** @internal */ _handoffSince = 0;
  /** @internal */ _gainTick = -1000;
  /** @internal */ _orphanSince = 0;

  private readonly xKey: string;
  private readonly yKey: string;

  constructor(
    readonly id: number,
    readonly def: EntityDef<any>,
    owner: string,
    epoch: number,
    mine: boolean,
    state: S,
  ) {
    this.owner = owner;
    this.epoch = epoch;
    this.mine = mine;
    this.state = state;
    this.render = mine ? state : { ...state };
    this.xKey = def.layout.keys[def.posX];
    this.yKey = def.layout.keys[def.posY];
    this._buf = def.interpIdx.length > 0 ? new InterpBuffer(def.interpKinds, def.maxExtrapolateMs) : null;
    this._interpOut = new Array(def.interpIdx.length).fill(0);
  }

  /** Rendered position (authoritative for owned entities). */
  get x(): number {
    return (this.render as any)[this.xKey];
  }
  get y(): number {
    return (this.render as any)[this.yKey];
  }

  /** Latest known authoritative position. */
  get stateX(): number {
    return (this.state as any)[this.xKey];
  }
  get stateY(): number {
    return (this.state as any)[this.yKey];
  }

  is<SH extends Shape>(def: EntityDef<SH>): this is NetEntity<Infer<SH>> {
    return this.def === def;
  }
}
