import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName =
  | 'punch'
  | 'thump'
  | 'whoosh'
  | 'gib'
  | 'rip'
  | 'scratch'
  | 'cackle'
  | 'giggle'
  | 'squeal'
  | 'dig'
  | 'bank'
  | 'down'
  | 'hurt'
  | 'choke'
  | 'splash'
  | 'squelch'
  | 'drip'
  | 'breach'
  | 'crumble'
  | 'gush'
  | 'creak'
  | 'surge'
  | 'pump'
  | 'spray'
  | 'sputter'
  | 'full'
  | 'dive'
  | 'rich'
  | 'lost';

const RANGE: Partial<Record<SoundName, number>> = { whoosh: 8, squelch: 12, drip: 14, giggle: 20, spray: 25, pump: 12, creak: 25, gush: 40, breach: 80, surge: 1, dive: 1, rich: 1, lost: 1 };

/**
 * Sewer Lordz's sounds, synthesized (see crossplay/audio.ts): squelches, splats and cackles, nothing here is a
 * sample. `beep` is the metal detector, only ever heard by whoever holds it.
 */
export class Sfx extends SpatialAudio {
  play(name: SoundName, at?: Vec3, volume = 1): void {
    const out = this.output(at, RANGE[name] ?? 40);
    if (!out || volume <= 0.001) return;
    const v = volume;
    switch (name) {
      case 'punch':
        // a wet smack, and a yelp
        this.noiseBurst(out, 0.9 * v, 0.12, 700, 0.8, 'lowpass');
        this.tone(out, 0.5 * v, 0.12, 'sine', 140, 50);
        this.tone(out, 0.2 * v, 0.25, 'sawtooth', 900 + Math.random() * 300, 1600, 0.05);
        break;
      case 'thump':
        this.noiseBurst(out, 0.6 * v, 0.1, 500, 0.8, 'lowpass');
        this.tone(out, 0.35 * v, 0.1, 'sine', 120, 60);
        break;
      case 'whoosh':
        this.noiseBurst(out, 0.25 * v, 0.18, 1200, 1.5, 'bandpass');
        break;
      case 'gib':
        // a bursting, sloppy splat
        this.noiseBurst(out, 1.0 * v, 0.35, 400, 0.7, 'lowpass');
        this.noiseBurst(out, 0.6 * v, 0.5, 1800, 2, 'bandpass', 0.05);
        this.tone(out, 0.5 * v, 0.3, 'square', 90, 40);
        for (let i = 0; i < 4; i++) this.noiseBurst(out, 0.25 * v, 0.08, 900 + Math.random() * 900, 3, 'bandpass', 0.2 + i * 0.09);
        break;
      case 'rip':
        // cloth and worse, tearing
        for (let i = 0; i < 7; i++) this.noiseBurst(out, 0.45 * v, 0.06, 2500 + Math.random() * 2500, 2, 'bandpass', i * 0.035);
        this.noiseBurst(out, 0.8 * v, 0.4, 500, 0.8, 'lowpass', 0.22);
        this.tone(out, 0.3 * v, 0.4, 'sawtooth', 1200, 300, 0.05);
        break;
      case 'scratch':
        this.noiseBurst(out, 0.5 * v, 0.1, 3500, 2, 'highpass');
        this.noiseBurst(out, 0.4 * v, 0.08, 3000, 2, 'highpass', 0.08);
        break;
      case 'cackle':
        for (let i = 0; i < 5; i++) this.tone(out, 0.18 * v, 0.09, 'sawtooth', 700 - i * 40, 520 - i * 30, i * 0.1);
        break;
      case 'giggle':
        for (let i = 0; i < 3; i++) this.tone(out, 0.1 * v, 0.07, 'square', 820 + Math.random() * 200, 640, i * 0.09);
        break;
      case 'squeal':
        this.tone(out, 0.25 * v, 0.4, 'sawtooth', 900, 1500);
        this.tone(out, 0.12 * v, 0.4, 'square', 910, 1520, 0.02);
        break;
      case 'dig':
        this.noiseBurst(out, 0.5 * v, 0.25, 600, 1, 'lowpass');
        [988, 1318].forEach((f, i) => this.tone(out, 0.14 * v, 0.3, 'sine', f, f, 0.15 + i * 0.07));
        break;
      case 'bank':
        // ker-ching
        this.noiseBurst(out, 0.4 * v, 0.06, 5000, 2, 'highpass');
        [1318, 1760, 2093].forEach((f, i) => this.tone(out, 0.18 * v, 0.6, 'triangle', f, f, 0.05 + i * 0.06));
        break;
      case 'down':
        this.tone(out, 0.35 * v, 0.8, 'sawtooth', 500, 200);
        this.noiseBurst(out, 0.6 * v, 0.5, 400, 0.8, 'lowpass', 0.2);
        break;
      case 'hurt':
        this.tone(out, 0.5 * v, 0.2, 'square', 200, 80);
        this.noiseBurst(out, 0.4 * v, 0.12, 2500, 1.5, 'highpass');
        break;
      case 'choke':
        for (let i = 0; i < 3; i++) this.tone(out, 0.3 * v, 0.12, 'sine', 180 + Math.random() * 60, 90, i * 0.15);
        this.noiseBurst(out, 0.4 * v, 0.4, 300, 1, 'lowpass');
        break;
      case 'splash':
        this.noiseBurst(out, 0.6 * v, 0.3, 900, 0.7, 'lowpass');
        this.noiseBurst(out, 0.3 * v, 0.2, 2400, 1, 'bandpass', 0.05);
        break;
      case 'squelch':
        this.noiseBurst(out, 0.3 * v, 0.14, 350 + Math.random() * 200, 2.5, 'bandpass');
        this.tone(out, 0.06 * v, 0.1, 'sine', 180, 90);
        break;
      case 'drip':
        this.tone(out, 0.12 * v, 0.12, 'sine', 1800 + Math.random() * 800, 700);
        break;
      case 'breach':
        // a great sucking give, and the rush of water through
        this.tone(out, 0.6 * v, 1.2, 'sawtooth', 60, 30);
        this.noiseBurst(out, 0.9 * v, 1.8, 500, 0.6, 'lowpass');
        this.noiseBurst(out, 0.5 * v, 2.2, 1500, 0.8, 'bandpass', 0.4);
        break;
      case 'crumble':
        this.noiseBurst(out, 0.5 * v, 0.3, 350, 1, 'lowpass');
        this.noiseBurst(out, 0.35 * v, 0.25, 800, 1, 'bandpass', 0.2);
        break;
      case 'gush':
        this.noiseBurst(out, 0.7 * v, 1.6, 700, 0.5, 'lowpass');
        this.noiseBurst(out, 0.4 * v, 1.4, 2000, 0.6, 'bandpass', 0.1);
        break;
      case 'creak':
        this.tone(out, 0.2 * v, 0.35, 'sawtooth', 110 + Math.random() * 40, 160);
        this.tone(out, 0.1 * v, 0.3, 'square', 230, 190, 0.05);
        break;
      case 'surge':
        this.tone(out, 0.5 * v, 3, 'sawtooth', 40, 55);
        this.noiseBurst(out, 0.6 * v, 3, 250, 0.5, 'lowpass');
        break;
      case 'pump':
        // chk-chk
        this.noiseBurst(out, 0.45 * v, 0.05, 2200, 2, 'bandpass');
        this.noiseBurst(out, 0.35 * v, 0.06, 1500, 2, 'bandpass', 0.09);
        this.tone(out, 0.12 * v, 0.15, 'sine', 300, 520, 0.05);
        break;
      case 'spray':
        this.noiseBurst(out, 0.35 * v, 0.14, 3500, 0.5, 'highpass');
        break;
      case 'sputter':
        for (let i = 0; i < 3; i++) this.noiseBurst(out, 0.25 * v, 0.05, 2000, 2, 'bandpass', i * 0.08);
        break;
      case 'full':
        this.tone(out, 0.15 * v, 0.14, 'square', 180, 150);
        break;
      case 'dive':
        // a klaxon down the pipes
        for (let i = 0; i < 3; i++) this.tone(out, 0.22 * v, 0.35, 'sawtooth', 440, 330, i * 0.45);
        break;
      case 'rich':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(out, 0.2 * v, 0.6, 'triangle', f, f, i * 0.12));
        break;
      case 'lost':
        [330, 311, 294, 220].forEach((f, i) => this.tone(out, 0.2 * v, 0.8, 'sawtooth', f, f * 0.97, i * 0.3));
        break;
    }
  }

  /** The metal detector's beep, higher the nearer it is: in the holder's head only. */
  beep(strength: number): void {
    const out = this.output(undefined, 1);
    if (!out) return;
    const f = 520 + strength * 1200;
    this.tone(out, 0.1 + strength * 0.1, 0.06, 'square', f, f);
  }
}
