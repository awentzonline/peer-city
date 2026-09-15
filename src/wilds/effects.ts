import type * as THREE from 'three';
import { ParticleLayer, rand, type Rgba } from '../crossplay/particles';
import type { Land } from './land';

/** Peer Wilds' local visual effects: dirt, wood chips, blood, flames and smoke. World axes. */
export class Effects {
  private readonly glow = new ParticleLayer(700, true);
  private readonly bits = new ParticleLayer(700, false);

  constructor(
    scene: THREE.Scene,
    private readonly land: Land,
  ) {
    scene.add(this.glow.mesh, this.bits.mesh);
  }

  private burst(x: number, y: number, z: number, count: number, c: Rgba, speed: number, size: number, gravity = 9.8, life = 0.6): void {
    const floor = this.land.heightAt(x, y) + 0.02;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.bits.emit({
        x,
        y,
        z,
        vx: Math.cos(a) * rand(0.3, 1) * speed,
        vy: Math.sin(a) * rand(0.3, 1) * speed,
        vz: rand(0.3, 1) * speed,
        life: rand(life * 0.6, life),
        s0: size,
        s1: size * 0.6,
        c0: c,
        c1: [c[0], c[1], c[2], 0],
        gravity,
        drag: 1.5,
        floor,
      });
    }
  }

  /** Soil thrown up by a hoe or a pulled crop. */
  dirt(x: number, y: number, z: number): void {
    this.burst(x, y, z + 0.05, 14, [0.33, 0.22, 0.12, 1], 2.2, 0.09);
  }

  /** An axe biting into wood, or into an animal. */
  chips(x: number, y: number, z: number, wood: boolean): void {
    if (wood) this.burst(x, y, z, 10, [0.82, 0.66, 0.42, 1], 3, 0.05, 9.8, 0.8);
    else this.blood(x, y, z);
  }

  blood(x: number, y: number, z: number): void {
    this.burst(x, y, z, 10, [0.6, 0.04, 0.04, 1], 2.4, 0.06, 9.8, 0.5);
  }

  flame(x: number, y: number, z: number, strength = 1): void {
    this.glow.emit({
      x: x + rand(-0.25, 0.25),
      y: y + rand(-0.25, 0.25),
      z,
      vx: rand(-0.15, 0.15),
      vy: rand(-0.15, 0.15),
      vz: rand(0.8, 1.8),
      life: rand(0.35, 0.7),
      s0: rand(0.35, 0.6) * strength,
      s1: 0.08,
      c0: [1, 0.72, 0.3, 0.95],
      c1: [1, 0.25, 0.05, 0],
      gravity: -0.6,
      drag: 0.5,
    });
  }

  ember(x: number, y: number, z: number): void {
    this.glow.emit({ x, y, z, vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), vz: rand(1, 2.5), life: rand(0.8, 1.6), s0: 0.04, s1: 0.01, c0: [1, 0.6, 0.2, 1], c1: [1, 0.3, 0, 0], gravity: -0.2, drag: 0.3 });
  }

  smoke(x: number, y: number, z: number): void {
    const g = rand(0.2, 0.35);
    this.bits.emit({
      x: x + rand(-0.2, 0.2),
      y: y + rand(-0.2, 0.2),
      z,
      vx: rand(-0.2, 0.2),
      vy: rand(-0.2, 0.2),
      vz: rand(0.6, 1.2),
      life: rand(2, 3.5),
      s0: rand(0.3, 0.5),
      s1: rand(1.5, 2.5),
      c0: [g, g, g, 0.35],
      c1: [g, g, g, 0],
      gravity: -0.15,
      drag: 0.3,
    });
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.bits.update(dt);
  }
}
