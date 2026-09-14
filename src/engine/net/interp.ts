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
 */
export class InterpBuffer {
  private times: number[] = [];
  private values: number[][] = [];
  /** Synthetic "hold" samples inserted across gaps carry no velocity information. */
  private bridge: boolean[] = [];

  constructor(
    private readonly kinds: InterpKind[],
    private readonly maxExtrapolateMs: number,
  ) {}

  get count(): number {
    return this.times.length;
  }

  get lastTime(): number {
    return this.times.length ? this.times[this.times.length - 1] : -Infinity;
  }

  clear(): void {
    this.times.length = 0;
    this.values.length = 0;
    this.bridge.length = 0;
  }

  push(time: number, vals: ArrayLike<number>, bridgeGapMs: number): void {
    const n = this.times.length;
    if (n > 0) {
      const lastT = this.times[n - 1];
      if (time <= lastT) {
        // same packet / out-of-order clock estimate: overwrite the newest
        this.values[n - 1] = Array.from(vals);
        return;
      }
      // After a pause (entity was idle, or far-LOD throttled) hold the previous
      // value until just before this sample rather than easing across the gap.
      if (time - lastT > bridgeGapMs * 2) {
        this.times.push(time - bridgeGapMs);
        this.values.push(this.values[n - 1].slice());
        this.bridge.push(true);
      }
    }
    this.times.push(time);
    this.values.push(Array.from(vals));
    this.bridge.push(false);
    if (this.times.length > MAX_SAMPLES) this.drop(this.times.length - MAX_SAMPLES);
  }

  private drop(count: number): void {
    this.times.splice(0, count);
    this.values.splice(0, count);
    this.bridge.splice(0, count);
  }

  /** Writes interpolated values for `renderTime` into `out`. Returns false if empty. */
  sample(renderTime: number, out: number[]): boolean {
    const times = this.times;
    const n = times.length;
    if (n === 0) return false;
    const kinds = this.kinds;

    if (renderTime <= times[0] || n === 1) {
      const v = n === 1 || renderTime <= times[0] ? this.values[0] : this.values[n - 1];
      for (let k = 0; k < kinds.length; k++) out[k] = v[k];
      return true;
    }

    const last = n - 1;
    if (renderTime >= times[last]) {
      const vl = this.values[last];
      const vp = this.values[last - 1];
      const span = times[last] - times[last - 1];
      const ahead = Math.min(renderTime - times[last], this.maxExtrapolateMs, span);
      const f = span > 0 && span < 400 && !this.bridge[last - 1] ? ahead / span : 0;
      for (let k = 0; k < kinds.length; k++) {
        const d = kinds[k] === 'angle' ? angleDelta(vp[k], vl[k]) : vl[k] - vp[k];
        out[k] = vl[k] + d * f;
      }
      return true;
    }

    // find bracketing pair (buffers are tiny, linear scan from the end)
    let i = last - 1;
    while (i > 0 && times[i] > renderTime) i--;
    const t0 = times[i];
    const t1 = times[i + 1];
    const a = this.values[i];
    const b = this.values[i + 1];
    const f = (renderTime - t0) / (t1 - t0);
    for (let k = 0; k < kinds.length; k++) {
      out[k] = kinds[k] === 'angle' ? a[k] + angleDelta(a[k], b[k]) * f : a[k] + (b[k] - a[k]) * f;
    }
    // drop samples we've fully passed (keep one before renderTime)
    if (i > 1) this.drop(i - 1);
    return true;
  }
}
