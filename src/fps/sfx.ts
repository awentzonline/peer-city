import type { Vec3 } from './context';

export type SoundName =
  | 'shot'
  | 'rifle'
  | 'shotgun'
  | 'sniper'
  | 'boom'
  | 'horn'
  | 'hit'
  | 'headshot'
  | 'pickup'
  | 'wasted'
  | 'busted'
  | 'crash'
  | 'door'
  | 'ricochet'
  | 'empty';

const RANGE: Partial<Record<SoundName, number>> = { boom: 400, shot: 220, rifle: 240, shotgun: 240, sniper: 380, horn: 120 };

/**
 * Tiny synthesized sound effects. No audio files. World sounds go through HRTF
 * panners at their 3D position, which matters a lot in a headset.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engineGain: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private readonly listener: Vec3 = { x: 0, y: 0, z: 0 };
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  /** Listener pose in world axes; `forward` is the look direction. */
  setListener(pos: Vec3, forward: Vec3): void {
    this.listener.x = pos.x;
    this.listener.y = pos.y;
    this.listener.z = pos.z;
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    // audio space uses the same axes as three.js: x, up, y
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.z, t);
      l.positionZ.setValueAtTime(pos.y, t);
      l.forwardX.setValueAtTime(forward.x, t);
      l.forwardY.setValueAtTime(forward.z, t);
      l.forwardZ.setValueAtTime(forward.y, t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    } else {
      l.setPosition(pos.x, pos.z, pos.y);
      l.setOrientation(forward.x, forward.z, forward.y, 0, 1, 0);
    }
  }

  private output(at: Vec3 | undefined, range: number): AudioNode | null {
    if (!at) return this.master;
    const d = Math.hypot(at.x - this.listener.x, at.y - this.listener.y, at.z - this.listener.z);
    if (d > range) return null;
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 3;
    p.rolloffFactor = 0.9;
    p.maxDistance = range;
    p.positionX.value = at.x;
    p.positionY.value = at.z;
    p.positionZ.value = at.y;
    p.connect(this.master!);
    return p;
  }

  private noiseBurst(out: AudioNode, vol: number, duration: number, freq: number, q: number, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(gain).connect(out);
    src.start(t, Math.random() * 0.5, duration + 0.05);
  }

  private tone(out: AudioNode, vol: number, duration: number, type: OscillatorType, f0: number, f1 = f0): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + duration);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** Play a sound at a world position, or in the listener's head when `at` is omitted. */
  play(name: SoundName, at?: Vec3): void {
    if (!this.ctx || this.muted) return;
    const out = this.output(at, RANGE[name] ?? 90);
    if (!out) return;
    switch (name) {
      case 'shot':
        this.noiseBurst(out, 1.4, 0.2, 1700, 0.8);
        this.tone(out, 0.45, 0.09, 'square', 170, 55);
        break;
      case 'rifle':
        this.noiseBurst(out, 1.3, 0.13, 2300, 0.9);
        this.tone(out, 0.4, 0.06, 'square', 230, 70);
        break;
      case 'shotgun':
        this.noiseBurst(out, 2.2, 0.38, 1100, 0.6, 'lowpass');
        this.tone(out, 0.6, 0.16, 'square', 120, 40);
        break;
      case 'sniper':
        this.noiseBurst(out, 1.8, 0.12, 3200, 0.8);
        this.noiseBurst(out, 1.2, 0.7, 500, 0.7, 'lowpass');
        this.tone(out, 0.55, 0.22, 'sawtooth', 160, 40);
        break;
      case 'boom':
        this.noiseBurst(out, 2.2, 1.3, 170, 0.7, 'lowpass');
        this.tone(out, 1, 0.7, 'sine', 85, 28);
        break;
      case 'crash':
        this.noiseBurst(out, 1.2, 0.28, 850, 0.5);
        break;
      case 'horn':
        this.tone(out, 0.3, 0.38, 'square', 392);
        this.tone(out, 0.24, 0.38, 'square', 494);
        break;
      case 'hit':
        this.noiseBurst(out, 0.7, 0.07, 3000, 2);
        break;
      case 'headshot':
        this.tone(out, 0.3, 0.12, 'triangle', 1400, 900);
        this.noiseBurst(out, 0.5, 0.06, 4000, 3);
        break;
      case 'ricochet':
        this.tone(out, 0.12, 0.25, 'sine', 2600, 1200);
        break;
      case 'pickup':
        this.tone(out, 0.3, 0.12, 'triangle', 880, 1320);
        break;
      case 'wasted':
        this.tone(out, 0.4, 1.4, 'sawtooth', 300, 60);
        break;
      case 'busted':
        for (let i = 0; i < 4; i++) setTimeout(() => this.ctx && this.noiseBurst(this.master!, 0.4, 0.03, 4200, 3), i * 55);
        this.tone(out, 0.22, 0.9, 'sine', 600, 1100);
        break;
      case 'door':
        this.noiseBurst(out, 0.5, 0.1, 400, 1);
        break;
      case 'empty':
        this.noiseBurst(out, 0.2, 0.03, 5000, 4);
        break;
    }
  }

  /** Our own car's engine note. */
  engine(on: boolean, speed: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.engineOsc) {
      if (!on) return;
      this.engineOsc = ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(filter).connect(this.engineGain).connect(this.master!);
      this.engineOsc.start();
    }
    const t = ctx.currentTime;
    const s = Math.min(Math.abs(speed), 40);
    this.engineOsc.frequency.setTargetAtTime(38 + s * 3.2 + ((s * 7) % 12), t, 0.08);
    this.engineGain!.gain.setTargetAtTime(on && !this.muted ? 0.07 + (s / 40) * 0.08 : 0, t, 0.1);
  }
}
