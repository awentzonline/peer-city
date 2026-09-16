import type { ByteReader, ByteWriter } from './codec';

/**
 * Field types describe how a value is quantized, encoded and interpolated.
 *
 * Every field has a *quantized* representation (a number or string) that is
 * what actually goes on the wire and what the replicator diffs against the last
 * value sent to each peer. Quantizing before diffing means sub-precision jitter
 * never costs bandwidth.
 */
export type Quantized = number | string;
export type InterpKind = 'none' | 'linear' | 'angle';

export interface FieldType<T> {
  readonly kind: string;
  readonly defaultValue: T;
  readonly interp: InterpKind;
  quantize(value: T): Quantized;
  dequantize(q: Quantized): T;
  write(w: ByteWriter, q: Quantized): void;
  read(r: ByteReader): Quantized;
}

const TAU = Math.PI * 2;

function wrapAngle(a: number): number {
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}

export const t = {
  /** true / false, 1 byte. */
  bool(defaultValue = false): FieldType<boolean> {
    return {
      kind: 'bool',
      defaultValue,
      interp: 'none',
      quantize: (v) => (v ? 1 : 0),
      dequantize: (q) => q === 1,
      write: (w, q) => w.u8(q as number),
      read: (r) => r.u8(),
    };
  },

  /** Unsigned integer stored in 8, 16 or 32 bits (values are clamped). */
  uint(bits: 8 | 16 | 32 = 8, defaultValue = 0): FieldType<number> {
    const max = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    return {
      kind: `u${bits}`,
      defaultValue,
      interp: 'none',
      quantize: (v) => Math.max(0, Math.min(max, Math.round(v))),
      dequantize: (q) => q as number,
      write: bits === 8 ? (w, q) => w.u8(q as number) : bits === 16 ? (w, q) => w.u16(q as number) : (w, q) => w.u32(q as number),
      read: bits === 8 ? (r) => r.u8() : bits === 16 ? (r) => r.u16() : (r) => r.u32(),
    };
  },

  /** Signed integer, zigzag varint (small magnitudes are 1 byte). */
  int(defaultValue = 0): FieldType<number> {
    return {
      kind: 'int',
      defaultValue,
      interp: 'none',
      quantize: (v) => Math.round(v),
      dequantize: (q) => q as number,
      write: (w, q) => w.varint(q as number),
      read: (r) => r.varint(),
    };
  },

  /**
   * Fixed-point number: `precision` is the smallest step that survives the
   * wire (e.g. 0.5 for half-pixel positions). Encoded as a zigzag varint, so
   * the byte cost scales with magnitude / precision.
   */
  fixed(precision: number, defaultValue = 0, interp: InterpKind = 'linear'): FieldType<number> {
    const inv = 1 / precision;
    return {
      kind: `fixed:${precision}`,
      defaultValue,
      interp,
      quantize: (v) => Math.round(v * inv),
      dequantize: (q) => (q as number) * precision,
      write: (w, q) => w.varint(q as number),
      read: (r) => r.varint(),
    };
  },

  /** Raw 32-bit float. */
  float32(defaultValue = 0, interp: InterpKind = 'linear'): FieldType<number> {
    return {
      kind: 'f32',
      defaultValue,
      interp,
      quantize: (v) => Math.fround(v),
      dequantize: (q) => q as number,
      write: (w, q) => w.f32(q as number),
      read: (r) => r.f32(),
    };
  },

  /** Angle in radians quantized to `bits` (<= 16). Interpolates the short way round. */
  angle(bits = 10, defaultValue = 0): FieldType<number> {
    const steps = 1 << bits;
    const scale = steps / TAU;
    return {
      kind: `angle:${bits}`,
      defaultValue,
      interp: 'angle',
      quantize: (v) => Math.round(wrapAngle(v) * scale) % steps,
      dequantize: (q) => (q as number) / scale,
      write: bits <= 8 ? (w, q) => w.u8(q as number) : (w, q) => w.u16(q as number),
      read: bits <= 8 ? (r) => r.u8() : (r) => r.u16(),
    };
  },

  /** UTF-8 string, truncated to maxLength characters. */
  string(maxLength = 32, defaultValue = ''): FieldType<string> {
    return {
      kind: `str:${maxLength}`,
      defaultValue,
      interp: 'none',
      quantize: (v) => (v.length > maxLength ? v.slice(0, maxLength) : v),
      dequantize: (q) => q as string,
      write: (w, q) => w.string(q as string),
      read: (r) => r.string(),
    };
  },

  /**
   * Up to `maxLength` bytes, length-prefixed: a compact blob for structured data that changes rarely, such as
   * something players build. Replace the array to change it rather than writing into it: it's diffed by
   * contents, and the quantized form of an array is cached.
   */
  bytes(maxLength = 255): FieldType<Uint8Array> {
    const strings = new WeakMap<Uint8Array, string>();
    return {
      kind: `bytes:${maxLength}`,
      defaultValue: new Uint8Array(0),
      interp: 'none',
      quantize: (v) => {
        let q = strings.get(v);
        if (q === undefined) {
          q = '';
          for (let i = 0, n = Math.min(v.length, maxLength); i < n; i++) q += String.fromCharCode(v[i]);
          strings.set(v, q);
        }
        return q;
      },
      dequantize: (q) => {
        const s = q as string;
        const b = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
        strings.set(b, s);
        return b;
      },
      write: (w, q) => {
        const s = q as string;
        w.varuint(s.length);
        const b = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
        w.bytes(b);
      },
      read: (r) => {
        const b = r.bytes(r.varuint());
        let q = '';
        for (let i = 0; i < b.length; i++) q += String.fromCharCode(b[i]);
        return q;
      },
    };
  },

  /** Reference to another entity by network id (0 = none). */
  ref(): FieldType<number> {
    return {
      kind: 'ref',
      defaultValue: 0,
      interp: 'none',
      quantize: (v) => v,
      dequantize: (q) => q as number,
      write: (w, q) => w.id48(q as number),
      read: (r) => r.id48(),
    };
  },
};

export type Shape = Record<string, FieldType<any>>;
export type Infer<S extends Shape> = { [K in keyof S]: S[K] extends FieldType<infer T> ? T : never };

/** Compiled field layout shared by entities and actions. */
export class FieldLayout<S extends Shape = Shape> {
  readonly keys: (keyof S & string)[];
  readonly types: FieldType<any>[];
  readonly allMask: number;

  constructor(readonly shape: S) {
    this.keys = Object.keys(shape) as (keyof S & string)[];
    this.types = this.keys.map((k) => shape[k]);
    if (this.keys.length > 30) throw new Error('A schema can have at most 30 fields');
    this.allMask = (1 << this.keys.length) - 1;
  }

  defaults(): Infer<S> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < this.keys.length; i++) out[this.keys[i]] = this.types[i].defaultValue;
    return out as Infer<S>;
  }

  quantizeInto(values: Infer<S>, out: Quantized[]): Quantized[] {
    for (let i = 0; i < this.keys.length; i++) out[i] = this.types[i].quantize((values as any)[this.keys[i]]);
    return out;
  }

  writeMasked(w: ByteWriter, q: Quantized[], mask: number): void {
    for (let i = 0; i < this.types.length; i++) if (mask & (1 << i)) this.types[i].write(w, q[i]);
  }

  /** Reads masked fields and assigns their dequantized values onto `target`. */
  readMaskedInto(r: ByteReader, mask: number, target: Record<string, unknown> | null): void {
    for (let i = 0; i < this.types.length; i++) {
      if (!(mask & (1 << i))) continue;
      const q = this.types[i].read(r);
      if (target) target[this.keys[i]] = this.types[i].dequantize(q);
    }
  }

  signature(): string {
    return this.keys.map((k, i) => `${k}:${this.types[i].kind}`).join(',');
  }
}

export interface EntityOptions<S extends Shape> {
  /** Unique name; used for the schema fingerprint. */
  name: string;
  fields: S;
  /**
   * Fields holding the entity's world position. Required for interest
   * management, zone routing and authority. Default ['x', 'y'].
   */
  position?: [keyof S & string, keyof S & string];
  /**
   * Migratable entities (NPCs, vehicles, pickups) survive their owner leaving:
   * the region's authority peer takes them over, and idle ones are rebalanced
   * to whichever peer the rendezvous hash picks for their cell. Non-migratable
   * entities (player avatars) disappear with their owner.
   */
  migratable?: boolean;
  /** Relative send priority when a peer's bandwidth budget is exhausted. Default 1. */
  priority?: number;
  /**
   * Which fields remote peers smooth with snapshot interpolation. Default: every
   * field whose type supports interpolation.
   */
  interpolate?: (keyof S & string)[];
  /** Distance jump above which remote peers snap instead of interpolating. */
  snapDistance?: number;
  /** Extrapolate (dead-reckon) up to this many ms when snapshots run late. Default 150. */
  maxExtrapolateMs?: number;
  /**
   * Owners automatically despawn un-held migratable entities that are farther
   * than this from every known player focus (keeps NPC populations local).
   */
  cullDistance?: number;
}

export interface EntityDef<S extends Shape = Shape> {
  readonly kind: 'entity';
  readonly name: string;
  readonly layout: FieldLayout<S>;
  readonly posX: number;
  readonly posY: number;
  readonly migratable: boolean;
  readonly priority: number;
  /** Field indices that interpolate, and how. */
  readonly interpIdx: number[];
  readonly interpKinds: InterpKind[];
  readonly snapDistance: number;
  readonly maxExtrapolateMs: number;
  readonly cullDistance: number;
  /** Assigned when registered with a NetWorld. */
  typeId: number;
  /** Phantom for type inference. */
  readonly _state?: Infer<S>;
}

export function defineEntity<S extends Shape>(opts: EntityOptions<S>): EntityDef<S> {
  const layout = new FieldLayout(opts.fields);
  const [px, py] = opts.position ?? (['x', 'y'] as [keyof S & string, keyof S & string]);
  const posX = layout.keys.indexOf(px);
  const posY = layout.keys.indexOf(py);
  if (posX < 0 || posY < 0) throw new Error(`Entity "${opts.name}" needs position fields (${px}, ${py})`);
  const interpNames = opts.interpolate ?? layout.keys.filter((_, i) => layout.types[i].interp !== 'none');
  const interpIdx = interpNames.map((n) => layout.keys.indexOf(n));
  return {
    kind: 'entity',
    name: opts.name,
    layout,
    posX,
    posY,
    migratable: opts.migratable ?? false,
    priority: opts.priority ?? 1,
    interpIdx,
    interpKinds: interpIdx.map((i) => (layout.types[i].interp === 'none' ? 'linear' : layout.types[i].interp)),
    snapDistance: opts.snapDistance ?? 250,
    maxExtrapolateMs: opts.maxExtrapolateMs ?? 150,
    cullDistance: opts.cullDistance ?? Infinity,
    typeId: -1,
  };
}

export interface ActionDef<S extends Shape = Shape> {
  readonly kind: 'action';
  readonly name: string;
  readonly layout: FieldLayout<S>;
  typeId: number;
  readonly _payload?: Infer<S>;
}

/** A typed, binary-encoded message (RPC / event) with a schema. */
export function defineAction<S extends Shape>(name: string, fields: S): ActionDef<S> {
  return { kind: 'action', name, layout: new FieldLayout(fields), typeId: -1 };
}

export type StateOf<D> = D extends EntityDef<infer S> ? Infer<S> : never;
export type PayloadOf<D> = D extends ActionDef<infer S> ? Infer<S> : never;
