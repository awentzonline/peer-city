import { SpatialAudio } from '../crossplay/audio';
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

/** Peer City's sounds, synthesized (see crossplay/audio.ts). */
export class Sfx extends SpatialAudio {
  private engineGain: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;

  /** Play a sound at a world position, or in the listener's head when `at` is omitted. */
  play(name: SoundName, at?: Vec3): void {
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
        for (let i = 0; i < 4; i++) this.noiseBurst(this.master!, 0.4, 0.03, 4200, 3, 'bandpass', i * 0.055);
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
