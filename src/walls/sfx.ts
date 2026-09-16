import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName = 'switch' | 'click' | 'rattle' | 'hiss' | 'squeak' | 'roll' | 'nope' | 'join';

const RANGE: Partial<Record<SoundName, number>> = { hiss: 30, rattle: 20, squeak: 12, roll: 15 };

/** Peer Walls' sounds, synthesized (see crossplay/audio.ts). */
export class Sfx extends SpatialAudio {
  /** Play a sound at a world position, or in the listener's head when `at` is omitted. `volume` scales it. */
  play(name: SoundName, at?: Vec3, volume = 1): void {
    const out = this.output(at, RANGE[name] ?? 40);
    if (!out || volume <= 0.001) return;
    const v = volume;
    switch (name) {
      case 'switch':
        this.noiseBurst(out, 0.2 * v, 0.03, 4000, 4);
        break;
      case 'click':
        this.tone(out, 0.12 * v, 0.04, 'square', 1800, 1400);
        break;
      case 'rattle':
        // the ball in a can, shaken
        for (let i = 0; i < 5; i++) this.noiseBurst(out, 0.35 * v, 0.03, 3200 + Math.random() * 1500, 6, 'bandpass', i * 0.07 + Math.random() * 0.02);
        break;
      case 'hiss':
        this.noiseBurst(out, 0.22 * v, 0.11, 6500, 0.4, 'highpass');
        break;
      case 'squeak':
        this.noiseBurst(out, 0.12 * v, 0.06, 5200, 9);
        break;
      case 'roll':
        this.noiseBurst(out, 0.3 * v, 0.12, 380, 0.8, 'lowpass');
        break;
      case 'nope':
        this.tone(out, 0.16 * v, 0.14, 'square', 180, 150);
        break;
      case 'join':
        this.tone(out, 0.18 * v, 0.12, 'triangle', 660, 660);
        this.tone(out, 0.18 * v, 0.2, 'triangle', 880, 880, 0.1);
        break;
    }
  }
}
