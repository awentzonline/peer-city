import type * as THREE from 'three';
import { ParticleLayer, rand, type Rgba } from '../crossplay/particles';
import type { Course } from './course';

/** Peer Derby's local visual effects: rocket flames and smoke, dust, splinters, and confetti. World axes. */
export class Effects {
  private readonly glow = new ParticleLayer(900, true);
  private readonly bits = new ParticleLayer(900, false);

  constructor(
    scene: THREE.Scene,
    private readonly course: Course,
  ) {
    scene.add(this.glow.mesh, this.bits.mesh);
  }

  /** Fire out of a rocket's nozzle at (x, y, z), blowing along (dx, dy, dz), on a racer moving at (vx, vy, vz). */
  flame(x: number, y: number, z: number, dx: number, dy: number, dz: number, vx: number, vy: number, vz: number): void {
    const floor = this.course.heightAt(x, y) + 0.05;
    for (let i = 0; i < 2; i++) {
      const s = rand(5, 9);
      this.glow.emit({
        x,
        y,
        z,
        vx: vx + dx * s + rand(-0.6, 0.6),
        vy: vy + dy * s + rand(-0.6, 0.6),
        vz: vz + dz * s + rand(-0.6, 0.6),
        life: rand(0.12, 0.22),
        s0: 0.35,
        s1: 0.1,
        c0: [1, 0.75, 0.25, 0.9],
        c1: [1, 0.2, 0.05, 0],
        gravity: 0,
        drag: 2,
        floor,
      });
    }
    this.bits.emit({
      x,
      y,
      z,
      vx: vx * 0.5 + dx * 3,
      vy: vy * 0.5 + dy * 3,
      vz: vz * 0.5 + dz * 3 + 0.5,
      life: rand(0.8, 1.3),
      s0: 0.3,
      s1: 1.2,
      c0: [0.55, 0.55, 0.55, 0.45],
      c1: [0.7, 0.7, 0.7, 0],
      gravity: -0.5,
      drag: 1.5,
      floor,
    });
  }

  /** Dust kicked up behind something moving fast over the ground. */
  dust(x: number, y: number, z: number, speed: number): void {
    const floor = this.course.heightAt(x, y);
    if (z - floor > 0.6) return;
    this.bits.emit({
      x: x + rand(-0.3, 0.3),
      y: y + rand(-0.3, 0.3),
      z: floor + 0.1,
      vx: rand(-1, 1),
      vy: rand(-1, 1),
      vz: rand(0.3, 1) * Math.min(3, speed / 8),
      life: rand(0.6, 1.1),
      s0: 0.25,
      s1: 1 + speed / 20,
      c0: [0.62, 0.52, 0.38, 0.35],
      c1: [0.7, 0.62, 0.5, 0],
      gravity: -0.2,
      drag: 2,
      floor,
    });
  }

  private burst(x: number, y: number, z: number, count: number, c: Rgba, speed: number, size: number, life: number, glow = false): void {
    const floor = this.course.heightAt(x, y) + 0.02;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      (glow ? this.glow : this.bits).emit({
        x,
        y,
        z,
        vx: Math.cos(a) * rand(0.3, 1) * speed,
        vy: Math.sin(a) * rand(0.3, 1) * speed,
        vz: rand(0.2, 1) * speed,
        life: rand(life * 0.6, life),
        s0: size,
        s1: size * 0.5,
        c0: c,
        c1: [c[0], c[1], c[2], 0],
        gravity: 9.8,
        drag: 1,
        floor,
      });
    }
  }

  /** Splinters and sparks where parts tore off. */
  crash(x: number, y: number, z: number, parts: number): void {
    this.burst(x, y, z, 10 + parts * 4, [0.8, 0.62, 0.4, 1], 5, 0.08, 1);
    this.burst(x, y, z, 8 + parts * 2, [1, 0.8, 0.4, 1], 7, 0.06, 0.35, true);
  }

  /** A puff where a part was stuck on or taken off. */
  puff(x: number, y: number, z: number): void {
    this.burst(x, y, z, 8, [0.9, 0.9, 0.85, 0.7], 1.5, 0.12, 0.4);
  }

  /** Confetti over the finish line. */
  confetti(x: number, y: number, z: number): void {
    const colors: Rgba[] = [
      [1, 0.3, 0.3, 1],
      [1, 0.85, 0.2, 1],
      [0.3, 0.8, 1, 1],
      [0.5, 1, 0.4, 1],
      [1, 0.4, 0.9, 1],
    ];
    for (let i = 0; i < 60; i++) {
      const c = colors[i % colors.length];
      this.bits.emit({
        x: x + rand(-8, 8),
        y: y + rand(-8, 8),
        z: z + rand(4, 8),
        vx: rand(-2, 2),
        vy: rand(-2, 2),
        vz: rand(0, 3),
        life: rand(2, 3.5),
        s0: 0.14,
        s1: 0.12,
        c0: c,
        c1: [c[0], c[1], c[2], 0],
        gravity: 1.2,
        drag: 1.5,
        floor: this.course.heightAt(x, y) + 0.02,
      });
    }
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.bits.update(dt);
  }
}
