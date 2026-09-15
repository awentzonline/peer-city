import * as THREE from 'three';
import { ParticleLayer, rand, type Rgba } from '../crossplay/particles';
import type { Rig } from '../crossplay/rig';
import { radialTexture } from '../crossplay/textures';
import { Impact } from './defs';

/**
 * Purely local visual effects, triggered by replicated state and actions. Particles are GPU billboards
 * (crossplay/particles.ts). Coordinates are world axes.
 */

class Tracers {
  readonly lines: THREE.LineSegments;
  private readonly max = 64;
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  private readonly segs: { a: number[]; life: number }[] = [];

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(this.max * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(this.max * 6), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('color', this.col);
    geo.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    this.lines.frustumCulled = false;
  }

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    if (this.segs.length >= this.max) this.segs.shift();
    this.segs.push({ a: [ax, az, ay, bx, bz, by], life: 1 });
  }

  update(dt: number): void {
    const pos = this.pos.array as Float32Array;
    const col = this.col.array as Float32Array;
    let n = 0;
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i];
      s.life -= dt * 7;
      if (s.life <= 0) {
        this.segs.splice(i, 1);
        continue;
      }
      for (let k = 0; k < 6; k++) pos[n * 6 + k] = s.a[k];
      const l = s.life;
      col.set([l * 0.4, l * 0.36, l * 0.2, l, l * 0.95, l * 0.6], n * 6); // dim tail, bright head
      n++;
    }
    this.lines.geometry.setDrawRange(0, n * 2);
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
  }
}

class Decals {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly c = new THREE.Color();

  constructor(private readonly max: number) {
    const tex = radialTexture([
      [0, 'rgba(255,255,255,0.95)'],
      [0.55, 'rgba(255,255,255,0.75)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    this.mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
      max,
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  add(x: number, y: number, size: number, color: number): void {
    this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.random() * Math.PI * 2);
    this.m.compose(new THREE.Vector3(x, 0.035, y), this.q, new THREE.Vector3(size, 1, size * (0.7 + Math.random() * 0.5)));
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.setColorAt(i, this.c.setHex(color));
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export class Effects {
  private readonly glow = new ParticleLayer(900, true);
  private readonly smokeLayer = new ParticleLayer(500, false);
  private readonly tracers = new Tracers();
  private readonly decals = new Decals(120);

  constructor(
    scene: THREE.Scene,
    private readonly rig: Rig,
  ) {
    scene.add(this.glow.mesh, this.smokeLayer.mesh, this.tracers.lines, this.decals.mesh);
  }

  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, impact: number): void {
    this.tracers.add(ax, ay, az, bx, by, bz);
    if (impact === Impact.Flesh) {
      this.spray(bx, by, bz, 8, [0.75, 0.05, 0.05, 1], 2.5, 0.07);
    } else if (impact === Impact.Metal || impact === Impact.Wall) {
      this.sparks(bx, by, bz, impact === Impact.Metal ? 8 : 4);
      if (impact === Impact.Wall) this.spray(bx, by, bz, 3, [0.55, 0.52, 0.48, 0.8], 1.2, 0.18);
    }
  }

  muzzle(x: number, y: number, z: number): void {
    this.glow.emit({ x, y, z, vx: 0, vy: 0, vz: 0, life: 0.06, s0: 0.35, s1: 0.1, c0: [1, 0.85, 0.45, 1], c1: [1, 0.6, 0.2, 0], gravity: 0, drag: 0 });
  }

  sparks(x: number, y: number, z: number, count = 10): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = rand(-0.3, 1);
      const sp = rand(2, 7);
      this.glow.emit({
        x,
        y,
        z,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        vz: up * sp,
        life: rand(0.15, 0.4),
        s0: 0.08,
        s1: 0.02,
        c0: [1, 0.95, 0.65, 1],
        c1: [1, 0.55, 0.15, 0],
        gravity: 9.8,
        drag: 1.5,
      });
    }
  }

  private spray(x: number, y: number, z: number, count: number, c: Rgba, speed: number, size: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.smokeLayer.emit({
        x,
        y,
        z,
        vx: Math.cos(a) * rand(0.3, 1) * speed,
        vy: Math.sin(a) * rand(0.3, 1) * speed,
        vz: rand(0, 1) * speed,
        life: rand(0.25, 0.5),
        s0: size,
        s1: size * 0.5,
        c0: c,
        c1: [c[0], c[1], c[2], 0],
        gravity: 9.8,
        drag: 2,
      });
    }
  }

  smoke(x: number, y: number, z: number, count = 1): void {
    for (let i = 0; i < count; i++) {
      const g = rand(0.12, 0.3);
      this.smokeLayer.emit({
        x: x + rand(-0.3, 0.3),
        y: y + rand(-0.3, 0.3),
        z,
        vx: rand(-0.4, 0.4),
        vy: rand(-0.4, 0.4),
        vz: rand(1, 2.2),
        life: rand(1.2, 2.4),
        s0: rand(0.5, 0.9),
        s1: rand(2, 3.5),
        c0: [g, g, g, 0.55],
        c1: [g, g, g, 0],
        gravity: -0.3,
        drag: 0.4,
      });
    }
  }

  fire(x: number, y: number, z: number, count = 1): void {
    for (let i = 0; i < count; i++) {
      this.glow.emit({
        x: x + rand(-0.35, 0.35),
        y: y + rand(-0.35, 0.35),
        z,
        vx: rand(-0.3, 0.3),
        vy: rand(-0.3, 0.3),
        vz: rand(1.5, 3),
        life: rand(0.3, 0.6),
        s0: rand(0.6, 1.0),
        s1: 0.15,
        c0: [1, 0.8, 0.35, 0.9],
        c1: [1, 0.3, 0.05, 0],
        gravity: -1,
        drag: 0.5,
      });
    }
  }

  explosion(x: number, y: number): void {
    this.glow.emit({ x, y, z: 1.2, vx: 0, vy: 0, vz: 0, life: 0.3, s0: 9, s1: 14, c0: [1, 0.9, 0.6, 1], c1: [1, 0.5, 0.1, 0], gravity: 0, drag: 0 });
    for (let i = 0; i < 45; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(2, 11);
      this.glow.emit({
        x,
        y,
        z: rand(0.4, 1.6),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        vz: rand(0, 1) * sp,
        life: rand(0.35, 0.9),
        s0: rand(1.2, 2.4),
        s1: rand(2.5, 4),
        c0: [1, 0.78, 0.35, 1],
        c1: [0.9, 0.2, 0.02, 0],
        gravity: -1,
        drag: 3,
      });
    }
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(1, 4);
      const g = rand(0.1, 0.25);
      this.smokeLayer.emit({
        x,
        y,
        z: rand(0.8, 2.5),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        vz: rand(1, 3.5),
        life: rand(1.8, 3.2),
        s0: rand(1.5, 2.5),
        s1: rand(5, 8),
        c0: [g, g, g, 0.7],
        c1: [g, g, g, 0],
        gravity: -0.4,
        drag: 0.7,
      });
    }
    this.sparks(x, y, 1, 30);
    this.decals.add(x, y, 6, 0x151515);
    const head = this.rig.head({ x: 0, y: 0, z: 0 });
    const d = Math.hypot(head.x - x, head.y - y);
    if (d < 60) this.rig.shake(0.35 * (1 - d / 60));
  }

  blood(x: number, y: number): void {
    this.decals.add(x, y, 1.1 + Math.random() * 0.5, 0x6a0b0b);
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.smokeLayer.update(dt);
    this.tracers.update(dt);
  }
}
