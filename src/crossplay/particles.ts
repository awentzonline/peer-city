import * as THREE from 'three';

/**
 * GPU billboard particles: one instanced draw call per layer, cheap enough for a headset. Coordinates are
 * world axes (x, y on the ground, z up).
 */

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute float iSize;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = iColor;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * iSize;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = vColor.a * smoothstep(1.0, 0.15, d);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

export type Rgba = [number, number, number, number];

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  /** Size at birth and death. */
  s0: number;
  s1: number;
  /** Colour at birth and death. */
  c0: Rgba;
  c1: Rgba;
  gravity: number;
  drag: number;
  /** Lowest it can fall to. */
  floor?: number;
}

export type Emit = Omit<Particle, 'age'>;

export class ParticleLayer {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly col: THREE.InstancedBufferAttribute;
  private readonly size: THREE.InstancedBufferAttribute;
  private readonly live: Particle[] = [];
  private readonly pool: Particle[] = [];

  constructor(
    private readonly max: number,
    additive: boolean,
  ) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo.setIndex(base.getIndex());
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('uv', base.getAttribute('uv'));
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.pos);
    this.geo.setAttribute('iColor', this.col);
    this.geo.setAttribute('iSize', this.size);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 6 : 5;
  }

  emit(p: Emit): void {
    if (this.live.length >= this.max) return;
    const q = this.pool.pop() ?? ({} as Particle);
    Object.assign(q, p);
    q.floor ??= 0.02;
    q.age = 0;
    this.live.push(q);
  }

  update(dt: number): void {
    const live = this.live;
    const pos = this.pos.array as Float32Array;
    const col = this.col.array as Float32Array;
    const size = this.size.array as Float32Array;
    let n = 0;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.floor = undefined;
        this.pool.push(p);
        live[i] = live[live.length - 1];
        live.pop();
        continue;
      }
      p.vz -= p.gravity * dt;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.vz *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z = Math.max(p.floor!, p.z + p.vz * dt);
      const f = p.age / p.life;
      pos[n * 3] = p.x;
      pos[n * 3 + 1] = p.z;
      pos[n * 3 + 2] = p.y;
      for (let k = 0; k < 4; k++) col[n * 4 + k] = p.c0[k] + (p.c1[k] - p.c0[k]) * f;
      size[n] = p.s0 + (p.s1 - p.s0) * f;
      n++;
    }
    this.geo.instanceCount = n;
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.size.needsUpdate = true;
  }
}

export const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
