import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName =
  | 'whoosh'
  | 'twang'
  | 'stab'
  | 'swish'
  | 'steps'
  | 'land'
  | 'clatter'
  | 'fall'
  | 'shout'
  | 'thrust'
  | 'bell'
  | 'cry'
  | 'pickup'
  | 'gong'
  | 'kindle'
  | 'hurt'
  | 'grip'
  | 'spotted'
  | 'takedown'
  | 'escape'
  | 'defeat'
  | 'nope'
  | 'order'
  | 'arm'
  | 'ping'
  | 'dawn';

const RANGE: Partial<Record<SoundName, number>> = { whoosh: 25, twang: 45, stab: 25, swish: 12, steps: 22, land: 30, clatter: 40, fall: 35, shout: 50, thrust: 25, cry: 60, pickup: 12, kindle: 40 };

/**
 * Peer Shinobi's sounds, synthesized (see crossplay/audio.ts): whooshes and thuds made of filtered noise, a temple bell
 * and gong from stacked sines. Nothing here is a sample.
 */
export class Sfx extends SpatialAudio {
  /** Play a sound at a world position, or in the listener's head when `at` is omitted. `volume` scales it. */
  play(name: SoundName, at?: Vec3, volume = 1): void {
    const out = this.output(at, RANGE[name] ?? 60);
    if (!out || volume <= 0.001) return;
    const v = volume;
    switch (name) {
      case 'whoosh':
        this.noiseBurst(out, 0.45 * v, 0.22, 1800, 1.5, 'bandpass');
        this.noiseBurst(out, 0.25 * v, 0.16, 3500, 2, 'bandpass', 0.05);
        break;
      case 'twang':
        this.tone(out, 0.3 * v, 0.25, 'triangle', 190, 120);
        this.noiseBurst(out, 0.25 * v, 0.2, 2400, 2, 'bandpass', 0.02);
        break;
      case 'stab':
        this.noiseBurst(out, 0.6 * v, 0.08, 900, 1, 'lowpass');
        this.tone(out, 0.35 * v, 0.12, 'sine', 140, 60);
        break;
      case 'swish':
        this.noiseBurst(out, 0.3 * v, 0.15, 2600, 1.2, 'bandpass');
        break;
      case 'steps':
        this.noiseBurst(out, 0.35 * v, 0.05, 700, 1, 'lowpass');
        this.noiseBurst(out, 0.28 * v, 0.05, 800, 1, 'lowpass', 0.16);
        break;
      case 'land':
        this.noiseBurst(out, 0.6 * v, 0.12, 400, 1, 'lowpass');
        this.tone(out, 0.35 * v, 0.15, 'sine', 90, 50);
        break;
      case 'clatter':
        [2800, 3400, 2300].forEach((f, i) => this.tone(out, 0.12 * v, 0.12, 'square', f, f * 0.9, i * 0.06));
        this.noiseBurst(out, 0.3 * v, 0.1, 5000, 3, 'bandpass');
        break;
      case 'fall':
        this.noiseBurst(out, 0.7 * v, 0.25, 350, 1, 'lowpass');
        this.tone(out, 0.3 * v, 0.3, 'sine', 70, 40, 0.05);
        break;
      case 'shout': {
        // a gruff call, pitched a little differently each time so a second one doesn't grate
        const f = 230 + Math.random() * 50;
        this.tone(out, 0.2 * v, 0.4, 'sawtooth', f, f * 0.78);
        this.tone(out, 0.1 * v, 0.4, 'triangle', f * 1.5, f * 1.15, 0.02);
        this.noiseBurst(out, 0.08 * v, 0.35, 900, 1, 'bandpass');
        break;
      }
      case 'thrust':
        this.noiseBurst(out, 0.45 * v, 0.14, 1100, 1, 'bandpass');
        this.tone(out, 0.2 * v, 0.1, 'triangle', 320, 180, 0.03);
        break;
      case 'bell':
        // a temple bell, rung again and again
        for (let k = 0; k < 4; k++) [220, 440.5, 661, 993].forEach((f, i) => this.tone(out, (0.22 / (i + 1)) * v, 1.6 - i * 0.2, 'sine', f, f * 0.998, k * 0.9));
        break;
      case 'cry':
        this.tone(out, 0.3 * v, 0.6, 'sawtooth', 520, 300);
        this.noiseBurst(out, 0.15 * v, 0.5, 1400, 1, 'bandpass');
        break;
      case 'pickup':
        this.tone(out, 0.12 * v, 0.08, 'triangle', 1600, 2100);
        break;
      case 'gong':
        [98, 147, 196.5, 262].forEach((f, i) => this.tone(out, (0.35 / (i + 1)) * v, 4 - i * 0.6, 'sine', f, f * 0.99));
        this.noiseBurst(out, 0.2 * v, 0.6, 300, 1, 'lowpass');
        break;
      case 'kindle':
        this.noiseBurst(out, 0.5 * v, 0.7, 900, 0.6, 'lowpass');
        this.noiseBurst(out, 0.2 * v, 0.5, 4000, 1, 'highpass', 0.1);
        break;
      case 'hurt':
        this.tone(out, 0.45 * v, 0.2, 'square', 200, 80);
        this.noiseBurst(out, 0.4 * v, 0.12, 600, 1, 'lowpass');
        break;
      case 'grip':
        this.noiseBurst(out, 0.2 * v, 0.06, 1500, 2, 'bandpass');
        break;
      case 'spotted':
        // the sting when a guard sees you
        this.tone(out, 0.2 * v, 0.35, 'sawtooth', 880, 1320);
        this.tone(out, 0.12 * v, 0.35, 'square', 887, 1330);
        break;
      case 'takedown':
        this.tone(out, 0.12 * v, 0.3, 'sine', 330, 247);
        break;
      case 'escape':
        [392, 494, 587, 784].forEach((f, i) => this.tone(out, 0.18 * v, 0.6, 'triangle', f, f, i * 0.13));
        break;
      case 'defeat':
        [294, 277, 262, 196].forEach((f, i) => this.tone(out, 0.2 * v, 0.9, 'sawtooth', f, f * 0.98, i * 0.33));
        break;
      case 'nope':
        this.tone(out, 0.15 * v, 0.14, 'square', 160, 130);
        break;
      case 'order':
        this.tone(out, 0.12 * v, 0.14, 'triangle', 520, 700);
        break;
      case 'arm':
        this.tone(out, 0.1 * v, 0.1, 'sine', 520, 700);
        break;
      case 'ping':
        this.tone(out, 0.08 * v, 0.25, 'sine', 1200, 900);
        break;
      case 'dawn':
        [262, 330, 392].forEach((f, i) => this.tone(out, 0.15 * v, 1.2, 'sine', f, f, i * 0.2));
        break;
    }
  }
}
