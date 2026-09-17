import type * as THREE from 'three';
import { ParticleLayer, rand, type Rgba } from '../crossplay/particles';

/** Peer Haunt's local visual effects: summoning smoke, embers off whatever's in a beam, banishing, whispers, key sparkle. World axes. */
export class Effects {
  private readonly glow = new ParticleLayer(900, true);
  private readonly smoke = new ParticleLayer(900, false);

  constructor(scene: THREE.Scene) {
    scene.add(this.glow.mesh, this.smoke.mesh);
  }

  /** Dark smoke boiling up out of the floor where something's summoned. */
  summon(x: number, y: number): void {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0, 0.9);
      this.smoke.emit({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, z: 0.05, vx: Math.cos(a) * 0.4, vy: Math.sin(a) * 0.4, vz: rand(0.6, 2.2), life: rand(0.9, 1.8), s0: 0.35, s1: 1.2, c0: [0.06, 0.03, 0.09, 0.85], c1: [0.02, 0.01, 0.03, 0], gravity: 0, drag: 1.5, floor: 0 });
    }
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      this.glow.emit({ x: x + Math.cos(a) * 0.9, y: y + Math.sin(a) * 0.9, z: 0.08, vx: -Math.cos(a) * 0.6, vy: -Math.sin(a) * 0.6, vz: 0.4, life: 0.9, s0: 0.18, s1: 0.04, c0: [0.7, 0.2, 1, 1], c1: [0.3, 0, 0.6, 0], gravity: 0, drag: 0.5 });
    }
  }

  /** Embers and smoke coming off something burning in a beam. Call every so often while it's lit. */
  embers(x: number, y: number, z: number, amount: number): void {
    const n = Math.ceil(amount * 3);
    for (let i = 0; i < n; i++) {
      this.glow.emit({ x: x + rand(-0.3, 0.3), y: y + rand(-0.3, 0.3), z: z + rand(-0.4, 0.4), vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5), vz: rand(0.6, 1.8), life: rand(0.4, 0.8), s0: 0.08, s1: 0.02, c0: [1, 0.75, 0.35, 1], c1: [1, 0.3, 0.1, 0], gravity: -0.5, drag: 1 });
      this.smoke.emit({ x: x + rand(-0.2, 0.2), y: y + rand(-0.2, 0.2), z: z + rand(0, 0.5), vx: rand(-0.2, 0.2), vy: rand(-0.2, 0.2), vz: rand(0.4, 1), life: rand(0.7, 1.2), s0: 0.2, s1: 0.7, c0: [0.25, 0.22, 0.25, 0.45], c1: [0.1, 0.1, 0.1, 0], gravity: 0, drag: 1 });
    }
  }

  /** A monster burnt away: a flash of light and ash lifting off. */
  banish(x: number, y: number, z: number, size: number): void {
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.5, 3);
      this.glow.emit({ x, y, z: z + rand(-0.5, 0.5), vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rand(0, 2.5), life: rand(0.5, 1.1), s0: 0.12 + size * 0.1, s1: 0.02, c0: [1, 0.95, 0.75, 1], c1: [1, 0.5, 0.2, 0], gravity: -0.3, drag: 2 });
    }
    for (let i = 0; i < 30; i++) {
      this.smoke.emit({ x: x + rand(-0.4, 0.4), y: y + rand(-0.4, 0.4), z: z + rand(-0.6, 0.4), vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), vz: rand(0.5, 1.6), life: rand(1.2, 2.2), s0: 0.3, s1: 1.1, c0: [0.3, 0.28, 0.3, 0.6], c1: [0.1, 0.1, 0.1, 0], gravity: 0, drag: 1 });
    }
  }

  /** A pale ripple spreading where the Haunt whispered. */
  whisper(x: number, y: number): void {
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      this.glow.emit({ x, y, z: 1.2 + rand(-0.3, 0.3), vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, vz: 0, life: 1.4, s0: 0.25, s1: 0.5, c0: [0.6, 0.7, 1, 0.35], c1: [0.4, 0.5, 1, 0], gravity: 0, drag: 1.4 });
    }
  }

  /** Golden sparks round a key. */
  sparkle(x: number, y: number, z: number): void {
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.5, 2);
      this.glow.emit({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rand(0.5, 2.5), life: rand(0.5, 1), s0: 0.1, s1: 0.02, c0: [1, 0.9, 0.4, 1], c1: [1, 0.6, 0.1, 0], gravity: 3, drag: 1.5 });
    }
  }

  /** A mote drifting off something glowing: a key on the floor, a candle. */
  mote(x: number, y: number, z: number, c: Rgba): void {
    this.glow.emit({ x: x + rand(-0.1, 0.1), y: y + rand(-0.1, 0.1), z, vx: rand(-0.1, 0.1), vy: rand(-0.1, 0.1), vz: rand(0.2, 0.5), life: rand(0.8, 1.4), s0: 0.05, s1: 0.01, c0: c, c1: [c[0], c[1], c[2], 0], gravity: 0, drag: 0.5 });
  }

  /** Dust hanging in a flashlight beam, along it from `o` in direction `d`. */
  dust(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    const t = rand(1, 8);
    const c: Rgba = [1, 0.95, 0.8, 0.25];
    this.glow.emit({ x: ox + dx * t + rand(-0.3, 0.3), y: oy + dy * t + rand(-0.3, 0.3), z: oz + dz * t + rand(-0.3, 0.3), vx: rand(-0.05, 0.05), vy: rand(-0.05, 0.05), vz: rand(-0.05, 0.05), life: rand(0.8, 1.6), s0: 0.025, s1: 0.025, c0: c, c1: [1, 0.95, 0.8, 0], gravity: 0, drag: 0 });
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.smoke.update(dt);
  }
}
