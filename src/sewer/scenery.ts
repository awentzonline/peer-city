import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { SOLID, box, glowTexture, merge, paint } from '../crossplay/models';
import type { Vec3 } from './context';
import type { Effects } from './effects';
import { LootKind, VALVES } from './defs';
import { lootGeometry } from './models';
import type { Sfx } from './sfx';
import { CHAMBER_HEIGHT, Cell, SIZE, TUNNEL_HEIGHT, WALK_HEIGHT, type SewerMap, type WallSpot } from './sewer';

const FOG = 0x0a0c07;
/** How far a tunnel's arch drops from its crown to where it meets the walls, m. */
const ARCH_DROP = 0.9;
/** Brick texture: this many meters across. */
const TEX_SIZE = 2;
const SHAFT_TOP = 7;

/** Where a tunnel cell's arch is centred, and which way across it runs. */
interface Arch {
  /** 1: the tunnel runs along x (the arch goes across y); 2: along y. 0: not a tunnel. */
  along: Uint8Array;
  mid: Float32Array;
}

/**
 * The sewer as it's drawn: arched brick tunnels and domed chambers, walkways of slimy flagstones along the walls, the
 * ladder up the manhole shaft with daylight at the top, storm grates letting shafts of light down, valve wheels and the
 * pipes they drain into, drains goblins crawl out of, big outfall pipes pouring into the channels, and the vault's
 * gold. Everything comes from the same grid the rules walk on (sewer.ts).
 */
export class Scenery {
  private readonly arch: Arch;
  private readonly wheels: THREE.Group[] = [];
  private readonly turned = new Array(VALVES).fill(0);
  private readonly outfalls: { x: number; y: number; z: number; dx: number; dy: number }[] = [];
  private readonly rnd = mulberry32(99);
  private t = 0;
  private nextDrip = 0;

  constructor(
    private readonly map: SewerMap,
    private readonly scene: THREE.Scene,
  ) {
    scene.background = new THREE.Color(FOG);
    scene.fog = new THREE.FogExp2(FOG, 0.07);
    scene.add(new THREE.HemisphereLight(0x6a7a5a, 0x1a140a, 0.55));
    this.arch = this.findArches();
    const bricks = brickTexture();
    const flags = flagTexture();
    scene.add(
      new THREE.Mesh(this.walls(), new THREE.MeshLambertMaterial({ map: bricks, vertexColors: true })),
      new THREE.Mesh(this.ceilings(), new THREE.MeshLambertMaterial({ map: bricks, vertexColors: true })),
      new THREE.Mesh(this.walkways(), new THREE.MeshLambertMaterial({ map: flags, vertexColors: true })),
    );
    this.ladder();
    this.grates();
    this.valves();
    this.drains();
    this.pipes();
    this.vault();
    this.signs();
  }

  /** Valve wheels turn as they're opened, outfalls pour, and now and then something drips from the ceiling. */
  update(dt: number, valves: readonly number[], near: Vec3, fx: Effects, sfx: Sfx): void {
    this.t += dt;
    valves.forEach((open, i) => {
      const wheel = this.wheels[i];
      if (!wheel) return;
      // the wheel's turned as far as the valve's open
      this.turned[i] += (open * Math.PI * 6 - this.turned[i]) * Math.min(1, dt * 4);
      wheel.rotation.z = this.turned[i];
      const v = this.map.valves[i];
      if (open > 0.05 && Math.hypot(v.x - near.x, v.y - near.y) < 22) fx.pour(v.x + v.nx * 0.35, v.y + v.ny * 0.35, 0.75, v.nx, v.ny, 0.5 + open);
    });
    for (const o of this.outfalls) if (Math.hypot(o.x - near.x, o.y - near.y) < 24) fx.pour(o.x, o.y, o.z, o.dx, o.dy, 1.2);
    if (this.t >= this.nextDrip) {
      this.nextDrip = this.t + 0.3 + this.rnd() * 0.8;
      const x = near.x + (this.rnd() - 0.5) * 10;
      const y = near.y + (this.rnd() - 0.5) * 10;
      if (!this.map.solid(Math.floor(x), Math.floor(y))) {
        const z = this.ceilZ(x, y, Math.floor(x), Math.floor(y)) - 0.05;
        fx.drip(x, y, z);
        sfx.play('drip', { x, y, z: 0.5 }, 0.5 + this.rnd() * 0.5);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The shell: walls, ceilings, walkways
  // -------------------------------------------------------------------------

  private findArches(): Arch {
    const along = new Uint8Array(SIZE * SIZE);
    const mid = new Float32Array(SIZE * SIZE);
    for (const [a, b] of this.map.tunnels) {
      const ca = this.map.chambers[a];
      const cb = this.map.chambers[b];
      if (ca.cy === cb.cy) {
        const [x0, x1] = ca.cx < cb.cx ? [ca.x1 + 1, cb.x0 - 1] : [cb.x1 + 1, ca.x0 - 1];
        for (let i = x0; i <= x1; i++) for (let j = ca.cy - 2; j < ca.cy + 2; j++) (along[j * SIZE + i] = 1), (mid[j * SIZE + i] = ca.cy);
      } else {
        const [y0, y1] = ca.cy < cb.cy ? [ca.y1 + 1, cb.y0 - 1] : [cb.y1 + 1, ca.y0 - 1];
        for (let j = y0; j <= y1; j++) for (let i = ca.cx - 2; i < ca.cx + 2; i++) (along[j * SIZE + i] = 2), (mid[j * SIZE + i] = ca.cx);
      }
    }
    return { along, mid };
  }

  /** The ceiling's height at a point, as cell (i, j) sees it: a tunnel's arch, or a chamber's flat vault. */
  private ceilZ(x: number, y: number, i: number, j: number): number {
    const k = j * SIZE + i;
    const along = this.arch.along[k];
    if (!along || this.map.chamberOf[k] >= 0) return CHAMBER_HEIGHT;
    const d = ((along === 1 ? y : x) - this.arch.mid[k]) / 2;
    return TUNNEL_HEIGHT - ARCH_DROP * d * d;
  }

  private floorZ(i: number, j: number): number {
    return this.map.cell(i, j) === Cell.Walk ? WALK_HEIGHT : 0;
  }

  private walls(): THREE.BufferGeometry {
    const b = new Builder();
    const { map } = this;
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        if (map.solid(i, j)) continue;
        const floor = this.floorZ(i, j);
        // the four sides: [neighbour di, dj, the edge's two ends]
        const sides: [number, number, number, number, number, number][] = [
          [1, 0, i + 1, j + 1, i + 1, j],
          [-1, 0, i, j, i, j + 1],
          [0, 1, i, j + 1, i + 1, j + 1],
          [0, -1, i + 1, j, i, j],
        ];
        for (const [di, dj, ax, ay, bx, by] of sides) {
          const ni = i + di;
          const nj = j + dj;
          const topA = this.ceilZ(ax, ay, i, j);
          const topB = this.ceilZ(bx, by, i, j);
          if (map.solid(ni, nj)) {
            b.wall(ax, ay, bx, by, floor, floor, topA, topB, -di, -dj);
          } else {
            // a chamber's wall over the mouth of a lower tunnel
            const lowA = this.ceilZ(ax, ay, ni, nj);
            const lowB = this.ceilZ(bx, by, ni, nj);
            if (lowA < topA - 0.01 || lowB < topB - 0.01) b.wall(ax, ay, bx, by, lowA, lowB, topA, topB, -di, -dj);
          }
        }
      }
    }
    return b.build();
  }

  private ceilings(): THREE.BufferGeometry {
    const b = new Builder();
    const holes = new Set([this.map.ladder, ...this.map.grates].map((p) => SewerMap_index(Math.floor(p.x + (p === this.map.ladder ? 0.4 : 0)), Math.floor(p.y))));
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        if (this.map.solid(i, j) || holes.has(j * SIZE + i)) continue;
        const z = (x: number, y: number) => this.ceilZ(x, y, i, j);
        b.quad([i, j, z(i, j)], [i + 1, j, z(i + 1, j)], [i + 1, j + 1, z(i + 1, j + 1)], [i, j + 1, z(i, j + 1)], 0.45);
      }
    }
    return b.build();
  }

  private walkways(): THREE.BufferGeometry {
    const b = new Builder();
    const { map } = this;
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        if (map.cell(i, j) !== Cell.Walk) continue;
        const h = WALK_HEIGHT;
        b.quad([i, j, h], [i, j + 1, h], [i + 1, j + 1, h], [i + 1, j, h], 0.8 + this.rnd() * 0.25);
        // the kerb down into the channel
        for (const [di, dj, ax, ay, bx, by] of [
          [1, 0, i + 1, j, i + 1, j + 1],
          [-1, 0, i, j + 1, i, j],
          [0, 1, i + 1, j + 1, i, j + 1],
          [0, -1, i, j, i + 1, j],
        ] as const) {
          if (map.cell(i + di, j + dj) !== Cell.Channel) continue;
          b.wall(ax, ay, bx, by, 0, 0, h, h, di, dj);
        }
      }
    }
    return b.build();
  }

  // -------------------------------------------------------------------------
  // Fittings
  // -------------------------------------------------------------------------

  /** The ladder up the wall of the start chamber, through the manhole, into daylight. */
  private ladder(): void {
    const l = this.map.ladder;
    const parts: THREE.BufferGeometry[] = [];
    const top = SHAFT_TOP;
    for (const side of [-0.24, 0.24]) parts.push(box(0.05, top - WALK_HEIGHT, 0.05, 0, (top + WALK_HEIGHT) / 2, side, 0x6a6a64));
    for (let z = WALK_HEIGHT + 0.3; z < top; z += 0.3) parts.push(box(0.04, 0.035, 0.5, 0, z, 0, 0x7a7a70));
    const ladder = new THREE.Mesh(merge(parts), SOLID);
    ladder.position.set(l.x + 0.1, 0, l.y);
    this.scene.add(ladder);
    // the shaft, and the sky at the top of it
    const cx = l.x + 0.42;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, top - CHAMBER_HEIGHT, 14, 1, true), new THREE.MeshLambertMaterial({ color: 0x5a5448, side: THREE.BackSide }));
    shaft.position.set(cx, (top + CHAMBER_HEIGHT) / 2, l.y);
    const sky = new THREE.Mesh(new THREE.CircleGeometry(0.5, 14).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe8f0ff, fog: false }));
    sky.position.set(cx, top, l.y);
    this.scene.add(shaft, sky, this.lightShaft(cx, l.y, top, 0.5, 0xfff4d8, 0.12));
    const light = new THREE.PointLight(0xfff0d8, 9, 12, 1.4);
    light.position.set(cx + 0.6, CHAMBER_HEIGHT - 0.4, l.y + 0.3);
    this.scene.add(light);
  }

  /** Storm grates in chamber ceilings, with light coming down through them. */
  private grates(): void {
    this.map.grates.forEach((g, n) => {
      const i = Math.floor(g.x);
      const j = Math.floor(g.y);
      const bars: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 6; k++) bars.push(box(1, 0.05, 0.04, 0.5, 0, (k + 0.5) / 6, 0x2a2a28));
      bars.push(box(0.04, 0.05, 1, 0.5, 0, 0.5, 0x2a2a28));
      const grate = new THREE.Mesh(merge(bars), SOLID);
      grate.position.set(i, CHAMBER_HEIGHT + 0.3, j);
      const well = new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 1).translate(0.5, CHAMBER_HEIGHT + 0.3, 0.5), new THREE.MeshLambertMaterial({ color: 0x3a3830, side: THREE.BackSide }));
      well.position.set(i, 0, j);
      this.scene.add(grate, well, this.lightShaft(i + 0.5, j + 0.5, CHAMBER_HEIGHT + 0.3, 0.55, 0xc8d8ff, 0.08));
      if (n < 5) {
        const light = new THREE.PointLight(0xb8c8e8, 5, 11, 1.4);
        light.position.set(i + 0.5, CHAMBER_HEIGHT - 1, j + 0.5);
        this.scene.add(light);
      }
    });
  }

  /** A cone of light falling from `top` to the floor, with dust in it. */
  private lightShaft(x: number, y: number, top: number, r: number, color: number, opacity: number): THREE.Mesh {
    const h = top;
    const g = new THREE.CylinderGeometry(r, r * 2.4, h, 16, 1, true).translate(0, h / 2, 0);
    const pos = g.getAttribute('position');
    const c = new THREE.Color(color);
    const colors = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      const f = pos.getY(k) / h;
      colors[k * 3] = c.r * f;
      colors[k * 3 + 1] = c.g * f;
      colors[k * 3 + 2] = c.b * f;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    m.position.set(x, 0, y);
    m.renderOrder = 6;
    return m;
  }

  /** Relief valves: a red wheel on a pipe, and an outlet under it that gushes once it's open. */
  private valves(): void {
    for (const v of this.map.valves) {
      const group = new THREE.Group();
      group.position.set(v.x, v.z, v.y);
      // face out of the wall: the wheel's axis along the normal
      group.rotation.y = Math.atan2(-v.ny, v.nx) + Math.PI / 2;
      const wheel = new THREE.Group();
      const spokes: THREE.BufferGeometry[] = [paint(new THREE.TorusGeometry(0.26, 0.03, 6, 20), 0xc0302a), paint(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8).rotateX(Math.PI / 2), 0x8a2020)];
      for (let k = 0; k < 4; k++) spokes.push(paint(new THREE.BoxGeometry(0.5, 0.03, 0.03).rotateZ((k * Math.PI) / 4), 0xa02a24));
      wheel.add(new THREE.Mesh(merge(spokes), SOLID));
      wheel.position.z = 0.02;
      group.add(wheel);
      // the valve body and pipe down into the channel, and a gauge
      group.add(
        new THREE.Mesh(
          merge([
            paint(new THREE.CylinderGeometry(0.09, 0.09, 0.22, 10).rotateX(Math.PI / 2).translate(0, 0, -0.1), 0x4a4a44),
            paint(new THREE.CylinderGeometry(0.1, 0.1, 1.6, 10).translate(0, -0.2, -0.16), 0x3a4a3a),
            paint(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 10).rotateX(Math.PI / 2).translate(0, -0.7, 0.05), 0x3a4a3a),
            paint(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 12).rotateX(Math.PI / 2).translate(0.3, 0.3, -0.1), 0xe8e8d8),
          ]),
          SOLID,
        ),
      );
      this.scene.add(group);
      this.wheels.push(wheel);
    }
  }

  /** Drains low in the walls, dark holes behind rusty bars. */
  private drains(): void {
    const hole = new THREE.MeshBasicMaterial({ color: 0x020201 });
    for (const d of this.map.drains) {
      const group = new THREE.Group();
      group.position.set(d.x + d.nx * 0.01, d.z, d.y + d.ny * 0.01);
      group.rotation.y = Math.atan2(-d.ny, d.nx) + Math.PI / 2;
      group.add(new THREE.Mesh(new THREE.CircleGeometry(0.42, 16, 0, Math.PI), hole));
      const bars: THREE.BufferGeometry[] = [];
      for (let k = -2; k <= 2; k++) bars.push(box(0.03, 0.42 * Math.sqrt(1 - (k / 2.6) ** 2), 0.03, k * 0.15, (0.42 * Math.sqrt(1 - (k / 2.6) ** 2)) / 2, 0.02, 0x5a3a22));
      // one bent out of the way
      bars.push(box(0.03, 0.2, 0.03, 0.05, 0.1, 0.12, 0x5a3a22));
      group.add(new THREE.Mesh(merge(bars), SOLID));
      group.add(new THREE.Mesh(merge([paint(new THREE.TorusGeometry(0.43, 0.04, 5, 16, Math.PI), 0x4a4238)]), SOLID));
      this.scene.add(group);
    }
  }

  /** Pipes along the tunnel walls, and outfalls pouring into the chambers. */
  private pipes(): void {
    const parts: THREE.BufferGeometry[] = [];
    for (const [a, b] of this.map.tunnels) {
      const ca = this.map.chambers[a];
      const cb = this.map.chambers[b];
      if (this.rnd() < 0.3) continue;
      if (ca.cy === cb.cy) {
        const [x0, x1] = ca.cx < cb.cx ? [ca.x1 + 1, cb.x0] : [cb.x1 + 1, ca.x0];
        const y = ca.cy + (this.rnd() < 0.5 ? -1.85 : 1.85);
        parts.push(paint(new THREE.CylinderGeometry(0.1, 0.1, x1 - x0, 8).rotateZ(Math.PI / 2).translate((x0 + x1) / 2, 1.6, y), 0x4a5040));
      } else {
        const [y0, y1] = ca.cy < cb.cy ? [ca.y1 + 1, cb.y0] : [cb.y1 + 1, ca.y0];
        const x = ca.cx + (this.rnd() < 0.5 ? -1.85 : 1.85);
        parts.push(paint(new THREE.CylinderGeometry(0.1, 0.1, y1 - y0, 8).rotateX(Math.PI / 2).translate(x, 1.6, (y0 + y1) / 2), 0x4a5040));
      }
    }
    for (const c of this.map.chambers) {
      if (c === this.map.start || c === this.map.vault || this.rnd() < 0.45) continue;
      // on the north wall, off to one side of any tunnel mouth
      const x = c.x0 + 1.5;
      const y = c.y1 + 1;
      parts.push(paint(new THREE.CylinderGeometry(0.4, 0.4, 0.5, 14).rotateX(Math.PI / 2).translate(x, 1.7, y - 0.15), 0x3e3a30));
      parts.push(paint(new THREE.CylinderGeometry(0.33, 0.33, 0.52, 14).rotateX(Math.PI / 2).translate(x, 1.7, y - 0.16), 0x151510));
      this.outfalls.push({ x, y: y - 0.45, z: 1.55, dx: 0, dy: -1 });
    }
    if (parts.length) this.scene.add(new THREE.Mesh(merge(parts), SOLID));
  }

  /** The vault: gold heaped against the walls, and a warm glow. */
  private vault(): void {
    const v = this.map.vault;
    const parts: THREE.BufferGeometry[] = [];
    for (let n = 0; n < 16; n++) {
      const i = this.rnd() < 0.5 ? v.x0 : v.x1;
      const j = v.y0 + 1 + Math.floor(this.rnd() * (v.y1 - v.y0 - 1));
      const g = lootGeometry(LootKind.Coins).clone();
      parts.push(g.scale(2.4, 2.4, 2.4).translate(i + 0.5 + (this.rnd() - 0.5) * 0.4, WALK_HEIGHT, j + 0.5 + (this.rnd() - 0.5) * 0.5));
    }
    parts.push(box(0.5, 0.35, 0.8, v.x0 + 0.5, WALK_HEIGHT + 0.18, v.cy + 0.5 + 2.8, 0x6a4a22), box(0.52, 0.06, 0.82, v.x0 + 0.5, WALK_HEIGHT + 0.36, v.cy + 0.5 + 2.8, 0xc8a030));
    this.scene.add(new THREE.Mesh(merge(parts), SOLID));
    const light = new THREE.PointLight(0xffc860, 6, 12, 1.4);
    light.position.set(v.cx + 0.5, 3, v.cy + 0.5);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffc050, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.set(v.cx + 0.5, 1.2, v.cy + 0.5);
    glow.scale.setScalar(5);
    this.scene.add(light, glow);
  }

  /** Painted on the walls: on a side of a chamber with no tunnel out of it. */
  private signs(): void {
    const s = this.map.start;
    this.sign('SEWER LORDZ', 'NO ENTRY · NO LIFEGUARD', this.blankWall(s), '#c8e05a');
    this.sign('THE VAULT', 'staff only', this.blankWall(this.map.vault), '#ffd35a');
  }

  /** The middle of a chamber's wall that has no tunnel in it. */
  private blankWall(c: { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }): WallSpot {
    const sides: WallSpot[] = [
      { x: c.cx + 0.5, y: c.y0 + 0.02, z: 2.8, nx: 0, ny: 1 },
      { x: c.cx + 0.5, y: c.y1 + 0.98, z: 2.8, nx: 0, ny: -1 },
      { x: c.x0 + 0.02, y: c.cy + 0.5, z: 2.8, nx: 1, ny: 0 },
      { x: c.x1 + 0.98, y: c.cy + 0.5, z: 2.8, nx: -1, ny: 0 },
    ];
    return sides.find((w) => this.map.solid(Math.floor(w.x - w.nx * 0.5), Math.floor(w.y - w.ny * 0.5))) ?? sides[0];
  }

  private sign(text: string, sub: string, at: WallSpot, color: string): void {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 192;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(0,0,0,0)';
    g.fillRect(0, 0, 512, 192);
    g.font = 'bold 78px Impact, Trebuchet MS, sans-serif';
    g.textAlign = 'center';
    g.fillStyle = color;
    g.globalAlpha = 0.85;
    g.fillText(text, 256, 100);
    g.font = 'bold 34px Trebuchet MS, sans-serif';
    g.fillText(sub, 256, 160);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.1), new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.position.set(at.x, at.z, at.y);
    m.rotation.y = Math.atan2(at.nx, at.ny);
    this.scene.add(m);
  }
}

function SewerMap_index(i: number, j: number): number {
  return j * SIZE + i;
}

/** Collects quads in world axes (z up) into a scene-axes geometry with normals, texture coordinates and colours. */
class Builder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];

  /** A wall between two ground points, from `b` to `t` high at each end, facing (nx, ny). Split into a grimy lower band. */
  wall(ax: number, ay: number, bx: number, by: number, bA: number, bB: number, tA: number, tB: number, nx: number, ny: number): void {
    const band = 1.1;
    const midA = Math.min(tA, Math.max(bA, band));
    const midB = Math.min(tB, Math.max(bB, band));
    const along = (x: number, y: number) => (nx !== 0 ? y : x);
    this.side(ax, ay, bx, by, bA, bB, midA, midB, nx, ny, along, true);
    if (tA > midA + 0.01 || tB > midB + 0.01) this.side(ax, ay, bx, by, midA, midB, tA, tB, nx, ny, along, false);
  }

  private side(ax: number, ay: number, bx: number, by: number, b0: number, b1: number, t0: number, t1: number, nx: number, ny: number, along: (x: number, y: number) => number, low: boolean): void {
    const shade = (z: number) => {
      // green slime and black grime low down, fading up the wall
      const k = Math.min(1, z / 2.4);
      return low ? [0.42 + 0.3 * k, 0.5 + 0.28 * k, 0.28 + 0.3 * k] : [0.62 + 0.25 * k, 0.6 + 0.22 * k, 0.52 + 0.2 * k];
    };
    const ua = along(ax, ay) / TEX_SIZE;
    const ub = along(bx, by) / TEX_SIZE;
    const verts: [number, number, number, number, number][] = [
      [ax, ay, b0, ua, b0 / TEX_SIZE],
      [bx, by, b1, ub, b1 / TEX_SIZE],
      [bx, by, t1, ub, t1 / TEX_SIZE],
      [ax, ay, t0, ua, t0 / TEX_SIZE],
    ];
    // wound to face (nx, ny)
    for (const k of [0, 2, 1, 0, 3, 2]) {
      const [x, y, z, u, v] = verts[k];
      this.pos.push(x, z, y);
      this.nor.push(nx, 0, ny);
      this.uv.push(u, v);
      this.col.push(...shade(z));
    }
  }

  /** A quad through four points (world axes), facing whichever way their winding makes its front. */
  quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], brightness: number): void {
    const va = new THREE.Vector3(a[0], a[2], a[1]);
    const vb = new THREE.Vector3(b[0], b[2], b[1]);
    const vc = new THREE.Vector3(c[0], c[2], c[1]);
    const n = new THREE.Vector3().subVectors(vc, vb).cross(new THREE.Vector3().subVectors(va, vb)).normalize();
    for (const p of [a, b, c, a, c, d]) {
      this.pos.push(p[0], p[2], p[1]);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(p[0] / TEX_SIZE, p[1] / TEX_SIZE);
      const g = brightness * (0.85 + ((Math.sin(p[0] * 12.9 + p[1] * 78.2) * 43758.5) % 1) * 0.15);
      this.col.push(g, g, g * 0.9);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Grimy old bricks, streaked with slime: `TEX_SIZE` meters square. */
function brickTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(7);
  g.fillStyle = '#3a3226';
  g.fillRect(0, 0, 512, 512);
  const rows = 8;
  const perRow = 4;
  const bh = 512 / rows;
  const bw = 512 / perRow;
  for (let r = 0; r < rows; r++) {
    for (let k = -1; k < perRow; k++) {
      const x = k * bw + (r % 2 ? bw / 2 : 0);
      const l = 34 + rnd() * 26;
      g.fillStyle = `hsl(${14 + rnd() * 18}, ${28 + rnd() * 20}%, ${l}%)`;
      g.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
      // pitting
      for (let n = 0; n < 12; n++) {
        g.fillStyle = `rgba(0,0,0,${0.08 + rnd() * 0.15})`;
        g.fillRect(x + 3 + rnd() * (bw - 10), r * bh + 3 + rnd() * (bh - 10), 3 + rnd() * 6, 2 + rnd() * 4);
      }
    }
  }
  // slime running down
  for (let n = 0; n < 26; n++) {
    const x = rnd() * 512;
    const len = 80 + rnd() * 300;
    const grad = g.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, 'rgba(70,90,20,0.5)');
    grad.addColorStop(1, 'rgba(70,90,20,0)');
    g.fillStyle = grad;
    g.fillRect(x, 0, 4 + rnd() * 10, len);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Worn flagstones, for the walkways. */
function flagTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(13);
  g.fillStyle = '#2a2820';
  g.fillRect(0, 0, 256, 256);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const l = 30 + rnd() * 14;
      g.fillStyle = `hsl(${40 + rnd() * 30}, ${10 + rnd() * 12}%, ${l}%)`;
      g.fillRect(i * 64 + 2, j * 64 + 2, 60, 60);
      g.fillStyle = `rgba(60,80,20,${rnd() * 0.35})`;
      g.fillRect(i * 64 + 2, j * 64 + 2 + rnd() * 30, 60, 10 + rnd() * 20);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
