import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { TILE, Tile, type City } from './city';
import { facadeTexture, groundTexture, type GroundKind } from './textures';

export const SKY_TOP = 0x5b95d4;
export const SKY_HORIZON = 0xc9dcea;

function groundKind(tile: number): GroundKind | null {
  switch (tile) {
    case Tile.Road:
    case Tile.Junction:
      return 'asphalt';
    case Tile.LineH:
      return 'lineH';
    case Tile.LineV:
      return 'lineV';
    case Tile.CrossH:
      return 'crossH';
    case Tile.CrossV:
      return 'crossV';
    case Tile.Sidewalk:
      return 'sidewalk';
    case Tile.Concrete:
      return 'concrete';
    case Tile.Parking:
      return 'parking';
    case Tile.Grass:
    case Tile.Tree:
      return 'grass';
    case Tile.Path:
      return 'path';
    case Tile.Sand:
      return 'sand';
    default:
      return null; // water shows the ocean plane; buildings cover their own tiles
  }
}

class GeometryBuilder {
  readonly pos: number[] = [];
  readonly norm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  /** Quad with corners a, b, c, d counter-clockwise as seen from the front. */
  quad(corners: number[], normal: [number, number, number], uvs: number[], color?: THREE.Color): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(corners[i * 3], corners[i * 3 + 1], corners[i * 3 + 2]);
      this.norm.push(normal[0], normal[1], normal[2]);
      this.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      if (color) this.col.push(color.r, color.g, color.b);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Ground: one mesh per surface type, tiles merged into row runs with world-space UVs. */
function groundMeshes(city: City): THREE.Mesh[] {
  const builders = new Map<GroundKind, GeometryBuilder>();
  for (let ty = 0; ty < city.h; ty++) {
    let tx = 0;
    while (tx < city.w) {
      const kind = groundKind(city.tileAt(tx, ty));
      let end = tx + 1;
      while (end < city.w && groundKind(city.tileAt(end, ty)) === kind) end++;
      if (kind) {
        let b = builders.get(kind);
        if (!b) builders.set(kind, (b = new GeometryBuilder()));
        const x0 = tx * TILE;
        const x1 = end * TILE;
        const z0 = ty * TILE;
        const z1 = (ty + 1) * TILE;
        b.quad([x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0], [0, 1, 0], [tx, ty, tx, ty + 1, end, ty + 1, end, ty]);
      }
      tx = end;
    }
  }
  return [...builders].map(([kind, b]) => {
    const mesh = new THREE.Mesh(b.build(), new THREE.MeshLambertMaterial({ map: groundTexture(kind) }));
    mesh.matrixAutoUpdate = false;
    return mesh;
  });
}

const TINTS = [0x9fb8cc, 0xd9cbb0, 0xb86b52, 0xc9c3b8, 0x8f9aa3, 0xe0d6c2, 0xa89a86, 0x86927f];
const FACADE_U = 6; // meters per texture repeat (two windows)
const FACADE_V = 6.4; // two floors

function buildingMesh(city: City): THREE.Mesh {
  const b = new GeometryBuilder();
  const rnd = mulberry32(city.seed ^ 0x5eed);
  const color = new THREE.Color();
  const roof = new THREE.Color();
  for (const bd of city.buildings) {
    const x0 = bd.tx * TILE;
    const x1 = (bd.tx + bd.tw) * TILE;
    const z0 = bd.ty * TILE;
    const z1 = (bd.ty + bd.th) * TILE;
    const H = bd.height;
    color.setHex(TINTS[bd.tint % TINTS.length]).multiplyScalar(0.85 + rnd() * 0.25);
    roof.copy(color).multiplyScalar(0.62);
    const vb = H / FACADE_V;
    const lx = (x1 - x0) / FACADE_U;
    const lz = (z1 - z0) / FACADE_U;
    b.quad([x0, 0, z1, x1, 0, z1, x1, H, z1, x0, H, z1], [0, 0, 1], [0, vb, lx, vb, lx, 0, 0, 0], color);
    b.quad([x1, 0, z0, x0, 0, z0, x0, H, z0, x1, H, z0], [0, 0, -1], [0, vb, lx, vb, lx, 0, 0, 0], color);
    b.quad([x1, 0, z1, x1, 0, z0, x1, H, z0, x1, H, z1], [1, 0, 0], [0, vb, lz, vb, lz, 0, 0, 0], color);
    b.quad([x0, 0, z0, x0, 0, z1, x0, H, z1, x0, H, z0], [-1, 0, 0], [0, vb, lz, vb, lz, 0, 0, 0], color);
    b.quad([x0, H, z0, x0, H, z1, x1, H, z1, x1, H, z0], [0, 1, 0], [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02], roof);
  }
  const mesh = new THREE.Mesh(b.build(), new THREE.MeshLambertMaterial({ map: facadeTexture(), vertexColors: true }));
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function treeMeshes(city: City): THREE.InstancedMesh[] {
  const spots: [number, number][] = [];
  for (let ty = 0; ty < city.h; ty++) for (let tx = 0; tx < city.w; tx++) if (city.tileAt(tx, ty) === Tile.Tree) spots.push([tx, ty]);
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.16, 0.24, 2.6, 6).translate(0, 1.3, 0),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2b }),
    spots.length,
  );
  const canopy = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1.7, 0).translate(0, 3.7, 0),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    spots.length,
  );
  const rnd = mulberry32(city.seed ^ 0x7ee5);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const greens = [0x3f7f35, 0x4c8f3a, 0x356b2d, 0x5a9a44];
  spots.forEach(([tx, ty], i) => {
    const k = 0.8 + rnd() * 0.45;
    p.set((tx + 0.5) * TILE + (rnd() - 0.5), 0, (ty + 0.5) * TILE + (rnd() - 0.5));
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI * 2);
    s.set(k, k, k);
    m.compose(p, q, s);
    trunk.setMatrixAt(i, m);
    canopy.setMatrixAt(i, m);
    canopy.setColorAt(i, c.setHex(greens[Math.floor(rnd() * greens.length)]));
  });
  return [trunk, canopy];
}

/** The whole static scene: ground, buildings, trees, ocean, sky and lights. */
export function buildCity(city: City, scene: THREE.Scene): { sky: THREE.Mesh } {
  for (const mesh of groundMeshes(city)) scene.add(mesh);
  scene.add(buildingMesh(city));
  for (const mesh of treeMeshes(city)) scene.add(mesh);

  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2a6897 }));
  ocean.position.set(city.size / 2, -0.35, city.size / 2);
  scene.add(ocean);

  const skyGeo = new THREE.SphereGeometry(1000, 24, 12);
  const top = new THREE.Color(SKY_TOP);
  const horizon = new THREE.Color(SKY_HORIZON);
  const colors: number[] = [];
  const pos = skyGeo.getAttribute('position');
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 1000);
    tmp.copy(horizon).lerp(top, Math.pow(t, 0.6));
    colors.push(tmp.r, tmp.g, tmp.b);
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  scene.background = new THREE.Color(SKY_HORIZON);
  scene.fog = new THREE.Fog(SKY_HORIZON, 60, 260);
  scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x6a5a48, 2.2));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
  sun.position.set(0.45, 1, 0.3);
  scene.add(sun);
  return { sky };
}
