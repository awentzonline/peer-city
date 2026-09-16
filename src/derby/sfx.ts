import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName =
  | 'place'
  | 'unbolt'
  | 'nope'
  | 'switch'
  | 'ready'
  | 'beep'
  | 'go'
  | 'crunch'
  | 'pop'
  | 'reset'
  | 'boost'
  | 'rumble'
  | 'wind'
  | 'finish'
  | 'bump';

const RANGE: Partial<Record<SoundName, number>> = { crunch: 120, boost: 90, go: 400, finish: 200, rumble: 40, wind: 1 };

/** Peer Derby's sounds, synthesized (see crossplay/audio.ts). */
export class Sfx extends SpatialAudio {
  /** Play a sound at a world position, or in the listener's head when `at` is omitted. `volume` scales it. */
  play(name: SoundName, at?: Vec3, volume = 1): void {
    const out = this.output(at, RANGE[name] ?? 50);
    if (!out || volume <= 0.001) return;
    const v = volume;
    switch (name) {
      case 'place':
        this.noiseBurst(out, 0.9 * v, 0.07, 700, 1.4);
        this.tone(out, 0.3 * v, 0.08, 'triangle', 260, 180);
        break;
      case 'unbolt':
        this.tone(out, 0.2 * v, 0.06, 'square', 1400, 900);
        this.noiseBurst(out, 0.5 * v, 0.12, 2400, 3, 'bandpass', 0.05);
        break;
      case 'nope':
        this.tone(out, 0.18 * v, 0.14, 'square', 180, 150);
        break;
      case 'switch':
        this.noiseBurst(out, 0.2 * v, 0.03, 4000, 4);
        break;
      case 'ready':
        this.tone(out, 0.22 * v, 0.12, 'triangle', 660, 660);
        this.tone(out, 0.22 * v, 0.2, 'triangle', 990, 990, 0.1);
        break;
      case 'beep':
        this.tone(out, 0.3 * v, 0.25, 'square', 520, 520);
        break;
      case 'go':
        this.tone(out, 0.35 * v, 0.7, 'square', 1040, 1040);
        this.tone(out, 0.2 * v, 0.7, 'sawtooth', 523, 523);
        break;
      case 'crunch':
        for (let i = 0; i < 4; i++) this.noiseBurst(out, 0.9 * v, 0.12 + Math.random() * 0.1, 500 + Math.random() * 1500, 1.2, 'bandpass', i * 0.04);
        this.tone(out, 0.4 * v, 0.25, 'sawtooth', 120, 50);
        break;
      case 'pop':
        this.noiseBurst(out, 1 * v, 0.08, 1800, 0.7, 'highpass');
        break;
      case 'reset':
        this.tone(out, 0.2 * v, 0.3, 'sine', 300, 900);
        break;
      case 'boost':
        this.noiseBurst(out, 0.7 * v, 0.2, 260, 0.6, 'lowpass');
        this.noiseBurst(out, 0.25 * v, 0.2, 2200, 0.8);
        break;
      case 'rumble':
        this.noiseBurst(out, 0.45 * v, 0.16, 140 + 200 * Math.min(1, v), 0.9, 'lowpass');
        break;
      case 'wind':
        this.noiseBurst(out, 0.25 * v, 0.3, 900 + 1500 * Math.min(1, v), 0.5);
        break;
      case 'finish':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(out, 0.25 * v, 0.3, 'triangle', f, f, i * 0.12));
        break;
      case 'bump':
        this.noiseBurst(out, 0.6 * v, 0.08, 300, 1, 'lowpass');
        break;
    }
  }
}
