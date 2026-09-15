import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName =
  | 'chop'
  | 'fell'
  | 'swish'
  | 'hit'
  | 'hurt'
  | 'bite'
  | 'howl'
  | 'twang'
  | 'draw'
  | 'thunk'
  | 'till'
  | 'sow'
  | 'harvest'
  | 'eat'
  | 'sizzle'
  | 'ignite'
  | 'crackle'
  | 'pickup'
  | 'switch'
  | 'died';

const RANGE: Partial<Record<SoundName, number>> = { fell: 160, howl: 260, chop: 90, twang: 70, crackle: 18, sizzle: 12 };

/** Peer Wilds' sounds, synthesized (see crossplay/audio.ts). */
export class Sfx extends SpatialAudio {
  /** Play a sound at a world position, or in the listener's head when `at` is omitted. */
  play(name: SoundName, at?: Vec3): void {
    const out = this.output(at, RANGE[name] ?? 50);
    if (!out) return;
    switch (name) {
      case 'chop':
        this.noiseBurst(out, 1.1, 0.09, 900, 1.2);
        this.tone(out, 0.35, 0.08, 'triangle', 190, 120);
        break;
      case 'fell':
        for (let i = 0; i < 5; i++) this.noiseBurst(out, 0.35, 0.08, 1600 - i * 200, 2, 'bandpass', i * 0.09);
        this.noiseBurst(out, 1.6, 0.9, 160, 0.7, 'lowpass', 0.55);
        this.tone(out, 0.6, 0.5, 'sine', 70, 35, 0.55);
        break;
      case 'swish':
        this.noiseBurst(out, 0.25, 0.14, 2600, 1.5);
        break;
      case 'hit':
        this.noiseBurst(out, 0.8, 0.08, 700, 1.5);
        break;
      case 'hurt':
        this.tone(out, 0.3, 0.18, 'sawtooth', 220, 110);
        break;
      case 'bite':
        this.noiseBurst(out, 0.7, 0.1, 1200, 2);
        this.tone(out, 0.3, 0.14, 'sawtooth', 160, 90);
        break;
      case 'howl':
        this.tone(out, 0.2, 1.6, 'sine', 420, 640);
        this.tone(out, 0.12, 1.4, 'sine', 640, 380, 1.4);
        break;
      case 'twang':
        this.tone(out, 0.3, 0.25, 'triangle', 180, 150);
        this.noiseBurst(out, 0.35, 0.12, 3000, 1.2);
        break;
      case 'draw':
        this.tone(out, 0.07, 0.5, 'sawtooth', 70, 95);
        break;
      case 'thunk':
        this.noiseBurst(out, 0.6, 0.06, 500, 1.5);
        this.tone(out, 0.2, 0.05, 'triangle', 240, 180);
        break;
      case 'till':
        this.noiseBurst(out, 0.7, 0.18, 380, 0.8, 'lowpass');
        break;
      case 'sow':
        this.noiseBurst(out, 0.25, 0.1, 2200, 2);
        break;
      case 'harvest':
        this.noiseBurst(out, 0.5, 0.14, 600, 1, 'lowpass');
        this.tone(out, 0.2, 0.12, 'triangle', 520, 780, 0.08);
        break;
      case 'eat':
        for (let i = 0; i < 3; i++) this.noiseBurst(out, 0.4, 0.05, 1800, 1.5, 'bandpass', i * 0.12);
        break;
      case 'sizzle':
        this.noiseBurst(out, 0.2, 0.35, 5200, 0.6, 'highpass');
        break;
      case 'ignite':
        this.noiseBurst(out, 0.7, 0.6, 900, 0.5, 'lowpass');
        break;
      case 'crackle':
        for (let i = 0; i < 3; i++) this.noiseBurst(out, 0.18 + Math.random() * 0.2, 0.02, 3000 + Math.random() * 2000, 3, 'bandpass', Math.random() * 0.4);
        break;
      case 'pickup':
        this.tone(out, 0.25, 0.1, 'triangle', 660, 990);
        break;
      case 'switch':
        this.noiseBurst(out, 0.2, 0.03, 4000, 4);
        break;
      case 'died':
        this.tone(out, 0.35, 1.4, 'sine', 330, 110);
        break;
    }
  }
}
