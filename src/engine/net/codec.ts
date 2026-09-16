/**
 * Minimal growable binary writer / reader used for every packet on the wire.
 * Little-endian, with LEB128 varints and zigzag signed varints.
 */

const TWO_32 = 0x1_0000_0000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ByteWriter {
  buf: Uint8Array;
  view: DataView;
  length = 0;

  constructor(capacity = 512) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  reset(): this {
    this.length = 0;
    return this;
  }

  private ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v & 0xffff, true);
    this.length += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
    return this;
  }

  /** Unsigned LEB128, valid for integers up to 2^53. */
  varuint(v: number): this {
    this.ensure(8);
    while (v >= 0x80) {
      this.buf[this.length++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.length++] = v;
    return this;
  }

  /** Zigzag-encoded signed varint. */
  varint(v: number): this {
    return this.varuint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  /** 48-bit id: low u32 + high u16. */
  id48(v: number): this {
    this.u32(v % TWO_32);
    return this.u16(Math.floor(v / TWO_32));
  }

  string(s: string): this {
    const bytes = textEncoder.encode(s);
    this.varuint(bytes.length);
    return this.bytes(bytes);
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  /** Copy of the written bytes. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export class ByteReader {
  private view: DataView;
  pos = 0;

  constructor(public readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private check(n: number): void {
    if (this.pos + n > this.buf.length) throw new RangeError('ByteReader: read past end');
  }

  u8(): number {
    this.check(1);
    return this.buf[this.pos++];
  }

  u16(): number {
    this.check(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.check(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    this.check(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.check(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  varuint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      result += (byte & 0x7f) * mul;
      if (byte < 0x80) return result;
      mul *= 0x80;
    }
    throw new RangeError('ByteReader: varint too long');
  }

  varint(): number {
    const z = this.varuint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  id48(): number {
    const lo = this.u32();
    const hi = this.u16();
    return hi * TWO_32 + lo;
  }

  /** `n` raw bytes (a view into the buffer: copy it to keep it). */
  bytes(n: number): Uint8Array {
    this.check(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  string(): string {
    const len = this.varuint();
    this.check(len);
    const s = textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}
