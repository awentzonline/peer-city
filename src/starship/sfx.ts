import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName =
  | 'phaser'
  | 'disruptor'
  | 'torpedo'
  | 'boom'
  | 'bigBoom'
  | 'hullHit'
  | 'shieldHit'
  | 'alert'
  | 'beam'
  | 'warpCharge'
  | 'warp'
  | 'dock'
  | 'beep'
  | 'tap'
  | 'nope'
  | 'scan'
  | 'repair'
  | 'spray'
  | 'handPhaser'
  | 'bolt'
  | 'hurt'
  | 'load'
  | 'relic'
  | 'wreck'
  | 'fire'
  | 'victory'
  | 'lost';

const RANGE: Partial<Record<SoundName, number>> = { handPhaser: 40, bolt: 40, repair: 14, spray: 14, load: 16, relic: 20, wreck: 40, fire: 10, beam: 20 };

/**
 * Peer Starship's sounds, synthesized (see crossplay/audio.ts): phasers as falling sweeps, explosions of filtered noise,
 * the red alert klaxon, the transporter's shimmer of high sines, and the drive winding up. Nothing here is a sample.
 */
export class Sfx extends SpatialAudio {
  play(name: SoundName, at?: Vec3, volume = 1): void {
    const out = this.output(at, RANGE[name] ?? 60);
    if (!out || volume <= 0.001) return;
    const v = volume;
    switch (name) {
      case 'phaser':
        this.tone(out, 0.22 * v, 0.5, 'sawtooth', 1400, 500);
        this.tone(out, 0.18 * v, 0.5, 'square', 700, 260);
        this.noiseBurst(out, 0.15 * v, 0.4, 3000, 1.5, 'bandpass');
        break;
      case 'disruptor':
        this.tone(out, 0.2 * v, 0.25, 'square', 320, 900);
        this.tone(out, 0.12 * v, 0.25, 'sawtooth', 640, 1800);
        break;
      case 'torpedo':
        this.tone(out, 0.3 * v, 0.6, 'sine', 180, 900);
        this.noiseBurst(out, 0.35 * v, 0.6, 1200, 1, 'lowpass');
        break;
      case 'boom':
        this.noiseBurst(out, 0.7 * v, 0.9, 400, 0.8, 'lowpass');
        this.tone(out, 0.5 * v, 0.7, 'sine', 90, 30);
        break;
      case 'bigBoom':
        this.noiseBurst(out, 1 * v, 2.2, 250, 0.7, 'lowpass');
        this.tone(out, 0.8 * v, 2, 'sine', 70, 20);
        this.noiseBurst(out, 0.5 * v, 1.2, 1500, 1, 'bandpass', 0.15);
        break;
      case 'hullHit':
        this.noiseBurst(out, 0.8 * v, 0.6, 300, 0.9, 'lowpass');
        this.tone(out, 0.5 * v, 0.4, 'sine', 70, 35);
        this.noiseBurst(out, 0.25 * v, 0.3, 4000, 2, 'bandpass', 0.05);
        break;
      case 'shieldHit':
        this.tone(out, 0.25 * v, 0.5, 'sine', 420, 180);
        this.noiseBurst(out, 0.3 * v, 0.4, 900, 2, 'bandpass');
        break;
      case 'alert':
        for (let i = 0; i < 2; i++) {
          this.tone(out, 0.18 * v, 0.28, 'sawtooth', 520, 520, i * 0.55);
          this.tone(out, 0.18 * v, 0.24, 'sawtooth', 780, 780, i * 0.55 + 0.25);
        }
        break;
      case 'beam':
        for (let i = 0; i < 6; i++) this.tone(out, 0.06 * v, 1.6, 'sine', 1800 + i * 330, 2400 + i * 410, i * 0.05);
        this.noiseBurst(out, 0.12 * v, 1.5, 6000, 3, 'bandpass');
        break;
      case 'warpCharge':
        this.tone(out, 0.2 * v, 1.2, 'sawtooth', 80, 320);
        break;
      case 'warp':
        this.tone(out, 0.4 * v, 1.4, 'sine', 60, 1200);
        this.noiseBurst(out, 0.6 * v, 1.2, 800, 0.8, 'lowpass', 0.2);
        break;
      case 'dock':
        this.noiseBurst(out, 0.5 * v, 0.5, 300, 1, 'lowpass');
        this.tone(out, 0.3 * v, 0.3, 'square', 120, 60, 0.1);
        break;
      case 'beep':
        this.tone(out, 0.12 * v, 0.1, 'sine', 1320, 1320);
        this.tone(out, 0.1 * v, 0.1, 'sine', 1760, 1760, 0.08);
        break;
      case 'tap':
        this.tone(out, 0.08 * v, 0.05, 'sine', 1000, 1000);
        break;
      case 'nope':
        this.tone(out, 0.14 * v, 0.2, 'square', 220, 160);
        break;
      case 'scan':
        this.tone(out, 0.12 * v, 0.6, 'sine', 600, 1800);
        this.tone(out, 0.1 * v, 0.3, 'sine', 1800, 1800, 0.6);
        break;
      case 'repair':
        this.noiseBurst(out, 0.2 * v, 0.06, 3000, 3, 'bandpass');
        this.tone(out, 0.08 * v, 0.06, 'square', 900, 700);
        break;
      case 'spray':
        this.noiseBurst(out, 0.2 * v, 0.2, 5000, 0.8, 'highpass');
        break;
      case 'handPhaser':
        this.tone(out, 0.18 * v, 0.22, 'sawtooth', 2200, 900);
        break;
      case 'bolt':
        this.tone(out, 0.2 * v, 0.2, 'square', 900, 200);
        this.noiseBurst(out, 0.15 * v, 0.15, 2000, 2, 'bandpass');
        break;
      case 'hurt':
        this.noiseBurst(out, 0.4 * v, 0.2, 700, 1, 'lowpass');
        this.tone(out, 0.25 * v, 0.2, 'triangle', 220, 110);
        break;
      case 'load':
        this.noiseBurst(out, 0.4 * v, 0.25, 500, 1, 'lowpass');
        this.tone(out, 0.2 * v, 0.1, 'square', 300, 200, 0.2);
        this.tone(out, 0.2 * v, 0.1, 'square', 400, 400, 0.35);
        break;
      case 'relic':
        for (let i = 0; i < 4; i++) this.tone(out, 0.12 * v, 0.9, 'sine', [523, 659, 784, 1046][i], [523, 659, 784, 1046][i], i * 0.1);
        break;
      case 'wreck':
        this.noiseBurst(out, 0.5 * v, 0.6, 700, 1, 'lowpass');
        this.tone(out, 0.2 * v, 0.5, 'square', 400, 60);
        break;
      case 'fire':
        this.noiseBurst(out, 0.15 * v, 0.4, 900, 0.6, 'lowpass');
        break;
      case 'victory':
        [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(out, 0.18 * v, 0.5, 'triangle', f, f, i * 0.18));
        break;
      case 'lost':
        [392, 330, 262, 196].forEach((f, i) => this.tone(out, 0.2 * v, 0.9, 'triangle', f, f * 0.98, i * 0.35));
        break;
    }
  }
}
