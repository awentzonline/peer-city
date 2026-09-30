import { SpatialAudio } from '../crossplay/audio';
import type { Vec3 } from './context';

export type SoundName = 'smack' | 'perfect' | 'combo' | 'bump' | 'slap' | 'denied' | 'tooslow' | 'awkward' | 'whoosh' | 'offer' | 'yank' | 'alert' | 'cheer' | 'join' | 'click';

const RANGE: Partial<Record<SoundName, number>> = { whoosh: 8, offer: 10, yank: 10, alert: 1, click: 1, cheer: 60 };

/**
 * High Five with Friends' sounds, synthesized (see crossplay/audio.ts): the crack of palms, the thud of knuckles, the
 * crack-and-boing of a backside, and a crowd for the big ones.
 */
export class Sfx extends SpatialAudio {
  /** Play a sound at a world position, or in the listener's head when `at` is omitted. `volume` scales it; `pitch` raises the tuned ones. */
  play(name: SoundName, at?: Vec3, volume = 1, pitch = 1): void {
    const out = this.output(at, RANGE[name] ?? 40);
    if (!out || volume <= 0.001) return;
    const v = volume;
    switch (name) {
      case 'smack':
        // palm on palm: a sharp crack over a little body
        this.noiseBurst(out, 1.1 * v, 0.06, 2600, 0.7, 'bandpass');
        this.noiseBurst(out, 0.7 * v, 0.1, 900, 0.6, 'lowpass');
        this.tone(out, 0.25 * v, 0.07, 'sine', 220, 90);
        break;
      case 'perfect':
        this.play('smack', at, volume);
        [0, 0.07, 0.14].forEach((d, i) => this.tone(out, 0.18 * v, 0.28, 'triangle', [880, 1109, 1319][i] * pitch, [880, 1109, 1319][i] * pitch, d));
        break;
      case 'combo':
        this.tone(out, 0.16 * v, 0.18, 'square', 520 * pitch, 780 * pitch);
        this.tone(out, 0.12 * v, 0.22, 'triangle', 780 * pitch, 1040 * pitch, 0.08);
        break;
      case 'bump':
        // knuckles: all thud, no crack
        this.noiseBurst(out, 0.9 * v, 0.09, 420, 0.8, 'lowpass');
        this.tone(out, 0.45 * v, 0.12, 'sine', 150, 70);
        break;
      case 'slap':
        // a crack and a wobble
        this.noiseBurst(out, 1.3 * v, 0.07, 1900, 0.6, 'bandpass');
        this.noiseBurst(out, 0.8 * v, 0.12, 700, 0.7, 'lowpass');
        this.tone(out, 0.3 * v, 0.45, 'sine', 180, 420, 0.04);
        this.tone(out, 0.18 * v, 0.35, 'sine', 420, 160, 0.3);
        break;
      case 'denied':
        this.tone(out, 0.28 * v, 0.14, 'square', 190, 170);
        this.tone(out, 0.28 * v, 0.3, 'square', 150, 120, 0.16);
        break;
      case 'tooslow':
        // a whoosh past an empty hand, and a "nyah-nyah"
        this.noiseBurst(out, 0.4 * v, 0.2, 1400, 1.2, 'bandpass');
        this.tone(out, 0.2 * v, 0.16, 'square', 660, 660, 0.18);
        this.tone(out, 0.2 * v, 0.16, 'square', 550, 550, 0.36);
        this.tone(out, 0.2 * v, 0.3, 'square', 660, 520, 0.54);
        break;
      case 'awkward':
        this.noiseBurst(out, 0.5 * v, 0.08, 500, 0.8, 'lowpass');
        this.tone(out, 0.18 * v, 0.4, 'sawtooth', 200, 140, 0.05);
        break;
      case 'whoosh':
        this.noiseBurst(out, 0.28 * v, 0.16, 1300, 1.4, 'bandpass');
        break;
      case 'offer':
        this.tone(out, 0.12 * v, 0.08, 'triangle', 700, 1000);
        break;
      case 'yank':
        this.noiseBurst(out, 0.3 * v, 0.12, 2200, 1.2, 'bandpass');
        this.tone(out, 0.1 * v, 0.1, 'triangle', 1000, 500);
        break;
      case 'alert':
        this.tone(out, 0.14 * v, 0.07, 'square', 1400, 1400);
        this.tone(out, 0.14 * v, 0.07, 'square', 1400, 1400, 0.12);
        break;
      case 'cheer':
        // a crowd's roar swelling up and dying away
        for (let i = 0; i < 6; i++) this.noiseBurst(out, 0.18 * v, 0.9 + Math.random() * 0.4, 700 + Math.random() * 900, 0.5, 'bandpass', i * 0.05);
        break;
      case 'join':
        this.tone(out, 0.18 * v, 0.12, 'triangle', 660, 660);
        this.tone(out, 0.18 * v, 0.2, 'triangle', 880, 880, 0.1);
        break;
      case 'click':
        this.tone(out, 0.12 * v, 0.04, 'square', 1800, 1400);
        break;
    }
  }
}
