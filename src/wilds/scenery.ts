import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { merge, paint } from '../crossplay/models';
import { daylight, sunHeight } from './clock';
import type { Vec3 } from './context';
import { GRID, Ground, Land, ObstacleKind, SEA, SIZE } from './land';

const N = Land.samples;

const GROUND_COLORS: Record<Ground, number> = {
  [Ground.Water]: 0x8a7a55,
  [Ground.Sand]: 0xcdb57c,
  [Ground.Grass]: 0x6f9c47,
  [Ground.Forest]: 0x44703a,
  [Ground.Rock]: 0x807a70,
};

/** Sky colours at night, at dusk and by day: [top, horizon]. */
const NIGHT = [new THREE.Color(0x040914), new THREE.Color(0x0e1a30)];
const DUSK = [new THREE.Color(0x34487e), new THREE.Color(0xf09a5c)];
const DAY = [new THREE.Color(0x3f86d6), new THREE.Color(0xc9dfec)];

function terrain(land: Land): THREE.Mesh {
  const pos = new Float32Array(N * N * 3);
  const col = new Float32Array(N * N * 3);
  const c = new THREE.Color();
  const rnd = mulberry32(land.seed ^ 0x6e11);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const x = i * GRID;
      const y = j * GRID;
      pos.set([x, land.heights[k], y], k * 3);
      c.setHex(GROUND_COLORS[land.groundAt(x, y)]).multiplyScalar(0.9 + rnd() * 0.18);
      col.set([c.r, c.g, c.b], k * 3);
    }
  }
  const index = new Uint32Array((N - 1) * (N - 1) * 6);
  let n = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      index.set([a, a + N, a + 1, a + 1, a + N, a + N + 1], n);
      n += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Trees and boulders, one unit-sized model each, scaled per instance. */
function obstacleGeometry(kind: ObstacleKind): THREE.BufferGeometry {
  if (kind === ObstacleKind.Pine) {
    return merge([
      paint(new THREE.CylinderGeometry(0.03, 0.04, 0.35, 6).translate(0, 0.175, 0), 0x5b3d24),
      paint(new THREE.ConeGeometry(0.26, 0.4, 7).translate(0, 0.42, 0), 0x2f5a34),
      paint(new THREE.ConeGeometry(0.2, 0.34, 7).translate(0, 0.62, 0), 0x356a3a),
      paint(new THREE.ConeGeometry(0.13, 0.3, 7).translate(0, 0.84, 0), 0x3d7641),
    ]);
  }
  if (kind === ObstacleKind.Oak) {
    return merge([
      paint(new THREE.CylinderGeometry(0.05, 0.07, 0.6, 7).translate(0, 0.3, 0), 0x6b4a2b),
      paint(new THREE.IcosahedronGeometry(0.36, 0).translate(0, 0.72, 0), 0x4f8a3a),
      paint(new THREE.IcosahedronGeometry(0.22, 0).translate(0.18, 0.6, 0.1), 0x5a9644),
    ]);
  }
  return paint(new THREE.DodecahedronGeometry(1, 0), 0x8a857b);
}

function starField(): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
  const rnd = mulberry32(42);
  const pts: number[] = [];
  for (let i = 0; i < 900; i++) {
    const u = rnd() * Math.PI * 2;
    const v = Math.acos(rnd() * 0.95);
    pts.push(Math.sin(v) * Math.cos(u) * 900, Math.cos(v) * 900, Math.sin(v) * Math.sin(u) * 900);
  }
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }));
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  return stars;
}

/**
 * Everything static about the island (ground, water, trees and boulders) and the sky over it, which follows
 * the time of day. Felled trees are hidden as their stumps arrive.
 */
export class Scenery {
  private readonly meshes: THREE.InstancedMesh[];
  /** Each obstacle's mesh and instance. */
  private readonly slots: [number, number][] = [];
  private readonly matrices: THREE.Matrix4[] = [];
  private readonly hidden = new Set<number>();
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
  private readonly hemi = new THREE.HemisphereLight(0xe4f0ff, 0x6a5a48, 2);
  private readonly fog = new THREE.Fog(0xc9dfec, 50, 220);
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    private readonly land: Land,
    private readonly scene: THREE.Scene,
  ) {
    scene.add(terrain(land));
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x2c6d96, transparent: true, opacity: 0.82 }),
    );
    water.position.set(SIZE / 2, SEA - 0.08, SIZE / 2);
    scene.add(water);

    const kinds = [ObstacleKind.Pine, ObstacleKind.Oak, ObstacleKind.Rock];
    const counts = kinds.map((k) => land.obstacles.filter((o) => o.kind === k).length);
    this.meshes = kinds.map((k, i) => {
      const mesh = new THREE.InstancedMesh(obstacleGeometry(k), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: k !== ObstacleKind.Pine }), counts[i]);
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    });
    const used = [0, 0, 0];
    const rnd = mulberry32(land.seed ^ 0x3a11);
    const q = new THREE.Quaternion();
    const tint = new THREE.Color();
    land.obstacles.forEach((o, i) => {
      const k = o.kind;
      const slot = used[k]++;
      const m = new THREE.Matrix4();
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI * 2);
      const scale = k === ObstacleKind.Rock ? new THREE.Vector3(o.r, o.r * 0.8, o.r) : new THREE.Vector3(o.h, o.h, o.h);
      m.compose(new THREE.Vector3(o.x, o.base, o.y), q, scale);
      this.meshes[k].setMatrixAt(slot, m);
      this.meshes[k].setColorAt(slot, tint.setScalar(0.85 + rnd() * 0.3));
      this.slots[i] = [k, slot];
      this.matrices[i] = m;
    });

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 24, 12),
      new THREE.ShaderMaterial({
        uniforms: { top: { value: DAY[0].clone() }, horizon: { value: DAY[1].clone() } },
        vertexShader: 'varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader:
          'uniform vec3 top; uniform vec3 horizon; varying vec3 vPos; void main() { float h = normalize(vPos).y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : horizon * 0.8; gl_FragColor = vec4(c, 1.0); }',
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    this.stars = starField();
    scene.add(this.sky, this.stars, this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    scene.background = this.fog.color;
  }

  /** Show the sky for a time of day around the viewer's head, and hide or regrow trees to match `land.felled`. */
  update(day: number, head: Vec3): void {
    this.syncTrees();
    const light = daylight(day);
    const dusk = Math.max(0, 1 - Math.abs(sunHeight(day)) * 3.5);
    const { top, horizon } = this.sky.material.uniforms;
    (top.value as THREE.Color).copy(NIGHT[0]).lerp(DAY[0], light).lerp(DUSK[0], dusk * 0.5);
    (horizon.value as THREE.Color).copy(NIGHT[1]).lerp(DAY[1], light).lerp(DUSK[1], dusk * 0.7);
    this.fog.color.copy(horizon.value as THREE.Color);
    this.fog.far = 130 + 100 * light;
    this.stars.material.opacity = Math.max(0, 1 - light * 2.5);

    const a = (day - 0.25) * Math.PI * 2;
    const up = Math.sin(a);
    // the sun by day, the moon by night
    const dir = up > -0.05 ? new THREE.Vector3(Math.cos(a), Math.max(up, 0.05), 0.35) : new THREE.Vector3(-Math.cos(a), -up, -0.35);
    this.sun.position.set(head.x, head.z, head.y).addScaledVector(dir.normalize(), 100);
    this.sun.target.position.set(head.x, head.z, head.y);
    this.sun.intensity = 0.35 + 2.1 * light;
    this.sun.color.setHex(0xa8c0ff).lerp(new THREE.Color(0xfff0d8), light).lerp(new THREE.Color(0xffa868), dusk * light * 0.8);
    this.hemi.intensity = 0.45 + 1.6 * light;
    this.hemi.color.setHex(0x6a82b8).lerp(new THREE.Color(0xe4f0ff), light);

    this.sky.position.set(head.x, 0, head.y);
    this.stars.position.set(head.x, 0, head.y);
  }

  private syncTrees(): void {
    const { land } = this;
    let changed = false;
    for (const i of land.felled) {
      if (this.hidden.has(i)) continue;
      this.hidden.add(i);
      this.setVisible(i, false);
      changed = true;
    }
    if (this.hidden.size !== land.felled.size || changed) {
      for (const i of this.hidden) {
        if (land.felled.has(i)) continue;
        this.hidden.delete(i);
        this.setVisible(i, true);
      }
    }
  }

  private setVisible(i: number, visible: boolean): void {
    const [k, slot] = this.slots[i];
    this.meshes[k].setMatrixAt(slot, visible ? this.matrices[i] : this.zero);
    this.meshes[k].instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.sky, this.stars);
  }
}
