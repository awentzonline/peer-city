import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { SOLID, box, merge, paint } from '../crossplay/models';
import { disposePanel, panel, type Panel } from '../crossplay/panel';
import { BAYS, BAY_SIZE, CHECKPOINT_SPACING, Course, EDGE, FINISH, GARAGE, HALF_WIDTH, LENGTH, TOP } from './course';
import type { Hud } from './hud';

const SKY = 0xa9d6f5;
/** Where the red and white curbs start, either side of the track. */
const CURB = 7;

/**
 * The hill as it's drawn: sky and light, the ground by the track (the same ribbon the physics rolls on), the
 * valley around it, the garage with its numbered bays, start and finish gates, checkpoint flags and trees, and
 * the board in the garage that shows the race.
 */
export class Scenery {
  private readonly board: Panel;
  private boardVersion = -1;

  constructor(
    private readonly course: Course,
    scene: THREE.Scene,
  ) {
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 160, 900);
    scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x5b6b3a, 1.3));
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.7);
    sun.position.set(-0.4, 1, 0.35);
    scene.add(sun);

    scene.add(this.ground(), this.valley(), this.garage(), this.gates(), this.trees());
    for (let i = 0; i < BAYS; i++) scene.add(this.bayNumber(i));

    this.board = panel(12, 6, 1024, 512, false);
    this.board.mesh.material.side = THREE.DoubleSide;
    this.board.mesh.position.set(-60, TOP + 5.5, 0);
    this.board.mesh.rotation.y = -Math.PI / 2;
    this.board.mesh.visible = true;
    scene.add(this.board.mesh);
    const legs = new THREE.Mesh(merge([box(0.4, 5.5, 0.4, 0, 2.75, -5.6, 0x4a4f57), box(0.4, 5.5, 0.4, 0, 2.75, 5.6, 0x4a4f57), box(0.3, 6.4, 12.4, 0.2, 5.5, 0, 0x2d3436)]), SOLID);
    legs.position.set(-60, TOP, 0);
    scene.add(legs);
  }

  /** Redraw the race board when the race's news changes. */
  update(hud: Hud): void {
    if (hud.version === this.boardVersion) return;
    this.boardVersion = hud.version;
    const { ctx, tex } = this.board;
    ctx.fillStyle = '#1e272e';
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = '#f5c542';
    ctx.font = 'bold 64px Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PEER DERBY', 512, 78);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px Trebuchet MS, sans-serif';
    ctx.fillText(hud.phase, 512, 136, 980);
    ctx.textAlign = 'left';
    ctx.font = '34px Trebuchet MS, sans-serif';
    const lines = hud.lines.slice(0, 8);
    if (!lines.length) {
      ctx.fillStyle = '#b2bec3';
      ctx.textAlign = 'center';
      ctx.fillText('Build a racer in your bay, then get ready to race.', 512, 260);
      ctx.fillText('Friends can help build yours: grab the part gun.', 512, 310);
    }
    lines.forEach((l, i) => {
      const y = 200 + i * 40;
      ctx.fillStyle = l.me ? '#f5c542' : '#fff';
      ctx.fillText(l.place, 120, y);
      ctx.fillText(l.name, 230, y, 440);
      ctx.textAlign = 'right';
      ctx.fillText(l.detail, 900, y);
      ctx.textAlign = 'left';
    });
    tex.needsUpdate = true;
  }

  dispose(): void {
    disposePanel(this.board);
  }

  /** The ribbon of ground by the track: a dirt track with curbs, grassy walls, stripes to judge speed by, and jumps. */
  private ground(): THREE.Mesh {
    const { course } = this;
    const { positions, indices, lats, rows, columns } = course.ribbon(1);
    const pos = new Float32Array(positions.length);
    const col = new Float32Array(positions.length);
    const c = new THREE.Color();
    const rnd = mulberry32(course.seed ^ 0x51de);
    const jumps = course.jumps;
    for (let r = 0; r < rows; r++) {
      const u = r;
      const stripe = Math.floor(u / 10) % 2 === 0;
      const kicker = jumps.some((j) => u >= j - 18 && u <= j);
      const checker = Math.abs(u - FINISH) <= 2;
      for (let k = 0; k < columns; k++) {
        const i = r * columns + k;
        pos[i * 3] = positions[i * 3];
        pos[i * 3 + 1] = positions[i * 3 + 2];
        pos[i * 3 + 2] = positions[i * 3 + 1];
        const a = Math.abs(lats[i]);
        if (checker && a <= HALF_WIDTH) c.setHex((Math.floor(lats[i] / 2) + r) % 2 === 0 ? 0x111111 : 0xffffff);
        else if (a < CURB) c.setHex(kicker ? 0xd9a441 : stripe ? 0xb8976a : 0xad8c60);
        else if (a <= HALF_WIDTH + 0.4) c.setHex(r % 4 < 2 ? 0xd63031 : 0xf5f6fa);
        else if (a < 20) c.setHex(0x6f9c47);
        else c.setHex(0x5e8a3c);
        c.multiplyScalar(0.93 + rnd() * 0.1);
        col.set([c.r, c.g, c.b], i * 3);
      }
    }
    // the scene is mirrored from world axes, so flip the winding to keep faces pointing up
    const tris = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i += 3) {
      tris[i] = indices[i];
      tris[i + 1] = indices[i + 2];
      tris[i + 2] = indices[i + 1];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(tris, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Hillsides all around, so the track runs down a valley rather than through the sky. */
  private valley(): THREE.Mesh {
    const { course } = this;
    const step = 30;
    const x0 = GARAGE.x0 - 300;
    const x1 = LENGTH + 300;
    const y0 = -600;
    const y1 = 600;
    const nx = Math.ceil((x1 - x0) / step) + 1;
    const ny = Math.ceil((y1 - y0) / step) + 1;
    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    const c = new THREE.Color();
    const rnd = mulberry32(course.seed ^ 0xa11e);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * step;
        const y = y0 + j * step;
        let z: number;
        let d: number;
        if (x <= GARAGE.x1 + 20) {
          const dx = Math.max(0, GARAGE.x0 - x, x - GARAGE.x1);
          const dy = Math.max(0, GARAGE.y0 - y, y - GARAGE.y1);
          d = Math.hypot(dx, dy);
          z = TOP - 3 - Math.min(d, 60) * 0.5 + Math.max(0, d - 60) * 0.3;
        } else {
          const u = Math.min(LENGTH, Math.max(0, x));
          const p = course.pointAt(u, 0);
          d = Math.abs(y - p.y);
          z = d < EDGE + 8 ? p.z - 6 : p.z + 14 + (d - EDGE) * 0.35;
        }
        z += (rnd() - 0.5) * 4;
        const k = j * nx + i;
        pos.set([x, z, y], k * 3);
        c.setHex(d > 250 ? 0x4f7a34 : 0x5f8c40).multiplyScalar(0.9 + rnd() * 0.15);
        col.set([c.r, c.g, c.b], k * 3);
      }
    }
    const index: number[] = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        index.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** The garage: a concrete yard, painted bays, a fence round the edge, and workbenches. */
  private garage(): THREE.Mesh {
    const w = GARAGE.x1 - GARAGE.x0;
    const d = GARAGE.y1 - GARAGE.y0;
    const cx = (GARAGE.x0 + GARAGE.x1) / 2;
    const cy = (GARAGE.y0 + GARAGE.y1) / 2;
    const parts: THREE.BufferGeometry[] = [box(w, 4, d, cx, TOP - 2, cy, 0x8e9396)];
    for (let i = 0; i < BAYS; i++) {
      const b = this.course.bay(i);
      parts.push(box(BAY_SIZE, 0.04, BAY_SIZE, b.x, TOP + 0.01, b.y, 0xf1c40f));
      parts.push(box(BAY_SIZE - 0.4, 0.05, BAY_SIZE - 0.4, b.x, TOP + 0.015, b.y, 0x7f8589));
      // a workbench at the back of the bay
      const back = b.y + Math.sign(b.y) * (BAY_SIZE / 2 + 1);
      parts.push(box(3, 0.9, 1, b.x, TOP + 0.45, back, 0x8a6a3f), box(3.2, 0.1, 1.2, b.x, TOP + 0.95, back, 0x6d4c2f));
      parts.push(box(0.5, 0.5, 0.5, b.x - 1, TOP + 1.25, back, 0xb58a57), paint(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12).translate(b.x + 0.8, TOP + 1.1, back), 0x2b2b2b));
    }
    // a fence round three sides; the fourth opens onto the track
    const post = 0x6d4c2f;
    for (let x = GARAGE.x0; x <= GARAGE.x1; x += 6) {
      parts.push(box(0.2, 1.2, 0.2, x, TOP + 0.6, GARAGE.y0, post), box(0.2, 1.2, 0.2, x, TOP + 0.6, GARAGE.y1, post));
    }
    for (let y = GARAGE.y0; y <= GARAGE.y1; y += 6) parts.push(box(0.2, 1.2, 0.2, GARAGE.x0, TOP + 0.6, y, post));
    parts.push(box(w, 0.12, 0.1, cx, TOP + 1, GARAGE.y0, post), box(w, 0.12, 0.1, cx, TOP + 1, GARAGE.y1, post), box(0.1, 0.12, d, GARAGE.x0, TOP + 1, cy, post));
    // the way out to the track, between the fences
    for (const side of [-1, 1]) {
      parts.push(box(0.2, 1.2, 0.2, GARAGE.x1, TOP + 0.6, side * HALF_WIDTH, 0xd63031));
      parts.push(box(0.1, 0.12, GARAGE.y1 - HALF_WIDTH, GARAGE.x1, TOP + 1, side * (HALF_WIDTH + (GARAGE.y1 - HALF_WIDTH) / 2), post));
    }
    const mesh = new THREE.Mesh(merge(parts), SOLID);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  private bayNumber(i: number): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f1c40f';
    ctx.font = 'bold 96px Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), 64, 70);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    const b = this.course.bay(i);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = b.y > 0 ? Math.PI : 0;
    mesh.position.set(b.x, TOP + 0.05, b.y - Math.sign(b.y) * (BAY_SIZE / 2 - 1.4));
    return mesh;
  }

  /** Start and finish arches, and a flag at each checkpoint. */
  private gates(): THREE.Group {
    const { course } = this;
    const group = new THREE.Group();
    const arch = (u: number, text: string, color: string) => {
      const p = course.pointAt(u, 0);
      const g = new THREE.Group();
      g.position.set(p.x, p.z, p.y);
      g.rotation.y = -p.heading;
      const span = HALF_WIDTH * 2 + 3;
      g.add(new THREE.Mesh(merge([box(0.5, 7, 0.5, 0, 3.5, -span / 2, 0xecf0f1), box(0.5, 7, 0.5, 0, 3.5, span / 2, 0xecf0f1), box(0.6, 1.6, span + 0.5, 0, 7, 0, 0x2d3436)]), SOLID));
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1024, 128);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 96px Trebuchet MS, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 512, 70);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(span, 1.4), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      sign.position.set(-0.32, 7, 0);
      sign.rotation.y = -Math.PI / 2;
      g.add(sign);
      group.add(g);
    };
    arch(38, 'START', '#27ae60');
    arch(FINISH, 'FINISH', '#c0392b');

    const flags: THREE.BufferGeometry[] = [];
    for (let u = CHECKPOINT_SPACING; u < FINISH; u += CHECKPOINT_SPACING) {
      for (const side of [-1, 1]) {
        const p = course.pointAt(u, side * (HALF_WIDTH + 1));
        flags.push(box(0.1, 2.4, 0.1, p.x, p.z + 1.2, p.y, 0xecf0f1), box(0.7, 0.45, 0.04, p.x + 0.35, p.z + 2.15, p.y, 0xf39c12));
      }
    }
    const flagMesh = new THREE.Mesh(merge(flags), SOLID);
    group.add(flagMesh);
    return group;
  }

  private trees(): THREE.InstancedMesh {
    const geo = merge([paint(new THREE.CylinderGeometry(0.06, 0.08, 0.3, 6).translate(0, 0.15, 0), 0x5b3d24), paint(new THREE.ConeGeometry(0.28, 0.5, 7).translate(0, 0.5, 0), 0x2f5a34), paint(new THREE.ConeGeometry(0.2, 0.4, 7).translate(0, 0.78, 0), 0x3d7641)]);
    const { trees } = this.course;
    const mesh = new THREE.InstancedMesh(geo, SOLID, trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    trees.forEach((t, i) => {
      s.set(t.height * 0.9, t.height, t.height * 0.9);
      p.set(t.x, t.z, t.y);
      mesh.setMatrixAt(i, m.compose(p, q, s));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}
