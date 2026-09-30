import * as THREE from 'three';
import { mulberry32, type NetWorld } from '@engine/index';
import { SOLID, box, merge, paint } from '../crossplay/models';
import { boardKey, drawBoard, standings } from './board';
import { BENCHES, BENCH_HEIGHT, CEILING, FIELD, LOCKER_WALLS, TUNNEL, TUNNEL_HEIGHT } from './field';

const SKY = 0x223463;
const WALL = 0.2;
const LOCKER_DEPTH = 0.6;

/** A box by its world extents: x0..x1, y0..y1 on the ground, z0..z1 up. */
function block(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number): THREE.BufferGeometry {
  return box(x1 - x0, z1 - z0, y1 - y0, (x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2, color);
}

/**
 * The grounds as they're drawn: a locker room with lockers, benches and a leaderboard on the whiteboard, the tunnel
 * out to the field, and a floodlit stadium round the field with a crowd in the stands and the leaderboard up on the
 * jumbotron. Everything's merged into a few meshes; the boards are canvases redrawn when the standings change.
 */
export class Scenery {
  private readonly jumbo: CanvasPanel;
  private readonly whiteboard: CanvasPanel;
  private drawn = '';
  private nextDraw = 0;
  private lastFive = '';

  constructor(scene: THREE.Scene) {
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 70, 200);
    scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x5a5a50, 1.5));
    const flood = new THREE.DirectionalLight(0xfff6e0, 1.4);
    flood.position.set(0.4, 1, 0.3);
    scene.add(flood);
    // strip lights in the locker room: the floodlights don't reach under its roof
    for (const x of [25, 35]) {
      const lamp = new THREE.PointLight(0xfff4e0, 9, 20, 1);
      lamp.position.set(x, 2.1, 11);
      scene.add(lamp);
    }
    scene.add(new THREE.Mesh(merge([...this.field(), ...this.stands(), ...this.lockerRoom(), ...this.tunnel()]), SOLID));
    scene.add(this.lights());
    scene.add(this.crowd());

    this.jumbo = canvasPanel(1024, 512, 20, 10);
    this.jumbo.mesh.position.set(30, 11, FIELD.y1 + 5.8);
    this.jumbo.mesh.rotation.y = Math.PI;
    this.whiteboard = canvasPanel(512, 320, 4.4, 2.75);
    this.whiteboard.mesh.position.set(24.4, 1.85, LOCKER_WALLS.y1 - WALL / 2 - 0.03);
    this.whiteboard.mesh.rotation.y = Math.PI;
    scene.add(this.jumbo.mesh, this.whiteboard.mesh, this.banner());
  }

  /** Say what the last five was, up on the jumbotron. */
  showFive(text: string): void {
    this.lastFive = text;
    this.drawn = '';
  }

  /** Redraw the boards when the standings have changed. */
  update(world: NetWorld, me: number, now: number): void {
    if (now < this.nextDraw) return;
    this.nextDraw = now + 500;
    const rows = standings(world);
    const key = `${boardKey(rows)}#${me}#${this.lastFive}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const j = this.jumbo;
    drawBoard(j.ctx, j.w, j.h * 0.84, rows, me, 'HIGH FIVE LEADERS', '#0b1026', '#ffffff');
    j.ctx.fillStyle = '#1b2250';
    j.ctx.fillRect(0, j.h * 0.84, j.w, j.h * 0.16);
    j.ctx.fillStyle = '#6ef0a0';
    j.ctx.font = 'bold 44px Trebuchet MS, sans-serif';
    j.ctx.textAlign = 'center';
    j.ctx.textBaseline = 'middle';
    j.ctx.fillText(this.lastFive || 'Up high! Down low! Too slow!', j.w / 2, j.h * 0.92, j.w - 40);
    j.tex.needsUpdate = true;
    const w = this.whiteboard;
    drawBoard(w.ctx, w.w, w.h, rows, me, 'TEAM BOARD', '#f4f6f8', '#1f2a44');
    w.tex.needsUpdate = true;
  }

  private field(): THREE.BufferGeometry[] {
    const { x0, x1, y0, y1 } = FIELD;
    const parts: THREE.BufferGeometry[] = [];
    // grass, mown in stripes, and the ground round it
    parts.push(block(-20, 80, -10, 100, -0.3, -0.02, 0x2f5a2a));
    for (let y = y0, i = 0; y < y1; y += 4.5, i++) parts.push(block(x0, x1, y, Math.min(y1, y + 4.5), -0.02, 0, i % 2 ? 0x3f8a3a : 0x4a9a42));
    // end zones, the lines, and the hand at midfield
    parts.push(block(x0 + 2, x1 - 2, y0 + 1, y0 + 4.5, 0, 0.004, 0x1d4ed8), block(x0 + 2, x1 - 2, y1 - 4.5, y1 - 1, 0, 0.004, 0xd62839));
    const line = 0xf5f5f0;
    for (const x of [x0 + 2, x1 - 2]) parts.push(block(x - 0.08, x + 0.08, y0 + 1, y1 - 1, 0.005, 0.01, line));
    for (let y = y0 + 1; y <= y1 - 1 + 0.01; y += 4.5) parts.push(block(x0 + 2, x1 - 2, y - 0.08, y + 0.08, 0.005, 0.01, line));
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    parts.push(paint(new THREE.CylinderGeometry(4.2, 4.2, 0.012, 40).translate(mx, 0.006, my), 0xffc61a));
    parts.push(block(mx - 1.6, mx + 1.6, my - 1.8, my + 1.2, 0.012, 0.02, 0xd62839));
    for (let i = 0; i < 4; i++) parts.push(block(mx - 1.5 + i * 0.82, mx - 0.9 + i * 0.82, my + 1.2, my + 3.1 - Math.abs(i - 1.5) * 0.35, 0.012, 0.02, 0xd62839));
    parts.push(block(mx - 2.9, mx - 1.6, my - 1.2, my - 0.5, 0.012, 0.02, 0xd62839));
    // a goalpost at the north end: a post, a crossbar and two uprights (the tunnel comes out at the south end)
    for (const gy of [y1 - 1.5]) {
      parts.push(block(mx - 0.15, mx + 0.15, gy - 0.15, gy + 0.15, 0, 3.1, 0xffd23f));
      parts.push(block(mx - 2.8, mx + 2.8, gy - 0.08, gy + 0.08, 3, 3.16, 0xffd23f));
      for (const ux of [mx - 2.8, mx + 2.8]) parts.push(block(ux - 0.08, ux + 0.08, gy - 0.08, gy + 0.08, 3, 9, 0xffd23f));
    }
    // a padded wall round the field, open where the tunnel comes out
    const pad = 0x1e3a8a;
    parts.push(block(x0 - 0.4, x0, y0, y1 + 0.4, 0, 1.2, pad), block(x1, x1 + 0.4, y0, y1 + 0.4, 0, 1.2, pad), block(x0 - 0.4, x1 + 0.4, y1, y1 + 0.4, 0, 1.2, pad));
    parts.push(block(x0 - 0.4, TUNNEL.x0 - 0.2, y0 - 0.4, y0, 0, 1.2, pad), block(TUNNEL.x1 + 0.2, x1 + 0.4, y0 - 0.4, y0, 0, 1.2, pad));
    // benches for the team on the touchline, and a table of cups
    parts.push(block(x0 + 0.4, x0 + 0.9, y0 + 12, y0 + 26, 0, 0.45, 0x9ca3af));
    parts.push(block(x1 - 1.4, x1 - 0.5, y0 + 18, y0 + 20, 0, 0.8, 0xf8fafc));
    parts.push(paint(new THREE.CylinderGeometry(0.28, 0.25, 0.6, 14).translate(x1 - 0.95, 1.1, y0 + 19), 0xea580c));
    return parts;
  }

  /** Stands on three sides and over the tunnel, and the jumbotron's frame beyond the north end zone. */
  private stands(): THREE.BufferGeometry[] {
    const { x0, x1, y0, y1 } = FIELD;
    const parts: THREE.BufferGeometry[] = [];
    const concrete = [0x8b93a1, 0x7d8594];
    for (let i = 0; i < 10; i++) {
      const c = concrete[i % 2];
      const d = 1.2 * i;
      const z = 1.2 + 0.7 * i;
      parts.push(block(x0 - 1.6 - d, x0 - 0.4 - d, y0 - 1, y1 + 2, 0, z, c));
      parts.push(block(x1 + 0.4 + d, x1 + 1.6 + d, y0 - 1, y1 + 2, 0, z, c));
      if (i < 3) parts.push(block(x0 - 12, x1 + 12, y1 + 0.4 + d, y1 + 1.6 + d, 0, z, c));
      if (i < 6) {
        parts.push(block(x0 - 12, TUNNEL.x0 - 0.2, y0 - 1.6 - d, y0 - 0.4 - d, 0, z, c));
        parts.push(block(TUNNEL.x1 + 0.2, x1 + 12, y0 - 1.6 - d, y0 - 0.4 - d, 0, z, c));
      }
    }
    // over the tunnel's mouth
    parts.push(block(TUNNEL.x0 - 0.2, TUNNEL.x1 + 0.2, y0 - 7.6, y0 - 0.4, TUNNEL_HEIGHT, 5.4, concrete[0]));
    // the jumbotron: legs and a frame round the screen
    const jy = y1 + 6;
    parts.push(block(21.5, 22.5, jy - 0.3, jy + 0.6, 0, 6, 0x2d3440), block(37.5, 38.5, jy - 0.3, jy + 0.6, 0, 6, 0x2d3440));
    parts.push(block(19.5, 40.5, jy, jy + 0.6, 5.6, 16.4, 0x161a22));
    return parts;
  }

  private lockerRoom(): THREE.BufferGeometry[] {
    const { x0, x1, y0, y1 } = LOCKER_WALLS;
    const parts: THREE.BufferGeometry[] = [];
    const wall = 0xd9dde3;
    // floor tiles, walls (a doorway north into the tunnel) and ceiling
    parts.push(block(x0, x1, y0, y1, -0.02, 0.005, 0x4b5563));
    for (let x = x0; x < x1; x += 1) for (let y = y0; y < y1; y += 1) if ((Math.floor(x) + Math.floor(y)) % 2 === 0) parts.push(block(x, x + 1, y, y + 1, 0.005, 0.01, 0x566173));
    parts.push(block(x0 - WALL, x0, y0 - WALL, y1 + WALL, 0, CEILING, wall), block(x1, x1 + WALL, y0 - WALL, y1 + WALL, 0, CEILING, wall));
    parts.push(block(x0, x1, y0 - WALL, y0, 0, CEILING, wall));
    parts.push(block(x0, TUNNEL.x0, y1 - WALL / 2, y1 + WALL / 2, 0, CEILING, wall), block(TUNNEL.x1, x1, y1 - WALL / 2, y1 + WALL / 2, 0, CEILING, wall));
    parts.push(block(TUNNEL.x0, TUNNEL.x1, y1 - WALL / 2, y1 + WALL / 2, TUNNEL_HEIGHT - 0.2, CEILING, wall));
    parts.push(block(x0 - WALL, x1 + WALL, y0 - WALL, y1 + WALL, CEILING, CEILING + 0.15, 0xc4c9d0));
    // lockers down both long walls and the south one
    const lockers = [0x1d4ed8, 0x1e40af];
    const locker = (lx0: number, lx1: number, ly0: number, ly1: number, i: number) => {
      parts.push(block(lx0, lx1, ly0, ly1, 0, 2.1, lockers[i % 2]));
      // vents near the top of the door, and a handle
      const alongX = lx1 - lx0 > ly1 - ly0;
      const inset = 0.004;
      if (alongX) {
        const face = ly1 + inset;
        for (let v = 0; v < 3; v++) parts.push(block(lx0 + 0.12, lx1 - 0.12, face - 0.01, face, 1.75 + v * 0.07, 1.78 + v * 0.07, 0x0f1f4d));
        parts.push(block(lx1 - 0.12, lx1 - 0.08, face - 0.01, face + 0.02, 1.0, 1.2, 0xd4d4d8));
      } else {
        const east = lx0 > 30;
        const face = east ? lx0 - inset : lx1 + inset;
        const f0 = east ? face : face - 0.01;
        for (let v = 0; v < 3; v++) parts.push(block(f0, f0 + 0.01, ly0 + 0.12, ly1 - 0.12, 1.75 + v * 0.07, 1.78 + v * 0.07, 0x0f1f4d));
        parts.push(block(east ? face - 0.02 : face - 0.01, east ? face + 0.01 : face + 0.02, ly1 - 0.12, ly1 - 0.08, 1.0, 1.2, 0xd4d4d8));
      }
    };
    let i = 0;
    for (let y = y0 + LOCKER_DEPTH; y + 0.55 <= y1 - 0.4; y += 0.6) {
      locker(x0, x0 + LOCKER_DEPTH, y, y + 0.55, i);
      locker(x1 - LOCKER_DEPTH, x1, y, y + 0.55, i++);
    }
    for (let x = x0 + LOCKER_DEPTH + 0.1; x + 0.55 <= x1 - LOCKER_DEPTH - 0.1; x += 0.6) locker(x, x + 0.55, y0, y0 + LOCKER_DEPTH, i++);
    // benches, and their legs
    for (const b of BENCHES) {
      parts.push(block(b.x0, b.x1, b.y0, b.y1, BENCH_HEIGHT - 0.06, BENCH_HEIGHT, 0xb7874e));
      for (let x = b.x0 + 0.3; x < b.x1; x += (b.x1 - b.x0 - 0.6) / 2) parts.push(block(x - 0.05, x + 0.05, b.y0 + 0.05, b.y1 - 0.05, 0, BENCH_HEIGHT - 0.06, 0x3f3f46));
    }
    // a water cooler and a bin of towels by the door
    parts.push(block(34, 34.5, y1 - 0.9, y1 - 0.4, 0, 0.95, 0xe5e7eb));
    parts.push(paint(new THREE.CylinderGeometry(0.17, 0.17, 0.45, 12).translate(34.25, 1.18, y1 - 0.65), 0x7dd3fc));
    parts.push(block(35.5, 36.4, y1 - 0.9, y1 - 0.3, 0, 0.7, 0x6b7280));
    for (let t = 0; t < 5; t++) parts.push(block(35.55 + t * 0.17, 35.7 + t * 0.17, y1 - 0.85, y1 - 0.35, 0.7, 0.8, [0xffffff, 0xfde68a, 0xffffff, 0xbfdbfe, 0xffffff][t]));
    // the whiteboard's frame
    parts.push(block(22.1, 26.7, y1 - WALL / 2 - 0.05, y1 - WALL / 2, 0.42, 3.28, 0x9ca3af));
    return parts;
  }

  private tunnel(): THREE.BufferGeometry[] {
    const parts: THREE.BufferGeometry[] = [];
    const y0 = LOCKER_WALLS.y1;
    const y1 = FIELD.y0;
    parts.push(block(TUNNEL.x0 - 0.3, TUNNEL.x0, y0, y1, 0, TUNNEL_HEIGHT, 0x6b7280), block(TUNNEL.x1, TUNNEL.x1 + 0.3, y0, y1, 0, TUNNEL_HEIGHT, 0x6b7280));
    parts.push(block(TUNNEL.x0 - 0.3, TUNNEL.x1 + 0.3, y0, y1, TUNNEL_HEIGHT, TUNNEL_HEIGHT + 0.2, 0x4b5563));
    parts.push(block(TUNNEL.x0, TUNNEL.x1, y0, y1, -0.02, 0.006, 0x374151));
    // a stripe of team colour down the middle, and a painted hand to slap on your way out
    parts.push(block(29.7, 30.3, y0, y1, 0.006, 0.01, 0xffc61a));
    parts.push(block(TUNNEL.x0, TUNNEL.x0 + 0.01, y1 - 3.2, y1 - 2.2, 2.1, 2.9, 0xffc61a));
    return parts;
  }

  /** Emissive panels for the lights: along the locker room's ceiling and the tunnel, and up the floodlight towers. */
  private lights(): THREE.Group {
    const parts: THREE.BufferGeometry[] = [];
    for (let x = 23; x < 38; x += 5) for (let y = 7; y < 17; y += 4) parts.push(block(x - 0.8, x + 0.8, y - 0.2, y + 0.2, CEILING - 0.04, CEILING, 0xfffdf0));
    for (let y = LOCKER_WALLS.y1 + 1; y < FIELD.y0; y += 2.5) parts.push(block(29.6, 30.4, y - 0.12, y + 0.12, TUNNEL_HEIGHT - 0.04, TUNNEL_HEIGHT, 0xfff3c4));
    const towers: [number, number][] = [
      [FIELD.x0 - 14, FIELD.y0 - 6],
      [FIELD.x1 + 14, FIELD.y0 - 6],
      [FIELD.x0 - 14, FIELD.y1 + 6],
      [FIELD.x1 + 14, FIELD.y1 + 6],
    ];
    const poles: THREE.BufferGeometry[] = [];
    for (const [x, y] of towers) {
      poles.push(block(x - 0.4, x + 0.4, y - 0.4, y + 0.4, 0, 24, 0x4b5563));
      poles.push(block(x - 3, x + 3, y - 0.3, y + 0.3, 23, 27, 0x2d3440));
      for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) parts.push(block(x - 2.6 + c * 1.1, x - 1.8 + c * 1.1, y - 0.36, y + 0.36, 23.3 + r * 1.2, 24.1 + r * 1.2, 0xffffe8));
    }
    const group = new THREE.Group();
    group.add(new THREE.Mesh(merge(parts), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })));
    group.add(new THREE.Mesh(merge(poles), SOLID));
    return group;
  }

  /** Fans in the stands: a block each, in team colours, seeded so everyone sees the same crowd. */
  private crowd(): THREE.Mesh {
    const rng = mulberry32(55);
    const colors = [0xd62839, 0x1d4ed8, 0xffc61a, 0xf8fafc, 0xd62839, 0x1d4ed8, 0x111827, 0xf97316];
    const parts: THREE.BufferGeometry[] = [];
    const { x0, x1, y0, y1 } = FIELD;
    const fan = (x: number, y: number, z: number) => {
      if (rng() < 0.3) return;
      const c = colors[Math.floor(rng() * colors.length)];
      parts.push(block(x - 0.2, x + 0.2, y - 0.2, y + 0.2, z, z + 0.55 + rng() * 0.15, c));
      parts.push(block(x - 0.12, x + 0.12, y - 0.12, y + 0.12, z + 0.72, z + 0.95, 0xe0ac69));
    };
    for (let i = 1; i < 10; i++) {
      const z = 1.2 + 0.7 * i;
      for (let y = y0; y < y1; y += 0.9) {
        fan(x0 - 1 - 1.2 * i, y, z);
        fan(x1 + 1 + 1.2 * i, y, z);
      }
      if (i < 3) for (let x = x0; x < x1; x += 0.9) fan(x, y1 + 1 + 1.2 * i, z);
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** The team's banner over the lockers on the locker room's south wall. */
  private banner(): THREE.Mesh {
    const c = canvasPanel(1024, 160, 8.96, 1.4);
    const { ctx } = c;
    ctx.fillStyle = '#d62839';
    ctx.fillRect(0, 0, 1024, 160);
    ctx.fillStyle = '#ffc61a';
    ctx.fillRect(0, 138, 1024, 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 92px Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✋ HIGH FIVE WITH FRIENDS ✋', 512, 72, 990);
    c.tex.needsUpdate = true;
    c.mesh.position.set(30, 2.68, LOCKER_WALLS.y0 + LOCKER_DEPTH + 0.02);
    return c.mesh;
  }
}

interface CanvasPanel {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  w: number;
  h: number;
}

/** A lit canvas on a plane `width` × `height` m, facing +Z (the world's +y) until turned. */
function canvasPanel(w: number, h: number, width: number, height: number): CanvasPanel {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tex, fog: false }));
  return { mesh, ctx: canvas.getContext('2d')!, tex, w, h };
}
