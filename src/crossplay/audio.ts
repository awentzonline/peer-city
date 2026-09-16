import type { Vec3 } from './math';

/** Someone else's live voice, playing from where they are in the world (see voice.ts). */
export interface VoiceSource {
  /** Move it to where the speaker is now. */
  setPosition(at: Vec3): void;
  /** 0 silences it (muted), 1 plays it normally. */
  setVolume(v: number): void;
  /** How loud they are right now, 0..1, for showing who's talking. Measured before the volume, so a muted speaker still reads. */
  level(): number;
  dispose(): void;
}

/**
 * Synthesized sound, no audio files. World sounds go through HRTF panners at their 3D position, which matters
 * a lot in a headset. A game subclasses it with the sounds it plays.
 */
export class SpatialAudio {
  protected ctx: AudioContext | null = null;
  protected master: GainNode | null = null;
  /** Voices bypass `master`, so turning the game's sound off doesn't cut the people you're talking to. */
  private voices: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  protected readonly listener: Vec3 = { x: 0, y: 0, z: 0 };
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.voices = this.ctx.createGain();
      this.voices.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  /** Where the listener's ears are, in world axes. */
  get listenerAt(): Readonly<Vec3> {
    return this.listener;
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

  /** Where to play a sound: a panner at `at` (null if that's beyond `range`), or in the listener's head without one. Null before `unlock` or while muted. */
  protected output(at: Vec3 | undefined, range: number): AudioNode | null {
    if (!this.ctx || this.muted) return null;
    if (!at) return this.master;
    const d = Math.hypot(at.x - this.listener.x, at.y - this.listener.y, at.z - this.listener.z);
    if (d > range) return null;
    const p = this.ctx.createPanner();
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

  /**
   * Play a remote voice through a panner at the speaker's position, carrying `range` meters. Null before
   * `unlock`, which is why voice only starts once the game has: it needs the audio context a gesture opened.
   */
  voice(stream: MediaStream, range: number): VoiceSource | null {
    const ctx = this.ctx;
    const out = this.voices;
    if (!ctx || !out) return null;
    // Chrome only pulls a remote track once something is playing it, so keep a silent element on the stream.
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    void sink.play().catch(() => {});

    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5;
    panner.rolloffFactor = 1.4;
    panner.maxDistance = range;
    src.connect(gain).connect(panner).connect(out);
    const level = this.meterOn(src);

    return {
      setPosition: (at) => {
        panner.positionX.value = at.x;
        panner.positionY.value = at.z;
        panner.positionZ.value = at.y;
      },
      setVolume: (v) => {
        gain.gain.value = v;
      },
      level,
      dispose: () => {
        src.disconnect();
        gain.disconnect();
        panner.disconnect();
        sink.pause();
        sink.srcObject = null;
      },
    };
  }

  /** Measure a stream that isn't played, to show whether your own microphone is picking you up. Null before `unlock`. */
  meter(stream: MediaStream): (() => number) | null {
    if (!this.ctx) return null;
    return this.meterOn(this.ctx.createMediaStreamSource(stream));
  }

  /** Loudness of a node, 0..1. An analyser with nothing downstream still runs. */
  private meterOn(node: AudioNode): () => number {
    const analyser = this.ctx!.createAnalyser();
    analyser.fftSize = 256;
    const buf = new Uint8Array(analyser.fftSize);
    node.connect(analyser);
    return () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 6);
    };
  }

  protected noiseBurst(out: AudioNode, vol: number, duration: number, freq: number, q: number, type: BiquadFilterType = 'bandpass', delay = 0): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    const t = ctx.currentTime + delay;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(gain).connect(out);
    src.start(t, Math.random() * 0.5, duration + 0.05);
  }

  protected tone(out: AudioNode, vol: number, duration: number, type: OscillatorType, f0: number, f1 = f0, delay = 0): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    const gain = ctx.createGain();
    const t = ctx.currentTime + delay;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + duration);
    if (delay > 0) gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(out);
    osc.start(ctx.currentTime);
    osc.stop(t + duration + 0.05);
  }
}
