import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { SOLID, box, merge, paint } from '../crossplay/models';
import { disposePanel, panel, type Panel } from '../crossplay/panel';
import { GRID, HALF, Lie, N, type Course } from './course';
import type { Hud } from './hud';
import { clothGeometry, flagGeometry } from './models';

const SKY = 0xa8d8f0;
const SIZE = HALF * 2;

/** How each kind of ground is drawn, before the stripes and speckle. */
const LIE_RGB: Record<Lie, [number, number, number]> = {
  [Lie.Rough]: [74, 130, 52],
  [Lie.Fairway]: [104, 176, 70],
  [Lie.Green]: [118, 200, 84],
  [Lie.Tee]: [110, 186, 76],
  [Lie.Sand]: [232, 212, 156],
  [Lie.Water]: [60, 110, 150],
  [Lie.Out]: [62, 104, 46],
  [Lie.Path]: [176, 170, 158],
};

/**
 * A picture of the course from above, `perMeter` pixels to a meter, with (0, 0) the course's corner: the ground's
 * texture, and the base of the minimap. Mown stripes on fairways and greens, and a speckle so rough looks rough.
 */
export function paintCourse(course: Course, perMeter: number): HTMLCanvasElement {
  const n = Math.round(SIZE * perMeter);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  const px = img.data;
  const rnd = mulberry32(course.seed ^ 0x9a55);
  for (let j = 0; j < n; j++) {
    const y = (j + 0.5) / perMeter;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / perMeter;
      const lie = course.lieAt(x, y);
      const [r, g, b] = LIE_RGB[lie];
      let k = 0.94 + rnd() * 0.1;
      if (lie === Lie.Fairway) k *= Math.floor((x + y) / 9) % 2 ? 1.06 : 0.96;
      else if (lie === Lie.Green || lie === Lie.Tee) k *= Math.floor((x - y) / 3) % 2 ? 1.04 : 0.97;
      else if (lie === Lie.Rough || lie === Lie.Out) k *= 0.9 + rnd() * 0.12;
      const o = (j * n + i) * 4;
      px[o] = Math.min(255, r * k);
      px[o + 1] = Math.min(255, g * k);
      px[o + 2] = Math.min(255, b * k);
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * The course as it's drawn: sky and light, the ground (the same triangles the ball rolls and the carts drive on)
 * painted by what grows there, ponds, trees, hills beyond the boundary, the clubhouse and cart barn, and each
 * hole's tee markers, sign and flag. The board on the clubhouse shows the match.
 */
export class Scenery {
  private readonly board: Panel;
  private boardVersion = -1;
  private readonly flags: THREE.Mesh[] = [];
  private t = 0;
  /** The picture of the course the ground is painted with, for the minimap too. */
  readonly map: HTMLCanvasElement;

  constructor(
    private readonly course: Course,
    scene: THREE.Scene,
  ) {
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 260, 1300);
    scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x4d6b35, 1.35));
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.6);
    sun.position.set(-0.5, 1, 0.3);
    scene.add(sun);

    this.map = paintCourse(course, 2);
    scene.add(this.ground(), this.hills(), this.water(), ...this.trees(), this.buildings(), this.holes());

    this.board = panel(6.4, 3.2, 1024, 512, false);
    this.board.mesh.material.side = THREE.DoubleSide;
    const c = course.clubhouse;
    const cz = floorOf(course);
    const fx = c.x + Math.cos(c.heading) * (c.d / 2 + 0.06);
    const fy = c.y + Math.sin(c.heading) * (c.d / 2 + 0.06);
    this.board.mesh.position.set(fx, cz + 2.5, fy);
    this.board.mesh.rotation.y = Math.PI / 2 - c.heading;
    this.board.mesh.visible = true;
    scene.add(this.board.mesh);
  }

  /** Flags sway, and the board is redrawn when the match's news changes. */
  update(hud: Hud, dt: number): void {
    this.t += dt;
    this.flags.forEach((f, i) => (f.rotation.y = Math.sin(this.t * 1.7 + i) * 0.35 + Math.sin(this.t * 4.1 + i * 2) * 0.08));
    if (hud.version === this.boardVersion) return;
    this.boardVersion = hud.version;
    const { ctx, tex } = this.board;
    ctx.fillStyle = '#1b3a24';
    ctx.fillRect(0, 0, 1024, 512);
    ctx.strokeStyle = '#f5f0dc';
    ctx.lineWidth = 8;
    ctx.strokeRect(12, 12, 1000, 488);
    ctx.fillStyle = '#f5e6a8';
    ctx.font = 'bold 56px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('PEER GOLF CLUB', 512, 80);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px Trebuchet MS, sans-serif';
    ctx.fillText(hud.phase, 512, 130, 960);
    const lines = hud.lines.slice(0, 8);
    ctx.font = '32px Trebuchet MS, sans-serif';
    if (!lines.length) {
      ctx.fillStyle = '#c8d6c0';
      ctx.fillText("Everyone plays the same hole at once.", 512, 250);
      ctx.fillText('Club your friends. Steal their cart.', 512, 300);
    }
    lines.forEach((l, i) => {
      const y = 190 + i * 38;
      ctx.fillStyle = l.me ? '#f5e6a8' : '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(l.place, 90, y);
      ctx.fillText(l.name, 170, y, 420);
      ctx.textAlign = 'right';
      ctx.fillText(l.thru, 780, y);
      ctx.fillText(l.score, 930, y);
    });
    tex.needsUpdate = true;
  }

  dispose(): void {
    disposePanel(this.board);
  }

  /** The height grid, split into triangles the same way `Course.heightAt` splits it, painted from above. */
  private ground(): THREE.Mesh {
    const { heights } = this.course;
    const pos = new Float32Array(N * N * 3);
    const uv = new Float32Array(N * N * 2);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        pos.set([i * GRID, heights[k], j * GRID], k * 3);
        uv.set([(i * GRID) / SIZE, (j * GRID) / SIZE], k * 2);
      }
    }
    const index = new Uint32Array((N - 1) * (N - 1) * 6);
    let k = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i;
        // world triangles (a, a+1, a+N) and (a+1, a+N+1, a+N), wound the other way for the mirrored scene
        index.set([a, a + N, a + 1, a + 1, a + N, a + N + 1], k);
        k += 6;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const tex = new THREE.CanvasTexture(this.map);
    tex.colorSpace = THREE.SRGBColorSpace;
    // the picture's first row is the world's y = 0, as a texture's v = 0
    tex.flipY = false;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex }));
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Hills all round beyond the boundary, meeting the course's edge, so it's a valley rather than a tabletop. */
  private hills(): THREE.Mesh {
    const { course } = this;
    const step = 30;
    const reach = 900;
    const n = Math.round((SIZE + reach * 2) / step) + 1;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const c = new THREE.Color();
    const rnd = mulberry32(course.seed ^ 0x4111);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -reach + i * step;
        const y = -reach + j * step;
        const cx = Math.min(SIZE, Math.max(0, x));
        const cy = Math.min(SIZE, Math.max(0, y));
        const out = Math.hypot(x - cx, y - cy);
        const inside = x > 0 && x < SIZE && y > 0 && y < SIZE;
        // tucked under the course inside it; rising away outside it, from the edge's own height
        const z = inside ? course.heightAt(cx, cy) - 8 : course.heightAt(cx, cy) + (out > 0 ? out * 0.12 + Math.sin(x / 90) * Math.cos(y / 110) * Math.min(1, out / 150) * 25 + rnd() * 3 : 0);
        const k = j * n + i;
        pos.set([x, z, y], k * 3);
        c.setHex(out > 300 ? 0x3f6b30 : 0x4a7a38).multiplyScalar(0.9 + rnd() * 0.15);
        col.set([c.r, c.g, c.b], k * 3);
      }
    }
    const index: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        index.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Each pond's surface, a little wider than the water so the bank hides its edge. */
  private water(): THREE.Mesh {
    const parts: THREE.BufferGeometry[] = [];
    for (const h of this.course.holes) {
      for (const p of h.ponds) parts.push(new THREE.CircleGeometry(p.r * 1.35, 40).rotateX(-Math.PI / 2).translate(p.x, p.z, p.y));
    }
    const g = merge(parts.map((p) => paint(p, 0xffffff)));
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x3f93d0, transparent: true, opacity: 0.85, emissive: 0x0b2a44 }));
    mesh.renderOrder = 2;
    return mesh;
  }

  /** Broadleaf trees and pines, each a unit model stretched to its size. */
  private trees(): THREE.InstancedMesh[] {
    const broad = merge([
      paint(new THREE.CylinderGeometry(0.08, 0.12, 0.6, 6).translate(0, 0.3, 0), 0x6b4a2b),
      paint(new THREE.IcosahedronGeometry(1, 1).scale(0.95, 0.36, 0.95).translate(0, 0.68, 0), 0x3e7d3a),
      paint(new THREE.IcosahedronGeometry(0.7, 1).scale(0.8, 0.3, 0.8).translate(0.25, 0.86, 0.15), 0x4a8f42),
    ]);
    const pine = merge([
      paint(new THREE.CylinderGeometry(0.06, 0.1, 0.5, 6).translate(0, 0.25, 0), 0x5b3d24),
      paint(new THREE.ConeGeometry(1, 0.55, 8).translate(0, 0.55, 0), 0x2f5a34),
      paint(new THREE.ConeGeometry(0.7, 0.45, 8).translate(0, 0.85, 0), 0x3a6d3e),
    ]);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    return [broad, pine].map((geo, kind) => {
      const list = this.course.trees.filter((t) => t.kind === kind);
      const mesh = new THREE.InstancedMesh(geo, SOLID, Math.max(1, list.length));
      mesh.count = list.length;
      list.forEach((t, i) => {
        s.set(t.canopy, t.height, t.canopy);
        p.set(t.x, t.z - 0.1, t.y);
        q.setFromAxisAngle(up, (t.x * 7.1 + t.y * 3.3) % 6.28);
        mesh.setMatrixAt(i, m.compose(p, q, s));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      return mesh;
    });
  }

  /** The clubhouse, and the cart barn in front of it. */
  private buildings(): THREE.Group {
    const { course } = this;
    const group = new THREE.Group();
    const c = course.clubhouse;
    const cz = floorOf(course);
    const house = new THREE.Group();
    house.position.set(c.x, cz, c.y);
    house.rotation.y = -c.heading;
    const d = c.d;
    const w = c.w;
    const wall = 0xf1ead8;
    const parts: THREE.BufferGeometry[] = [
      box(d, 7.5, w, 0, 0.75, 0, wall),
      box(d + 0.3, 0.4, w + 0.3, 0, 0.5, 0, 0x8e8a80),
      // a pitched roof
      paint(new THREE.CylinderGeometry(0.01, d * 0.72, 2.6, 4, 1).rotateY(Math.PI / 4).scale(1, 1, (w + 1.2) / (d * 1.02)).translate(0, 5.8, 0), 0x7a3b2e),
      // a door and windows on the front, either side of the board
      box(0.1, 2.3, 1.5, d / 2 + 0.03, 1.15, w * 0.27, 0x5d4037),
      ...[-0.4, 0.4].map((f) => box(0.1, 1.3, 2.2, d / 2 + 0.03, 1.9, w * f, 0x74b9ff)),
      ...[-0.35, -0.12, 0.12, 0.35].map((f) => box(0.1, 1.1, 1.8, -d / 2 - 0.03, 2.0, w * f, 0x74b9ff)),
    ];
    const mesh = new THREE.Mesh(merge(parts), SOLID);
    house.add(mesh);
    group.add(house);

    // the barn: a long roof over the bays, open at the front so carts drive straight out
    const b = course.barn;
    const bz = course.heightAt(b.x, b.y);
    const barn = new THREE.Group();
    barn.position.set(b.x, bz, b.y);
    barn.rotation.y = -b.heading;
    const span = (b.bays.length / 2) * 3.2 + 1.6;
    const post = 0x5d4037;
    const barnParts = [box(4.2, 0.15, span * 2, -0.3, 3.75, 0, 0x2e7d32), box(4.4, 0.2, 0.2, -0.3, 3.62, span, 0xf1ead8), box(4.4, 0.2, 0.2, -0.3, 3.62, -span, 0xf1ead8)];
    for (let z = -span; z <= span + 0.01; z += span / 2) barnParts.push(box(0.2, 3.8, 0.2, -2.3, 1.9, z, post));
    barnParts.push(box(0.2, 3.8, 0.2, 1.7, 1.9, span, post), box(0.2, 3.8, 0.2, 1.7, 1.9, -span, post));
    barnParts.push(box(0.1, 0.6, span * 2, -2.3, 3.3, 0, 0xf1ead8));
    // painted bay lines on the apron
    for (let i = 0; i <= b.bays.length; i++) barnParts.push(box(2.6, 0.02, 0.1, 0, 0.03, (i - b.bays.length / 2) * 3.2, 0xffffff));
    barn.add(new THREE.Mesh(merge(barnParts), SOLID));
    group.add(barn);
    return group;
  }

  /** Every hole's tee markers and sign, and a flag in its cup. */
  private holes(): THREE.Group {
    const { course } = this;
    const group = new THREE.Group();
    const markers: THREE.BufferGeometry[] = [];
    const cloth = new THREE.MeshLambertMaterial({ color: 0xe74c3c, side: THREE.DoubleSide });
    for (const h of course.holes) {
      const { tee, pin } = h;
      const across = { x: -Math.sin(tee.heading), y: Math.cos(tee.heading) };
      for (const side of [-1, 1]) {
        const mx = tee.x + Math.cos(tee.heading) * 3 + across.x * side * 4.2;
        const my = tee.y + Math.sin(tee.heading) * 3 + across.y * side * 4.2;
        markers.push(paint(new THREE.SphereGeometry(0.12, 10, 8).translate(mx, course.heightAt(mx, my) + 0.1, my), [0xffffff, 0x2d8cf0, 0xf5c542][h.index % 3]));
      }
      // the sign, beside the tee and facing whoever walks up behind it
      const sx = tee.x - Math.cos(tee.heading) * 5 + across.x * 6;
      const sy = tee.y - Math.sin(tee.heading) * 5 + across.y * 6;
      const sz = course.heightAt(sx, sy);
      markers.push(box(0.12, 1.4, 0.12, sx, sz + 0.7, sy, 0x5d4037));
      const sign = panel(1.6, 1, 256, 160, false);
      const ctx = sign.ctx;
      ctx.fillStyle = '#1b3a24';
      ctx.fillRect(0, 0, 256, 160);
      ctx.fillStyle = '#f5e6a8';
      ctx.textAlign = 'center';
      ctx.font = 'bold 64px Georgia, serif';
      ctx.fillText(String(h.index + 1), 128, 68);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 30px Trebuchet MS, sans-serif';
      ctx.fillText(`PAR ${h.par} · ${Math.round(h.length)} m`, 128, 130);
      sign.tex.needsUpdate = true;
      sign.mesh.visible = true;
      sign.mesh.material.side = THREE.DoubleSide;
      sign.mesh.position.set(sx, sz + 1.7, sy);
      sign.mesh.rotation.y = -Math.PI / 2 - tee.heading;
      group.add(sign.mesh);

      const flag = new THREE.Mesh(flagGeometry(), SOLID);
      flag.position.set(pin.x, pin.z, pin.y);
      group.add(flag);
      const c = new THREE.Mesh(clothGeometry(), cloth);
      c.position.set(pin.x, pin.z + 2.38, pin.y);
      group.add(c);
      this.flags.push(c);
    }
    group.add(new THREE.Mesh(merge(markers), SOLID));
    return group;
  }
}

/** The clubhouse's floor: the lowest ground under it, so its walls never float. */
function floorOf(course: Course): number {
  const c = course.clubhouse;
  return Math.min(...[-1, 1].flatMap((a) => [-1, 1].map((b) => course.heightAt(c.x + a * c.w * 0.5, c.y + b * c.w * 0.5))));
}
