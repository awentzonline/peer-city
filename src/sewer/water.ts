import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { SOLID, merge, paint } from '../crossplay/models';
import { Cell, SIZE, type SewerMap } from './sewer';

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform float uSurge;
uniform vec3 uLamp;
uniform vec3 uLampDir;
varying vec3 vWorld;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.1 + vec2(3.1, 1.7);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 p = vWorld.xz;
  float t = uTime * (1.0 + uSurge * 2.5);
  // scum drifting two ways, and slow brown swirls under it
  float scum = fbm(p * 0.9 + vec2(t * 0.07, t * 0.03));
  float swirl = fbm(p * 0.35 - vec2(t * 0.02, -t * 0.045));
  float froth = smoothstep(0.62, 0.8, fbm(p * 2.3 + vec2(-t * 0.1, t * 0.06)));
  vec3 deep = vec3(0.085, 0.07, 0.035);
  vec3 murk = vec3(0.2, 0.18, 0.07);
  vec3 slime = vec3(0.24, 0.3, 0.07);
  vec3 col = mix(deep, murk, swirl);
  col = mix(col, slime, smoothstep(0.45, 0.75, scum) * 0.6);
  col += vec3(0.22, 0.2, 0.12) * froth * (0.5 + uSurge);
  // a greasy sheen where your lamp catches it
  vec3 toLamp = normalize(uLamp - vWorld);
  float ripple = fbm(p * 3.0 + t * 0.2) - 0.5;
  vec3 n = normalize(vec3(ripple * 0.35, 1.0, fbm(p * 3.0 - t * 0.17) * 0.35 - 0.17));
  vec3 h = normalize(toLamp + normalize(cameraPosition - vWorld));
  float spec = pow(max(dot(n, h), 0.0), 60.0);
  float cone = smoothstep(0.75, 0.95, dot(-toLamp, uLampDir));
  float near = 1.0 / (1.0 + 0.12 * dot(uLamp - vWorld, uLamp - vWorld));
  col += vec3(0.55, 0.5, 0.3) * spec * cone * near * 2.0;
  col += vec3(0.2, 0.18, 0.08) * cone * near * 0.5;
  // rainbow oil where the scum's thin
  float oil = smoothstep(0.3, 0.5, scum) * (1.0 - smoothstep(0.5, 0.6, scum));
  col += 0.025 * oil * vec3(sin(p.x * 3.0 + t), sin(p.y * 3.0 + 2.0), sin((p.x + p.y) * 2.0 + 4.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/**
 * The sewage: an opaque brown-green surface over the whole sewer at the water's height, so nothing under it can be
 * seen. It swirls and froths (harder in a surge), and shines greasily where a lamp catches it. Junk floats on it: paper,
 * and worse, bobbing along. Your view goes brown when your head's under.
 */
export class Sewage {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly floaters: THREE.InstancedMesh;
  private readonly bits: { x: number; y: number; vx: number; vy: number; spin: number; phase: number }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private t = 0;
  level = 0.35;

  constructor(
    scene: THREE.Scene,
    private readonly map: SewerMap,
  ) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1).rotateX(-Math.PI / 2).translate(SIZE / 2, 0, SIZE / 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uTime: { value: 0 }, uSurge: { value: 0 }, uLamp: { value: new THREE.Vector3() }, uLampDir: { value: new THREE.Vector3(0, -1, 0) } },
      ]),
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);

    // junk bobbing along in the channels
    const rnd = mulberry32(map.seed ^ 0x77);
    const junk = merge([
      paint(new THREE.BoxGeometry(0.22, 0.02, 0.16), 0xe8e2c8),
      paint(new THREE.BoxGeometry(0.12, 0.03, 0.1).translate(0.18, 0, 0.1), 0xd8d2b8),
    ]);
    const count = 140;
    this.floaters = new THREE.InstancedMesh(junk, SOLID, count);
    const colors = [0xe8e2c8, 0x6a4a22, 0xc8c8a8, 0x4a3a1a, 0xb8a060];
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 50; tries++) {
        x = rnd() * SIZE;
        y = rnd() * SIZE;
        if (map.cellAt(x, y) === Cell.Channel) break;
      }
      const a = rnd() * Math.PI * 2;
      const speed = 0.05 + rnd() * 0.12;
      this.bits.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, spin: (rnd() - 0.5) * 0.4, phase: rnd() * 10 });
      this.floaters.setColorAt(i, c.setHex(colors[i % colors.length]));
    }
    this.floaters.frustumCulled = false;
    scene.add(this.floaters);
  }

  /** Where the surface is, how rough, and where the local lamp shines from. */
  update(dt: number, level: number, surge: boolean, lamp: THREE.Vector3, lampDir: THREE.Vector3): void {
    this.t += dt;
    this.level += (level - this.level) * Math.min(1, dt * 3);
    const u = this.mesh.material.uniforms;
    u.uTime.value = this.t;
    u.uSurge.value += ((surge ? 1 : 0) - u.uSurge.value) * Math.min(1, dt);
    u.uLamp.value.copy(lamp);
    u.uLampDir.value.copy(lampDir);
    this.mesh.position.y = this.level;
    const k = surge ? 4 : 1;
    this.bits.forEach((b, i) => {
      const nx = b.x + b.vx * dt * k;
      const ny = b.y + b.vy * dt * k;
      // bounce off the walkways and walls
      if (this.map.cellAt(nx, b.y) !== Cell.Channel && this.level < 0.5) b.vx = -b.vx;
      else if (this.map.solid(Math.floor(nx), Math.floor(b.y))) b.vx = -b.vx;
      else b.x = nx;
      if (this.map.cellAt(b.x, ny) !== Cell.Channel && this.level < 0.5) b.vy = -b.vy;
      else if (this.map.solid(Math.floor(b.x), Math.floor(ny))) b.vy = -b.vy;
      else b.y = ny;
      b.phase += dt;
      this.e.set(Math.sin(b.phase * 1.3) * 0.12, b.phase * b.spin, Math.sin(b.phase * 0.9) * 0.1);
      this.q.setFromEuler(this.e);
      this.v.set(b.x, this.level + 0.01 + Math.sin(b.phase * 2) * 0.01, b.y);
      this.m.compose(this.v, this.q, this.one);
      this.floaters.setMatrixAt(i, this.m);
    });
    this.floaters.instanceMatrix.needsUpdate = true;
  }
}
