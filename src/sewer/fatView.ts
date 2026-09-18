import * as THREE from 'three';
import type { Vec3 } from './context';
import { Junk, MAX_DENSITY, U, V, VOX, W, inGrid, junkAt, voxelHash } from './fatberg';
import type { Plug } from './plug';

/** How often the mesh may be rebuilt while it's being blasted, ms. */
const REBUILD_MS = 90;

const JUNK: Record<Junk, number> = {
  [Junk.Fat]: 0xb4a472,
  [Junk.Wipes]: 0xcfcabb,
  [Junk.Grease]: 0x9a8440,
  [Junk.Cone]: 0xff6a1a,
  [Junk.Hair]: 0x4a3620,
};

/** The six faces of a voxel: which way each faces, in voxel axes. */
const FACES: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const c = new THREE.Color();
const corner: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The fatberg as it's drawn: a cube for every voxel with anything in it, only the faces that show, coloured by what's
 * in it (fat yellowing as it's worn down, wipes, grease, hair, and the odd traffic cone) and glistening. Rebuilt from
 * the plug's grid whenever it changes.
 */
export class FatView {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;
  private version = -1;
  private nextBuild = 0;

  constructor(
    scene: THREE.Scene,
    private readonly plug: Plug,
  ) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 45, specular: 0x1a1a12 }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(now: number): void {
    if (this.plug.version === this.version || now < this.nextBuild) return;
    this.version = this.plug.version;
    this.nextBuild = now + REBUILD_MS;
    const old = this.mesh.geometry;
    this.mesh.geometry = this.build();
    old.dispose();
  }

  private build(): THREE.BufferGeometry {
    const { grid, frame } = this.plug;
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const n = new THREE.Vector3();
    const quad: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let w = 0; w < W; w++) {
      for (let v = 0; v < V; v++) {
        for (let u = 0; u < U; u++) {
          const dens = grid.get(u, v, w);
          if (!dens) continue;
          const junk = junkAt(u, v, w);
          const base = JUNK[junk];
          for (const [du, dv, dw] of FACES) {
            const nu = u + du;
            const nv = v + dv;
            const nw = w + dw;
            if (grid.solid(nu, nv, nw)) continue;
            // against the tunnel's walls, floor and ceiling nothing shows
            if (!inGrid(nu, nv, nw) && nv >= 0 && nv < V) continue;
            // the face's four corners, in voxel space, then the world
            const corners = faceCorners(u, v, w, du, dv, dw);
            for (let k = 0; k < 4; k++) {
              const [cu, cv, cw] = corners[k];
              toWorldCorner(frame.spot, cu, cv, cw, corner);
              quad[k].set(corner.x, corner.z, corner.y);
            }
            // which way the face points in the scene, and wind it to match
            toWorldCorner(frame.spot, u + 0.5 + du, v + 0.5 + dv, w + 0.5 + dw, corner);
            n.set(corner.x, corner.z, corner.y);
            toWorldCorner(frame.spot, u + 0.5, v + 0.5, w + 0.5, corner);
            n.sub(a.set(corner.x, corner.z, corner.y)).normalize();
            a.subVectors(quad[1], quad[0]);
            b.subVectors(quad[2], quad[0]);
            const flip = a.cross(b).dot(n) < 0;
            const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
            // worn fat's yellower and darker; the underside's in shadow
            const shade = (0.62 + 0.38 * (dens / MAX_DENSITY)) * (dw < 0 ? 0.55 : dw > 0 ? 1.05 : 0.85) * (0.88 + voxelHash(u, v, w, 5) * 0.2);
            c.setHex(base).multiplyScalar(shade);
            if (junk === Junk.Fat && dens < MAX_DENSITY) c.lerp(new THREE.Color(0x8a7a30), 0.25 * (MAX_DENSITY - dens));
            for (const k of order) {
              pos.push(quad[k].x, quad[k].y, quad[k].z);
              nor.push(n.x, n.y, n.z);
              col.push(c.r, c.g, c.b);
            }
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  }
}

/** A voxel-space corner in the world. */
function toWorldCorner(spot: { along: 'x' | 'y'; x0: number; y0: number; dir: 1 | -1 }, u: number, v: number, w: number, out: Vec3): Vec3 {
  const across = u * VOX;
  const along = v * VOX * spot.dir;
  if (spot.along === 'x') {
    out.x = spot.x0 + along;
    out.y = spot.y0 + across;
  } else {
    out.x = spot.x0 + across;
    out.y = spot.y0 + along;
  }
  out.z = w * VOX;
  return out;
}

/** The four corners of one face of voxel (u, v, w), going round it. */
function faceCorners(u: number, v: number, w: number, du: number, dv: number, dw: number): [number, number, number][] {
  if (du) {
    const x = du > 0 ? u + 1 : u;
    return [
      [x, v, w],
      [x, v + 1, w],
      [x, v + 1, w + 1],
      [x, v, w + 1],
    ];
  }
  if (dv) {
    const y = dv > 0 ? v + 1 : v;
    return [
      [u, y, w],
      [u + 1, y, w],
      [u + 1, y, w + 1],
      [u, y, w + 1],
    ];
  }
  const z = dw > 0 ? w + 1 : w;
  return [
    [u, v, z],
    [u + 1, v, z],
    [u + 1, v + 1, z],
    [u, v + 1, z],
  ];
}
