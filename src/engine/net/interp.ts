import type { InterpKind } from './schema';

const MAX_SAMPLES = 12;
const TAU = Math.PI * 2;

function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Snapshot interpolation buffer for one remote entity. Samples are stamped in
 * *local* time (sender time + estimated clock offset) and rendered a fixed
 * delay in the past, so motion stays smooth despite jitter and throttled
 * update rates. Short gaps are bridged with capped extrapolation.
 *
 * Samples live in a fixed ring of typed arrays, so pushing and sampling never
 * allocate.
 */
export class InterpBuffer {
  private readonly times = new Float64Array(MAX_SAMPLES);
  /** `width` values per sample, row-major by ring slot. */
  private readonly values: Float64Array;
  /** Synthetic "hold" samples inserted across gaps carry no velocity information. */
  private readonly bridge = new Uint8Array(MAX_SAMPLES);
  private readonly width: number;
  /** Ring slot of the oldest sample. */
  private head = 0;
  private n = 0;

  constructor(
    private readonly kinds: InterpKind[],
    private readonly maxExtrapolateMs: number,
  ) {
    this.width = kinds.length;
    this.values = new Float64Array(MAX_SAMPLES * this.width);
  }

  get count(): number {
    return this.n;
  }

  get lastTime(): number {
    return this.n ? this.times[this.slot(this.n - 1)] : -Infinity;
  }

  clear(): void {
    this.head = 0;
    this.n = 0;
  }

  push(time: number, vals: ArrayLike<number>, bridgeGapMs: number): void {
    const n = this.n;
    if (n > 0) {
      const last = this.slot(n - 1);
      const lastT = this.times[last];
      if (time <= lastT) {
        // same packet / out-of-order clock estimate: overwrite the newest
        this.writeValues(last, vals);
        return;
      }
      // After a pause (entity was idle, or far-LOD throttled) hold the previous
      // value until just before this sample rather than easing across the gap.
      if (time - lastT > bridgeGapMs * 2) {
        const s = this.append(time - bridgeGapMs, 1);
        const w = this.width;
        this.values.copyWithin(s * w, last * w, last * w + w);
      }
    }
    this.writeValues(this.append(time, 0), vals);
  }

  /** Writes interpolated values for `renderTime` into `out`. Returns false if empty. */
  sample(renderTime: number, out: number[]): boolean {
    const n = this.n;
    if (n === 0) return false;
    const times = this.times;
    const values = this.values;
    const kinds = this.kinds;
    const w = this.width;

    if (n === 1 || renderTime <= times[this.head]) {
      const v = this.head * w;
      for (let k = 0; k < w; k++) out[k] = values[v + k];
      return true;
    }

    const last = this.slot(n - 1);
    if (renderTime >= times[last]) {
      const prev = this.slot(n - 2);
      const span = times[last] - times[prev];
      const ahead = Math.min(renderTime - times[last], this.maxExtrapolateMs, span);
      const f = span > 0 && span < 400 && !this.bridge[prev] ? ahead / span : 0;
      const vl = last * w;
      const vp = prev * w;
      for (let k = 0; k < w; k++) {
        const d = kinds[k] === 'angle' ? angleDelta(values[vp + k], values[vl + k]) : values[vl + k] - values[vp + k];
        out[k] = values[vl + k] + d * f;
      }
      return true;
    }

    // find bracketing pair (buffers are tiny, linear scan from the end)
    let i = n - 2;
    while (i > 0 && times[this.slot(i)] > renderTime) i--;
    const s0 = this.slot(i);
    const s1 = this.slot(i + 1);
    const f = (renderTime - times[s0]) / (times[s1] - times[s0]);
    const a = s0 * w;
    const b = s1 * w;
    for (let k = 0; k < w; k++) {
      out[k] = kinds[k] === 'angle' ? values[a + k] + angleDelta(values[a + k], values[b + k]) * f : values[a + k] + (values[b + k] - values[a + k]) * f;
    }
    // drop samples we've fully passed (keep one before renderTime)
    if (i > 1) this.drop(i - 1);
    return true;
  }

  /** Ring slot of the i-th oldest sample. */
  private slot(i: number): number {
    const s = this.head + i;
    return s < MAX_SAMPLES ? s : s - MAX_SAMPLES;
  }

  /** Claims the slot after the newest sample, evicting the oldest when full. */
  private append(time: number, bridge: number): number {
    if (this.n === MAX_SAMPLES) this.drop(1);
    const s = this.slot(this.n++);
    this.times[s] = time;
    this.bridge[s] = bridge;
    return s;
  }

  private writeValues(slot: number, vals: ArrayLike<number>): void {
    const base = slot * this.width;
    for (let k = 0; k < this.width; k++) this.values[base + k] = vals[k];
  }

  private drop(count: number): void {
    this.head = this.slot(count);
    this.n -= count;
  }
}
