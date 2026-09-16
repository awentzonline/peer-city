import type * as THREE from 'three';
import { ParticleLayer, rand } from '../crossplay/particles';

/** Peer Walls' local visual effects: the mist of paint out of a spray can. World axes. */
export class Effects {
  private readonly mist = new ParticleLayer(1500, false);

  constructor(scene: THREE.Scene) {
    scene.add(this.mist.mesh);
  }

  /** A puff of `rgb` paint from a nozzle at (x, y, z), blowing along the unit direction (dx, dy, dz). */
  spray(x: number, y: number, z: number, dx: number, dy: number, dz: number, rgb: number): void {
    const r = ((rgb >> 16) & 255) / 255;
    const g = ((rgb >> 8) & 255) / 255;
    const b = (rgb & 255) / 255;
    for (let i = 0; i < 2; i++) {
      const s = rand(2.5, 4.5);
      this.mist.emit({
        x,
        y,
        z,
        vx: dx * s + rand(-0.35, 0.35),
        vy: dy * s + rand(-0.35, 0.35),
        vz: dz * s + rand(-0.35, 0.35),
        life: rand(0.35, 0.6),
        s0: 0.02,
        s1: rand(0.14, 0.24),
        c0: [r, g, b, 0.55],
        c1: [r, g, b, 0],
        gravity: 0.1,
        drag: 5,
      });
    }
  }

  update(dt: number): void {
    this.mist.update(dt);
  }
}
