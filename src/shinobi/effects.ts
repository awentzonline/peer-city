import type * as THREE from 'three';
import { ParticleLayer, rand } from '../crossplay/particles';

/** Peer Shinobi's local visual effects: blood, sparks off stone, dust from a fall, braziers flaring, fireflies. World axes. */
export class Effects {
  private readonly glow = new ParticleLayer(700, true);
  private readonly puffs = new ParticleLayer(700, false);

  constructor(scene: THREE.Scene) {
    scene.add(this.glow.mesh, this.puffs.mesh);
  }

  /** A spurt of blood where a blade went in. */
  blood(x: number, y: number, z: number): void {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.5, 2.2);
      this.puffs.emit({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rand(0, 2.2), life: rand(0.35, 0.7), s0: 0.07, s1: 0.03, c0: [0.45, 0.02, 0.02, 1], c1: [0.25, 0, 0, 0], gravity: 9, drag: 1, floor: 0 });
    }
  }

  /** Sparks off stone or wood where a blade struck and stuck. */
  sparks(x: number, y: number, z: number): void {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(1, 4);
      this.glow.emit({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rand(0, 3), life: rand(0.15, 0.4), s0: 0.05, s1: 0.01, c0: [1, 0.85, 0.5, 1], c1: [1, 0.4, 0.1, 0], gravity: 12, drag: 1 });
    }
  }

  /** Dust kicked up by a landing or a body hitting the ground. */
  dust(x: number, y: number, z: number): void {
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.5, 1.6);
      this.puffs.emit({ x: x + Math.cos(a) * 0.2, y: y + Math.sin(a) * 0.2, z: z + 0.05, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rand(0.1, 0.6), life: rand(0.6, 1.2), s0: 0.15, s1: 0.5, c0: [0.35, 0.33, 0.3, 0.45], c1: [0.2, 0.2, 0.2, 0], gravity: 0, drag: 2.5 });
    }
  }

  /** Braziers flaring up. */
  kindle(x: number, y: number): void {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0, 1.5);
      this.glow.emit({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, z: rand(0.8, 1.4), vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), vz: rand(1, 3), life: rand(0.5, 1.2), s0: 0.14, s1: 0.03, c0: [1, 0.7, 0.25, 1], c1: [1, 0.25, 0.05, 0], gravity: -0.5, drag: 1 });
    }
  }

  /** An ember rising off a fire: a brazier or a lantern. */
  ember(x: number, y: number, z: number): void {
    this.glow.emit({ x: x + rand(-0.15, 0.15), y: y + rand(-0.15, 0.15), z, vx: rand(-0.2, 0.2), vy: rand(-0.2, 0.2), vz: rand(0.6, 1.4), life: rand(0.6, 1.3), s0: 0.05, s1: 0.01, c0: [1, 0.65, 0.2, 1], c1: [1, 0.3, 0.05, 0], gravity: 0, drag: 0.4 });
  }

  /** A firefly blinking over the gardens. */
  firefly(x: number, y: number, z: number): void {
    this.glow.emit({ x, y, z, vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), vz: rand(-0.1, 0.2), life: rand(1.2, 2.4), s0: 0.06, s1: 0.02, c0: [0.75, 1, 0.45, 0.9], c1: [0.5, 0.9, 0.3, 0], gravity: 0, drag: 0.2 });
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.puffs.update(dt);
  }
}
