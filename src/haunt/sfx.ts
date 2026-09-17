import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName =
  | 'strike'
  | 'banish'
  | 'summon'
  | 'whisper'
  | 'pickup'
  | 'socket'
  | 'scream'
  | 'hurt'
  | 'click'
  | 'flat'
  | 'gate'
  | 'bell'
  | 'heartbeat'
  | 'moan'
  | 'escape'
  | 'claimed'
  | 'nope'
  | 'order'
  | 'glare'
  | 'sizzle'
  | 'arm';

const RANGE: Partial<Record<SoundName, number>> = { strike: 40, banish: 50, summon: 35, whisper: 22, pickup: 30, socket: 60, scream: 90, moan: 26, sizzle: 20, gate: 120, bell: 1 };

/**
 * Peer Haunt's sounds, synthesized (see crossplay/audio.ts). Low drones and filtered noise: nothing here is a sample.
 * The house's own ambience (the wind, a far-off moan) is played by `Ambience` from the same voices.
 */
export class Sfx extends SpatialAudio {
  /** Play a sound at a world position, or in the listener's head when `at` is omitted. `volume` scales it. */
  play(name: SoundName, at?: Vec3, volume = 1): void {
    const out = this.output(at, RANGE[name] ?? 50);
    if (!out || volume <= 0.001) return;
    const v = volume;
    switch (name) {
      case 'strike':
        // a rush of air and a thud
        this.noiseBurst(out, 0.8 * v, 0.18, 900, 0.9, 'bandpass');
        this.tone(out, 0.5 * v, 0.2, 'sawtooth', 160, 55, 0.05);
        break;
      case 'banish':
        // a rising hiss that thins to nothing
        this.noiseBurst(out, 0.7 * v, 0.9, 2400, 0.6, 'highpass');
        this.tone(out, 0.3 * v, 0.9, 'sine', 220, 1400);
        this.tone(out, 0.18 * v, 0.9, 'triangle', 330, 2100, 0.05);
        break;
      case 'summon':
        // a low swell up out of the floor
        this.tone(out, 0.45 * v, 1.1, 'sawtooth', 40, 90);
        this.noiseBurst(out, 0.4 * v, 1.0, 300, 1.2, 'lowpass', 0.1);
        break;
      case 'whisper':
        for (let i = 0; i < 5; i++) this.noiseBurst(out, 0.35 * v, 0.12 + Math.random() * 0.2, 3000 + Math.random() * 3000, 4, 'bandpass', i * 0.16);
        break;
      case 'pickup':
        [880, 1318, 1760].forEach((f, i) => this.tone(out, 0.18 * v, 0.5, 'sine', f, f, i * 0.07));
        break;
      case 'socket':
        this.noiseBurst(out, 0.7 * v, 0.1, 500, 1.4, 'lowpass');
        [392, 523, 659].forEach((f, i) => this.tone(out, 0.2 * v, 0.9, 'triangle', f, f, 0.1 + i * 0.12));
        break;
      case 'scream':
        this.tone(out, 0.35 * v, 0.7, 'sawtooth', 700, 380);
        this.tone(out, 0.2 * v, 0.7, 'square', 715, 390, 0.02);
        this.noiseBurst(out, 0.2 * v, 0.6, 1500, 1, 'bandpass');
        break;
      case 'hurt':
        this.tone(out, 0.5 * v, 0.25, 'square', 180, 70);
        this.noiseBurst(out, 0.5 * v, 0.15, 600, 1, 'lowpass');
        break;
      case 'click':
        this.noiseBurst(out, 0.35 * v, 0.03, 4000, 3);
        this.tone(out, 0.08 * v, 0.03, 'square', 2200, 1800);
        break;
      case 'flat':
        this.noiseBurst(out, 0.3 * v, 0.03, 4000, 3);
        this.tone(out, 0.12 * v, 0.25, 'sine', 300, 120, 0.04);
        break;
      case 'gate':
        // iron hinges groaning open
        this.tone(out, 0.4 * v, 1.6, 'sawtooth', 70, 110);
        this.tone(out, 0.2 * v, 1.2, 'square', 140, 95, 0.3);
        this.noiseBurst(out, 0.3 * v, 1.4, 500, 3, 'bandpass', 0.2);
        break;
      case 'bell':
        // a distant toll
        [110, 220.5, 331, 443].forEach((f, i) => this.tone(out, (0.3 / (i + 1)) * v, 3.5 - i * 0.5, 'sine', f, f * 0.995));
        break;
      case 'heartbeat':
        this.tone(out, 0.55 * v, 0.12, 'sine', 70, 45);
        this.tone(out, 0.4 * v, 0.1, 'sine', 65, 42, 0.2);
        break;
      case 'moan':
        this.tone(out, 0.25 * v, 1.8, 'triangle', 150 + Math.random() * 40, 95);
        this.tone(out, 0.12 * v, 1.6, 'sine', 230, 160, 0.2);
        break;
      case 'escape':
        [262, 330, 392, 523].forEach((f, i) => this.tone(out, 0.2 * v, 0.6, 'triangle', f, f, i * 0.14));
        break;
      case 'claimed':
        [220, 207, 196, 147].forEach((f, i) => this.tone(out, 0.22 * v, 0.9, 'sawtooth', f, f * 0.98, i * 0.35));
        break;
      case 'nope':
        this.tone(out, 0.15 * v, 0.14, 'square', 160, 130);
        break;
      case 'order':
        this.tone(out, 0.12 * v, 0.2, 'triangle', 300, 180);
        break;
      case 'glare':
        this.noiseBurst(out, 0.6 * v, 0.5, 5000, 0.8, 'highpass');
        this.tone(out, 0.3 * v, 0.5, 'sawtooth', 900, 200);
        break;
      case 'sizzle':
        this.noiseBurst(out, 0.22 * v, 0.2, 6000, 2, 'highpass');
        break;
      case 'arm':
        this.tone(out, 0.1 * v, 0.1, 'sine', 520, 700);
        break;
    }
  }
}
