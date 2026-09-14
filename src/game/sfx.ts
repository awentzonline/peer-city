/** Tiny synthesized sound effects with distance attenuation. No audio files. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  listenerX = 0;
  listenerY = 0;
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

  private volumeAt(x: number, y: number, range: number): number {
    const d = Math.hypot(x - this.listenerX, y - this.listenerY);
    return Math.max(0, 1 - d / range);
  }

  private noiseBurst(vol: number, duration: number, freq: number, q: number, type: BiquadFilterType = 'bandpass') {
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
    src.connect(filter).connect(gain).connect(this.master!);
    src.start(t, Math.random() * 0.5, duration + 0.05);
  }

  private tone(vol: number, duration: number, type: OscillatorType, f0: number, f1 = f0) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + duration);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  play(name: 'shot' | 'boom' | 'horn' | 'hit' | 'pickup' | 'wasted' | 'busted' | 'crash' | 'door' | 'siren', x = this.listenerX, y = this.listenerY): void {
    if (!this.ctx || this.muted) return;
    const range = name === 'boom' ? 2200 : name === 'shot' ? 1400 : 900;
    const v = this.volumeAt(x, y, range);
    if (v <= 0.01) return;
    switch (name) {
      case 'shot':
        this.noiseBurst(0.9 * v, 0.18, 1800, 0.8);
        this.tone(0.3 * v, 0.08, 'square', 180, 60);
        break;
      case 'boom':
        this.noiseBurst(1.2 * v, 1.2, 180, 0.7, 'lowpass');
        this.tone(0.6 * v, 0.6, 'sine', 90, 30);
        break;
      case 'crash':
        this.noiseBurst(0.6 * v, 0.25, 900, 0.5);
        break;
      case 'horn':
        this.tone(0.18 * v, 0.35, 'square', 392);
        this.tone(0.14 * v, 0.35, 'square', 494);
        break;
      case 'hit':
        this.noiseBurst(0.4 * v, 0.07, 3000, 2);
        break;
      case 'pickup':
        this.tone(0.25 * v, 0.12, 'triangle', 880, 1320);
        break;
      case 'wasted':
        this.tone(0.35, 1.4, 'sawtooth', 300, 60);
        break;
      case 'busted':
        // handcuffs ratchet, then a siren whoop
        for (let i = 0; i < 4; i++) setTimeout(() => this.noiseBurst(0.35, 0.03, 4200, 3), i * 55);
        this.tone(0.2, 0.9, 'sine', 600, 1100);
        break;
      case 'door':
        this.noiseBurst(0.3 * v, 0.1, 400, 1);
        break;
      case 'siren':
        this.tone(0.1 * v, 0.5, 'sine', 700, 1000);
        break;
    }
  }
}
