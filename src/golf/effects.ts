import type * as THREE from 'three';
import { ParticleLayer, rand, type Rgba } from '../crossplay/particles';
import { Lie, type Course } from './course';

/** Peer Golf's local visual effects: divots and sand, splashes, crashes, stars round a clubbed head, confetti. World axes. */
export class Effects {
  private readonly glow = new ParticleLayer(600, true);
  private readonly bits = new ParticleLayer(1200, false);

  constructor(
    scene: THREE.Scene,
    private readonly course: Course,
  ) {
    scene.add(this.glow.mesh, this.bits.mesh);
  }

  private burst(x: number, y: number, z: number, count: number, c: Rgba, speed: number, size: number, life: number, opts: { glow?: boolean; up?: number; gravity?: number; along?: { x: number; y: number } } = {}): void {
    const floor = this.course.heightAt(x, y) + 0.02;
    const layer = opts.glow ? this.glow : this.bits;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.3, 1) * speed;
      layer.emit({
        x,
        y,
        z,
        vx: Math.cos(a) * s + (opts.along?.x ?? 0) * rand(0.5, 1),
        vy: Math.sin(a) * s + (opts.along?.y ?? 0) * rand(0.5, 1),
        vz: rand(0.2, 1) * speed * (opts.up ?? 1),
        life: rand(life * 0.6, life),
        s0: size,
        s1: size * 0.5,
        c0: c,
        c1: [c[0], c[1], c[2], 0],
        gravity: opts.gravity ?? 9.8,
        drag: 1,
        floor,
      });
    }
  }

  /** Turf, sand or nothing at all kicked up where a ball was struck, flying off along `heading`. */
  strike(x: number, y: number, z: number, lie: Lie, heading: number, power: number): void {
    const along = { x: Math.cos(heading) * 3 * power, y: Math.sin(heading) * 3 * power };
    if (lie === Lie.Sand) this.burst(x, y, z, 26, [0.9, 0.82, 0.6, 0.9], 2.2, 0.1, 0.9, { along, up: 1.4 });
    else if (lie === Lie.Rough) this.burst(x, y, z, 10, [0.3, 0.5, 0.2, 1], 1.8, 0.06, 0.7, { along });
    else if (lie !== Lie.Green && power > 0.3) this.burst(x, y, z, 8, [0.4, 0.62, 0.28, 1], 1.5, 0.05, 0.6, { along });
  }

  splash(x: number, y: number, z: number): void {
    this.burst(x, y, z, 30, [0.85, 0.93, 1, 0.9], 3, 0.09, 0.9, { up: 1.8 });
    this.burst(x, y, z + 0.05, 10, [1, 1, 1, 0.6], 0.8, 0.3, 0.6, { gravity: 0 });
  }

  /** Sparks and bits of plastic where carts hit something. */
  crash(x: number, y: number, z: number, power: number): void {
    this.burst(x, y, z, Math.round(10 + power * 16), [0.95, 0.95, 0.9, 1], 4 + power * 2, 0.07, 0.9);
    this.burst(x, y, z, Math.round(6 + power * 8), [1, 0.8, 0.35, 1], 6, 0.05, 0.35, { glow: true });
  }

  /** Stars round the head of whoever was clubbed. */
  stars(x: number, y: number, z: number): void {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.glow.emit({
        x: x + Math.cos(a) * 0.25,
        y: y + Math.sin(a) * 0.25,
        z: z + rand(-0.1, 0.2),
        vx: Math.cos(a + 1.4) * 1.6,
        vy: Math.sin(a + 1.4) * 1.6,
        vz: rand(0.2, 0.8),
        life: rand(0.6, 1),
        s0: 0.16,
        s1: 0.05,
        c0: [1, 0.92, 0.3, 1],
        c1: [1, 0.6, 0.1, 0],
        gravity: 0,
        drag: 2,
      });
    }
  }

  /** A few dizzy stars circling above someone lying flat. Call now and then while they're down. */
  dizzy(x: number, y: number, z: number, t: number): void {
    const a = t * 5;
    this.glow.emit({ x: x + Math.cos(a) * 0.3, y: y + Math.sin(a) * 0.3, z, vx: 0, vy: 0, vz: 0.1, life: 0.35, s0: 0.12, s1: 0.04, c0: [1, 0.95, 0.4, 1], c1: [1, 0.8, 0.2, 0], gravity: 0, drag: 0 });
  }

  /** Dust behind a moving cart's wheels. */
  dust(x: number, y: number, speed: number, lie: Lie): void {
    const floor = this.course.heightAt(x, y);
    const c: Rgba = lie === Lie.Sand ? [0.9, 0.82, 0.6, 0.4] : lie === Lie.Path ? [0.7, 0.7, 0.68, 0.25] : [0.45, 0.55, 0.35, 0.22];
    this.bits.emit({ x: x + rand(-0.2, 0.2), y: y + rand(-0.2, 0.2), z: floor + 0.1, vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5), vz: rand(0.2, 0.6) * Math.min(2, speed / 5), life: rand(0.5, 0.9), s0: 0.2, s1: 0.8, c0: c, c1: [c[0], c[1], c[2], 0], gravity: -0.2, drag: 2, floor });
  }

  /** Confetti over a holed ball. */
  confetti(x: number, y: number, z: number): void {
    const colors: Rgba[] = [
      [1, 0.3, 0.3, 1],
      [1, 0.85, 0.2, 1],
      [0.3, 0.8, 1, 1],
      [0.5, 1, 0.4, 1],
      [1, 0.4, 0.9, 1],
    ];
    for (let i = 0; i < 50; i++) {
      const c = colors[i % colors.length];
      this.bits.emit({
        x: x + rand(-1.5, 1.5),
        y: y + rand(-1.5, 1.5),
        z: z + rand(2, 4),
        vx: rand(-2, 2),
        vy: rand(-2, 2),
        vz: rand(0, 3),
        life: rand(1.8, 3),
        s0: 0.1,
        s1: 0.09,
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
