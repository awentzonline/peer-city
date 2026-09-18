import type * as THREE from 'three';
import { ParticleLayer, rand, type Rgba } from '../crossplay/particles';

const GUNK: Rgba[] = [
  [0.36, 0.44, 0.1, 1],
  [0.3, 0.38, 0.08, 1],
  [0.45, 0.3, 0.12, 1],
  [0.5, 0.12, 0.08, 1],
];

/**
 * Sewer Lordz's local visual effects: gunk bursting out of goblins, splashes in the sewage, the hose's jet and the fat
 * it blasts, water pouring from pipes and valves, and a glint when loot's banked. World axes.
 */
export class Effects {
  private readonly glow = new ParticleLayer(600, true);
  private readonly muck = new ParticleLayer(2400, false);
  /** Where the sewage's surface is, for splashes to settle on. */
  water = 0.35;

  constructor(scene: THREE.Scene) {
    scene.add(this.glow.mesh, this.muck.mesh);
  }

  /** Green-brown gunk flying from (x, y, z) along (vx, vy, vz), `n` blobs of it. */
  gunk(x: number, y: number, z: number, vx: number, vy: number, vz: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const c = GUNK[i % GUNK.length];
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.5, 3.5);
      this.muck.emit({
        x: x + rand(-0.1, 0.1),
        y: y + rand(-0.1, 0.1),
        z: z + rand(-0.1, 0.1),
        vx: vx * rand(0.3, 1) + Math.cos(a) * s,
        vy: vy * rand(0.3, 1) + Math.sin(a) * s,
        vz: vz * rand(0.3, 1) + rand(0.5, 4),
        life: rand(0.8, 1.6),
        s0: rand(0.06, 0.16),
        s1: rand(0.12, 0.3),
        c0: c,
        c1: [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, 0],
        gravity: 9,
        drag: 0.6,
        floor: this.water,
      });
    }
  }

  /** A goblin burst: a lot of gunk every way, and a cloud of stink. */
  burst(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.gunk(x, y, z + 0.7, vx * 0.3, vy * 0.3, vz * 0.3, 90);
    for (let i = 0; i < 24; i++) {
      this.muck.emit({ x: x + rand(-0.4, 0.4), y: y + rand(-0.4, 0.4), z: z + rand(0.3, 1.2), vx: rand(-0.6, 0.6), vy: rand(-0.6, 0.6), vz: rand(0.2, 0.9), life: rand(1.2, 2.4), s0: 0.3, s1: 1.1, c0: [0.3, 0.36, 0.12, 0.5], c1: [0.2, 0.24, 0.1, 0], gravity: 0, drag: 1, floor: 0 });
    }
  }

  /** Torn in two: gunk sprays out sideways from the tear, both ways. */
  tear(x: number, y: number, z: number, dx: number, dy: number): void {
    this.gunk(x, y, z + 0.65, dx * 3, dy * 3, 1, 40);
    this.gunk(x, y, z + 0.65, -dx * 3, -dy * 3, 1, 40);
  }

  /** Something broke the surface. */
  splash(x: number, y: number, z: number, size: number): void {
    const n = Math.ceil(18 * size);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.5, 2) * size;
      this.muck.emit({ x, y, z: Math.max(z, this.water), vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rand(1, 3) * size, life: rand(0.4, 0.8), s0: 0.06, s1: 0.14, c0: [0.32, 0.3, 0.14, 0.9], c1: [0.24, 0.22, 0.1, 0], gravity: 9, drag: 0.5, floor: this.water });
    }
  }

  /** The hose's jet, from `o` along unit `d`, reaching `reach` m. Call every frame it sprays. */
  jet(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number, power: number): void {
    for (let i = 0; i < 3; i++) {
      const s = rand(12, 16) * (0.6 + power * 0.4);
      this.glow.emit({
        x: ox,
        y: oy,
        z: oz,
        vx: dx * s + rand(-0.4, 0.4),
        vy: dy * s + rand(-0.4, 0.4),
        vz: dz * s + rand(-0.4, 0.4),
        life: Math.min(0.5, reach / s),
        s0: 0.04,
        s1: 0.14,
        c0: [0.55, 0.65, 0.7, 0.55],
        c1: [0.4, 0.5, 0.55, 0],
        gravity: 3,
        drag: 0.2,
        floor: -10,
      });
    }
  }

  /** Where the jet strikes fat: a spray of it flying back, grease and water. */
  blast(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      this.muck.emit({ x, y, z, vx: -dx * rand(1, 3) + Math.cos(a) * rand(0.5, 2), vy: -dy * rand(1, 3) + Math.sin(a) * rand(0.5, 2), vz: -dz * rand(1, 3) + rand(0.5, 2.5), life: rand(0.5, 1), s0: 0.05, s1: 0.1, c0: [0.85, 0.8, 0.55, 1], c1: [0.7, 0.65, 0.4, 0], gravity: 9, drag: 0.5, floor: this.water });
    }
    this.glow.emit({ x, y, z, vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5), vz: rand(0, 0.8), life: 0.5, s0: 0.2, s1: 0.5, c0: [0.4, 0.45, 0.45, 0.35], c1: [0.3, 0.3, 0.3, 0], gravity: 0, drag: 1, floor: -10 });
  }

  /** Water pouring from a pipe mouth at (x, y, z) along (dx, dy): call every frame it pours. */
  pour(x: number, y: number, z: number, dx: number, dy: number, strength: number): void {
    const n = Math.ceil(strength * 3);
    for (let i = 0; i < n; i++) {
      const s = rand(1, 2) * strength;
      this.muck.emit({ x: x + rand(-0.08, 0.08), y: y + rand(-0.08, 0.08), z: z + rand(-0.05, 0.05), vx: dx * s, vy: dy * s, vz: rand(-0.2, 0.3), life: 1.2, s0: 0.1, s1: 0.2, c0: [0.3, 0.3, 0.16, 0.8], c1: [0.25, 0.25, 0.12, 0.3], gravity: 9, drag: 0.2, floor: this.water });
    }
  }

  /** Steam hissing out of a valve as it turns. */
  steam(x: number, y: number, z: number): void {
    this.glow.emit({ x: x + rand(-0.1, 0.1), y: y + rand(-0.1, 0.1), z, vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), vz: rand(0.4, 1), life: rand(0.6, 1.1), s0: 0.1, s1: 0.5, c0: [0.35, 0.35, 0.33, 0.3], c1: [0.2, 0.2, 0.2, 0], gravity: 0, drag: 1, floor: -10 });
  }

  /** A drip from the ceiling. */
  drip(x: number, y: number, z: number): void {
    this.muck.emit({ x, y, z, vx: 0, vy: 0, vz: 0, life: 1.5, s0: 0.03, s1: 0.03, c0: [0.3, 0.32, 0.18, 0.8], c1: [0.3, 0.32, 0.18, 0.6], gravity: 9, drag: 0, floor: this.water });
  }

  /** Golden sparks, for loot. */
  sparkle(x: number, y: number, z: number): void {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.5, 2);
      this.glow.emit({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rand(0.5, 2.5), life: rand(0.5, 1), s0: 0.1, s1: 0.02, c0: [1, 0.9, 0.4, 1], c1: [1, 0.6, 0.1, 0], gravity: 3, drag: 1.5, floor: -10 });
    }
  }

  /** A glint off loot you can see. */
  glint(x: number, y: number, z: number): void {
    this.glow.emit({ x: x + rand(-0.1, 0.1), y: y + rand(-0.1, 0.1), z: z + rand(0, 0.2), vx: 0, vy: 0, vz: rand(0.1, 0.3), life: rand(0.5, 0.9), s0: 0.08, s1: 0.01, c0: [1, 0.9, 0.5, 1], c1: [1, 0.8, 0.3, 0], gravity: 0, drag: 0, floor: -10 });
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.muck.update(dt);
  }
}
