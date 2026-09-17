import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName =
  | 'thwack'
  | 'putt'
  | 'swish'
  | 'bonk'
  | 'oof'
  | 'crash'
  | 'splash'
  | 'tock'
  | 'lip'
  | 'cup'
  | 'switch'
  | 'door'
  | 'motor'
  | 'tick'
  | 'fanfare'
  | 'nope';

const RANGE: Partial<Record<SoundName, number>> = { thwack: 160, crash: 140, splash: 120, bonk: 90, cup: 60, fanfare: 1, motor: 40, tick: 1 };

/** Peer Golf's sounds, synthesized (see crossplay/audio.ts). */
export class Sfx extends SpatialAudio {
  /** Play a sound at a world position, or in the listener's head when `at` is omitted. `volume` scales it. */
  play(name: SoundName, at?: Vec3, volume = 1): void {
    const out = this.output(at, RANGE[name] ?? 50);
    if (!out || volume <= 0.001) return;
    const v = volume;
    switch (name) {
      case 'thwack':
        // a sharp click off the face, and the ball's whistle away
        this.noiseBurst(out, 1.1 * v, 0.05, 3200, 1.1, 'highpass');
        this.tone(out, 0.35 * v, 0.07, 'triangle', 1400, 700);
        this.noiseBurst(out, 0.18 * v, 0.35, 5000, 6, 'bandpass', 0.05);
        break;
      case 'putt':
        this.tone(out, 0.3 * v, 0.06, 'sine', 900, 700);
        this.noiseBurst(out, 0.3 * v, 0.04, 2000, 2);
        break;
      case 'swish':
        this.noiseBurst(out, 0.5 * v, 0.22, 1800, 1.4, 'bandpass');
        break;
      case 'bonk':
        this.tone(out, 0.6 * v, 0.18, 'sine', 420, 140);
        this.noiseBurst(out, 0.7 * v, 0.06, 900, 1.2, 'lowpass');
        break;
      case 'oof':
        this.tone(out, 0.35 * v, 0.22, 'sawtooth', 220, 110);
        this.noiseBurst(out, 0.25 * v, 0.15, 500, 1, 'lowpass');
        break;
      case 'crash':
        for (let i = 0; i < 3; i++) this.noiseBurst(out, 0.9 * v, 0.14 + Math.random() * 0.12, 400 + Math.random() * 1400, 1.1, 'bandpass', i * 0.05);
        this.tone(out, 0.35 * v, 0.3, 'square', 150, 60);
        break;
      case 'splash':
        this.noiseBurst(out, 0.9 * v, 0.4, 1200, 0.6, 'lowpass');
        this.noiseBurst(out, 0.4 * v, 0.25, 3500, 1.5, 'bandpass', 0.06);
        break;
      case 'tock':
        this.tone(out, 0.45 * v, 0.08, 'triangle', 700, 500);
        this.noiseBurst(out, 0.3 * v, 0.05, 1500, 3);
        break;
      case 'lip':
        this.tone(out, 0.3 * v, 0.12, 'sine', 1300, 900);
        this.tone(out, 0.2 * v, 0.1, 'sine', 900, 1200, 0.08);
        break;
      case 'cup':
        // the rattle of the ball dropping in
        this.tone(out, 0.4 * v, 0.1, 'triangle', 1100, 800);
        this.tone(out, 0.3 * v, 0.08, 'triangle', 950, 750, 0.09);
        this.tone(out, 0.2 * v, 0.07, 'triangle', 850, 700, 0.16);
        break;
      case 'switch':
        this.noiseBurst(out, 0.25 * v, 0.04, 3000, 3);
        this.tone(out, 0.1 * v, 0.04, 'triangle', 1800, 1600);
        break;
      case 'door':
        this.noiseBurst(out, 0.6 * v, 0.09, 600, 1.2, 'lowpass');
        this.tone(out, 0.15 * v, 0.1, 'square', 300, 200);
        break;
      case 'motor':
        // an electric cart's whine, higher the faster it goes
        this.tone(out, 0.07 * Math.min(1, v + 0.3), 0.14, 'sawtooth', 110 + 260 * Math.min(1, v), 110 + 270 * Math.min(1, v));
        break;
      case 'tick':
        this.tone(out, 0.25 * v, 0.08, 'square', 880, 880);
        break;
      case 'fanfare':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(out, 0.22 * v, 0.28, 'triangle', f, f, i * 0.11));
        break;
      case 'nope':
        this.tone(out, 0.18 * v, 0.14, 'square', 180, 150);
        break;
    }
  }
}
