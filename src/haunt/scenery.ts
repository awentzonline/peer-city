import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { SOLID, box, glowTexture, merge, paint } from '../crossplay/models';
import { FENCE_MAX, FENCE_MIN, GATE, HOUSE, Manor, PEDESTAL, Piece, RoomKind, SIZE, SOCKETS, Tile, WALL_HEIGHT } from './manor';

/** How a peer sees the house: a survivor in the dark, or the Haunt looking down with the roof off. */
export type ViewKind = 'survivor' | 'haunt';

const NIGHT = 0x04050b;

const FLOORS: Record<RoomKind, [number, number]> = {
  [RoomKind.Hall]: [0x77716a, 0x3a3733],
  [RoomKind.Library]: [0x4c3322, 0x44301f],
  [RoomKind.Dining]: [0x5c3d27, 0x533723],
  [RoomKind.Bedroom]: [0x503b2f, 0x4a372b],
  [RoomKind.Study]: [0x3f2d21, 0x3a291e],
  [RoomKind.Parlour]: [0x57362b, 0x4e3027],
  [RoomKind.Chapel]: [0x5a534b, 0x514a43],
};

const PAPER: Record<RoomKind, number> = {
  [RoomKind.Hall]: 0x5e554b,
  [RoomKind.Library]: 0x2f4034,
  [RoomKind.Dining]: 0x5c2b2b,
  [RoomKind.Bedroom]: 0x3f3c58,
  [RoomKind.Study]: 0x4d4331,
  [RoomKind.Parlour]: 0x603f51,
  [RoomKind.Chapel]: 0x6b675f,
};

const WAINSCOT = 0x2b1e16;
/** How tall walls are in the Haunt's dollhouse view, m. */
const HAUNT_WALLS = 1.1;
const STONE = 0x58534d;

/**
 * The manor as it's drawn: the lane, the grounds and their iron fence and gate, dead trees and a graveyard, the house's
 * rooms with their floors, papered walls, ceilings and furniture, candles guttering in sconces, the pedestal by the
 * gate, and a moon. Everything comes from the same grid the rules walk on (manor.ts).
 *
 * Survivors see it at night: thick darkness a flashlight pushes back, ceilings overhead. The Haunt sees it from above
 * with the roof and ceilings off and a cold light over everything (`setView`).
 */
export class Scenery {
  private readonly hemi = new THREE.HemisphereLight(0x5b6a9c, 0x120e16, 0.5);
  private readonly moon = new THREE.DirectionalLight(0x8ea4d8, 0.4);
  private readonly ceilings: THREE.Mesh;
  private readonly wallMesh: THREE.Mesh;
  private readonly frames: THREE.Mesh;
  private readonly candleMeshes: THREE.Object3D[] = [];
  private readonly flames: { sprite: THREE.Sprite; base: number; phase: number }[] = [];
  private readonly gate: { left: THREE.Group; right: THREE.Group; open: number };
  private readonly sockets: THREE.Sprite[] = [];
  private readonly sky: THREE.Group;
  private t = 0;
  view: ViewKind = 'survivor';

  constructor(
    private readonly manor: Manor,
    private readonly scene: THREE.Scene,
  ) {
    scene.add(this.hemi, this.moon);
    this.moon.position.set(-0.4, 1, -0.6);
    this.sky = this.buildSky();
    scene.add(this.sky);
    this.wallMesh = this.walls();
    this.frames = this.doorFrames();
    scene.add(this.ground(), this.floors(), this.wallMesh, this.frames, this.fence(), this.trees(), this.furniture(), this.pedestal());
    this.ceilings = this.buildCeilings();
    scene.add(this.ceilings);
    this.gate = this.buildGate();
    this.candles();
    this.setView('survivor');
  }

  /** Light and fog for a survivor's night, or the Haunt's view from above. */
  setView(view: ViewKind): void {
    this.view = view;
    const { scene } = this;
    if (view === 'haunt') {
      scene.background = new THREE.Color(0x0b0913);
      scene.fog = null;
      this.hemi.color.setHex(0x9a8cc9);
      this.hemi.groundColor.setHex(0x2a2238);
      this.hemi.intensity = 1.9;
      this.moon.intensity = 1.1;
      this.ceilings.visible = false;
      // a dollhouse: walls cut down so every room can be seen into from any angle
      this.wallMesh.scale.y = HAUNT_WALLS / WALL_HEIGHT;
      this.frames.visible = false;
      for (const c of this.candleMeshes) c.position.y = HAUNT_WALLS - 1.9;
    } else {
      scene.background = new THREE.Color(NIGHT);
      scene.fog = new THREE.FogExp2(NIGHT, 0.07);
      this.hemi.color.setHex(0x5b6a9c);
      this.hemi.groundColor.setHex(0x120e16);
      this.hemi.intensity = 0.55;
      this.moon.intensity = 0.35;
      this.ceilings.visible = true;
      this.wallMesh.scale.y = 1;
      this.frames.visible = true;
      for (const c of this.candleMeshes) c.position.y = 0;
    }
  }

  /** Candles flicker, the gate swings open once it's unlocked, and the pedestal's sockets glow with the keys in them. */
  update(dt: number, gateOpen: boolean, placed: number): void {
    this.t += dt;
    for (const f of this.flames) {
      const k = 0.85 + Math.sin(this.t * 9 + f.phase) * 0.06 + Math.sin(this.t * 23 + f.phase * 3) * 0.05 + (Math.random() - 0.5) * 0.06;
      f.sprite.scale.setScalar(f.base * k);
    }
    const g = this.gate;
    g.open += ((gateOpen ? 1 : 0) - g.open) * Math.min(1, dt * 0.8);
    // inward, into the yard
    g.left.rotation.y = -g.open * 1.7;
    g.right.rotation.y = g.open * 1.7;
    this.sockets.forEach((s, i) => {
      const on = i < placed;
      s.material.opacity = on ? 0.8 + Math.sin(this.t * 3 + i) * 0.15 : 0.12;
    });
  }

  // -------------------------------------------------------------------------

  private buildSky(): THREE.Group {
    const sky = new THREE.Group();
    const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xdfe8ff, fog: false, depthWrite: false, transparent: true }));
    moon.scale.setScalar(70);
    moon.position.set(-250, 260, 420);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(9, 24), new THREE.MeshBasicMaterial({ color: 0xe8eeff, fog: false }));
    disc.position.copy(moon.position);
    disc.lookAt(40, 0, 40);
    const rnd = mulberry32(99);
    const stars = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const a = rnd() * Math.PI * 2;
      const e = 0.12 + rnd() * 1.3;
      stars[i * 3] = 40 + Math.cos(a) * Math.cos(e) * 700;
      stars[i * 3 + 1] = Math.sin(e) * 700;
      stars[i * 3 + 2] = 40 + Math.sin(a) * Math.cos(e) * 700;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xaab4d0, size: 1.5, sizeAttenuation: false, fog: false }));
    sky.add(points, moon, disc);
    return sky;
  }

  /** The lane, grass and gravel, and dark fields out past the lane. */
  private ground(): THREE.Group {
    const { manor } = this;
    const rnd = mulberry32(manor.seed ^ 0x51);
    const parts: THREE.BufferGeometry[] = [];
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const t = manor.tile(i, j);
        let c: number;
        if (t === Tile.Lane) c = jitter(0x35322f, rnd, 0.12);
        else if (t === Tile.Path || t === Tile.Pedestal) c = jitter(0x5b554d, rnd, 0.1);
        else if (t === Tile.Grass || t === Tile.Tree || t === Tile.Grave || t === Tile.Fence || t === Tile.Gate) c = jitter(0x2a3824, rnd, 0.18);
        else continue;
        parts.push(paint(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(i + 0.5, 0, j + 0.5), c));
      }
    }
    const group = new THREE.Group();
    group.add(new THREE.Mesh(merge(parts), SOLID));
    const field = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2).translate(40, -0.02, 40), new THREE.MeshLambertMaterial({ color: 0x1b2418 }));
    group.add(field);
    return group;
  }

  /** Every room's floor: marble squares in the hall, boards elsewhere, a rug here and there. */
  private floors(): THREE.Mesh {
    const { manor } = this;
    const rnd = mulberry32(manor.seed ^ 0xf1);
    const parts: THREE.BufferGeometry[] = [];
    for (let j = HOUSE.y0; j <= HOUSE.y1; j++) {
      for (let i = HOUSE.x0; i <= HOUSE.x1; i++) {
        const t = manor.tile(i, j);
        if (t !== Tile.Floor && t !== Tile.Furniture) continue;
        const room = manor.room(i + 0.5, j + 0.5);
        const kind = (room ?? this.nearestRoom(i, j))?.kind ?? RoomKind.Hall;
        const [a, b] = FLOORS[kind];
        let c = kind === RoomKind.Hall ? ((i + j) % 2 ? a : b) : jitter((j + (i >> 1)) % 2 ? a : b, rnd, 0.08);
        // a rug in the middle of bedrooms and the parlour
        if (room && (kind === RoomKind.Bedroom || kind === RoomKind.Parlour) && i > room.x0 + 1 && i < room.x1 - 1 && j > room.y0 + 1 && j < room.y1 - 1) c = (i === room.x0 + 2 || i === room.x1 - 2 || j === room.y0 + 2 || j === room.y1 - 2) ? 0x8a6a3a : 0x5a1f24;
        parts.push(paint(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(i + 0.5, 0.01, j + 0.5), c));
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** Stone outside, and inside, dark wood panelling under each room's wallpaper. */
  private walls(): THREE.Mesh {
    const { manor } = this;
    const parts: THREE.BufferGeometry[] = [];
    for (let j = HOUSE.y0; j <= HOUSE.y1; j++) {
      for (let i = HOUSE.x0; i <= HOUSE.x1; i++) {
        if (manor.tile(i, j) !== Tile.Wall) continue;
        const outer = i === HOUSE.x0 || i === HOUSE.x1 || j === HOUSE.y0 || j === HOUSE.y1;
        const room = this.nearestRoom(i, j);
        if (outer) {
          parts.push(box(1, WALL_HEIGHT, 1, i + 0.5, WALL_HEIGHT / 2, j + 0.5, STONE));
          parts.push(box(1.08, 0.18, 1.08, i + 0.5, WALL_HEIGHT - 0.05, j + 0.5, 0x3e3a36));
        } else {
          parts.push(box(1, 1, 1, i + 0.5, 0.5, j + 0.5, WAINSCOT));
          parts.push(box(1, WALL_HEIGHT - 1, 1, i + 0.5, 1 + (WALL_HEIGHT - 1) / 2, j + 0.5, PAPER[room?.kind ?? RoomKind.Hall]));
        }
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** Lintels over every doorway, so the gaps read as doors. */
  private doorFrames(): THREE.Mesh {
    const parts: THREE.BufferGeometry[] = [];
    for (const d of this.manor.doors) {
      const i = d % SIZE;
      const j = (d - i) / SIZE;
      parts.push(box(1, WALL_HEIGHT - 2.3, 1, i + 0.5, 2.3 + (WALL_HEIGHT - 2.3) / 2, j + 0.5, 0x2e2119));
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  private nearestRoom(i: number, j: number): { kind: RoomKind } | null {
    for (const [di, dj] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
      [1, 1],
      [-1, -1],
    ]) {
      const r = this.manor.room(i + di + 0.5, j + dj + 0.5);
      if (r) return r;
    }
    return null;
  }

  private buildCeilings(): THREE.Mesh {
    const { manor } = this;
    const parts: THREE.BufferGeometry[] = [];
    for (let j = HOUSE.y0; j <= HOUSE.y1; j++) {
      for (let i = HOUSE.x0; i <= HOUSE.x1; i++) {
        if (manor.tile(i, j) === Tile.Wall) continue;
        parts.push(paint(new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2).translate(i + 0.5, WALL_HEIGHT, j + 0.5), (i + j) % 7 === 0 ? 0x241a14 : 0x2c211a));
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** Iron railings with spikes, stone posts at the corners and either side of the gate. */
  private fence(): THREE.Mesh {
    const { manor } = this;
    const parts: THREE.BufferGeometry[] = [];
    const IRON = 0x1f1d22;
    for (let j = FENCE_MIN; j <= FENCE_MAX; j++) {
      for (let i = FENCE_MIN; i <= FENCE_MAX; i++) {
        if (manor.tile(i, j) !== Tile.Fence) continue;
        const alongX = j === FENCE_MIN || j === FENCE_MAX;
        const corner = (i === FENCE_MIN || i === FENCE_MAX) && (j === FENCE_MIN || j === FENCE_MAX);
        const post = corner || (j === GATE.y && (i === GATE.x0 - 1 || i === GATE.x1 + 1)) || (alongX ? i : j) % 8 === 0;
        if (post) {
          parts.push(box(0.6, 2.4, 0.6, i + 0.5, 1.2, j + 0.5, 0x4d4843));
          parts.push(box(0.75, 0.2, 0.75, i + 0.5, 2.45, j + 0.5, 0x3d3935));
          continue;
        }
        parts.push(...railing(i, j, alongX, IRON));
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** The gate: two leaves that swing inward once it's unlocked, and lanterns either side. */
  private buildGate(): { left: THREE.Group; right: THREE.Group; open: number } {
    const IRON = 0x2a2730;
    const width = GATE.x1 - GATE.x0 + 1;
    const half = width / 2;
    const leaf = (sign: number): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(sign < 0 ? GATE.x0 : GATE.x1 + 1, 0, GATE.y + 0.5);
      const parts: THREE.BufferGeometry[] = [];
      for (let k = 0; k < half * 4; k++) {
        const x = sign * -(0.12 + k * 0.25);
        parts.push(box(0.05, 2.3, 0.05, x, 1.15, 0, IRON), box(0.03, 0.2, 0.03, x, 2.4, 0, IRON));
      }
      parts.push(box(half, 0.08, 0.07, sign * -half / 2, 0.35, 0, IRON), box(half, 0.08, 0.07, sign * -half / 2, 1.95, 0, IRON));
      g.add(new THREE.Mesh(merge(parts), SOLID));
      this.scene.add(g);
      return g;
    };
    for (const x of [GATE.x0 - 0.5, GATE.x1 + 1.5]) this.flame(x, GATE.y + 0.5, 2.8, 1.6, 0xffb35a);
    return { left: leaf(-1), right: leaf(1), open: 0 };
  }

  /** Dead trees and headstones. */
  private trees(): THREE.Mesh {
    const { manor } = this;
    const rnd = mulberry32(manor.seed ^ 0x7e);
    const parts: THREE.BufferGeometry[] = [];
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const t = manor.tile(i, j);
        const x = i + 0.5;
        const y = j + 0.5;
        if (t === Tile.Tree) {
          const h = 4 + rnd() * 3;
          parts.push(paint(new THREE.CylinderGeometry(0.1, 0.3, h, 6).translate(x, h / 2, y), 0x2a211b));
          const branches = 3 + Math.floor(rnd() * 3);
          for (let b = 0; b < branches; b++) {
            const len = 1 + rnd() * 1.6;
            const a = rnd() * Math.PI * 2;
            const at = h * (0.45 + rnd() * 0.45);
            const g = new THREE.CylinderGeometry(0.03, 0.08, len, 4).translate(0, len / 2, 0).rotateZ(0.7 + rnd() * 0.6).rotateY(a).translate(x, at, y);
            parts.push(paint(g, 0x2a211b));
          }
        } else if (t === Tile.Grave) {
          const tilt = (rnd() - 0.5) * 0.3;
          if (rnd() < 0.3) {
            parts.push(paint(new THREE.BoxGeometry(0.12, 1.1, 0.12).rotateX(tilt).translate(x, 0.55, y), 0x6a6660));
            parts.push(paint(new THREE.BoxGeometry(0.12, 0.12, 0.6).rotateX(tilt).translate(x, 0.8, y), 0x6a6660));
          } else {
            parts.push(paint(new THREE.BoxGeometry(0.18, 0.85, 0.7).rotateX(tilt).translate(x, 0.42, y), jitter(0x5f5b56, rnd, 0.1)));
          }
          parts.push(box(0.9, 0.06, 0.5, x + 0.55, 0.03, y, 0x2f2a24));
        }
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** Each room's furniture, cell by cell. */
  private furniture(): THREE.Mesh {
    const { manor } = this;
    const rnd = mulberry32(manor.seed ^ 0xfa);
    const parts: THREE.BufferGeometry[] = [];
    for (let j = HOUSE.y0; j <= HOUSE.y1; j++) {
      for (let i = HOUSE.x0; i <= HOUSE.x1; i++) {
        if (manor.tile(i, j) !== Tile.Furniture) continue;
        const x = i + 0.5;
        const y = j + 0.5;
        switch (manor.pieces[Manor.index(i, j)] as Piece) {
          case Piece.Shelf:
            parts.push(box(0.9, 2.4, 0.9, x, 1.2, y, 0x3a2618));
            for (let k = 0; k < 4; k++) {
              for (let b = 0; b < 4; b++) {
                const c = [0x6b2a22, 0x2a4a3a, 0x7a6a3a, 0x2a3354, 0x4a2a4a][Math.floor(rnd() * 5)];
                parts.push(box(0.94, 0.4, 0.2 + rnd() * 0.02, x, 0.35 + k * 0.55, y - 0.3 + b * 0.2, c));
              }
            }
            break;
          case Piece.Table:
          case Piece.Desk:
            parts.push(box(1, 0.08, 1, x, 0.78, y, 0x4a2f1c));
            parts.push(box(0.08, 0.76, 0.08, x - 0.4, 0.38, y - 0.4, 0x3a2416), box(0.08, 0.76, 0.08, x + 0.4, 0.38, y + 0.4, 0x3a2416));
            if (rnd() < 0.3) parts.push(box(0.08, 0.25, 0.08, x + rnd() * 0.4 - 0.2, 0.95, y, 0xc9c0a8));
            break;
          case Piece.Bed:
            parts.push(box(1, 0.45, 1, x, 0.22, y, 0x3a2a24), box(0.96, 0.15, 0.96, x, 0.52, y, 0x8a8278));
            break;
          case Piece.Chest:
            parts.push(box(0.8, 0.6, 0.6, x, 0.3, y, 0x4d3420), box(0.82, 0.06, 0.62, x, 0.55, y, 0x6b5a34));
            break;
          case Piece.Piano:
            parts.push(box(1, 1.1, 1, x, 0.55, y, 0x111013), box(0.2, 0.05, 0.9, x + 0.45, 0.8, y, 0xd8d2c2));
            break;
          case Piece.Statue:
            parts.push(box(0.8, 0.5, 0.8, x, 0.25, y, 0x6a6660), paint(new THREE.CylinderGeometry(0.18, 0.25, 1.6, 7).translate(x, 1.3, y), 0x8a857c), paint(new THREE.SphereGeometry(0.2, 7, 6).translate(x, 2.25, y), 0x8a857c));
            break;
          case Piece.Couch:
            parts.push(box(0.95, 0.45, 0.95, x, 0.23, y, 0x4a2430), box(0.95, 0.5, 0.25, x, 0.7, y - 0.35, 0x3e1e28));
            break;
        }
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** The stone pedestal the keys go in, with a socket for each. */
  private pedestal(): THREE.Mesh {
    const parts: THREE.BufferGeometry[] = [];
    const cx = PEDESTAL.cx;
    const cy = PEDESTAL.cy;
    parts.push(box(2, 0.3, 2, cx, 0.15, cy, 0x4d4843), box(1.5, 0.75, 1.5, cx, 0.65, cy, 0x6a6560), box(1.9, 0.12, 1.9, cx, 1.05, cy, 0x57524c));
    for (const s of SOCKETS) {
      parts.push(paint(new THREE.CylinderGeometry(0.18, 0.12, 0.08, 10).translate(s.x, 1.12, s.y), 0x2a2622));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffc94a, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.12, depthWrite: false, fog: false }));
      glow.position.set(s.x, 1.3, s.y);
      glow.scale.setScalar(0.9);
      this.sockets.push(glow);
      this.scene.add(glow);
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** Candles in sconces on the walls, and a few on tables: pools of light to steer by in the dark. */
  private candles(): void {
    const { manor } = this;
    const parts: THREE.BufferGeometry[] = [];
    for (const s of manor.sconces) {
      const x = s.x + s.dx * 0.42;
      const y = s.y + s.dy * 0.42;
      parts.push(box(0.12, 0.05, 0.12, x, 1.75, y, 0x6b5a34), box(0.05, 0.2, 0.05, x, 1.87, y, 0xe6dcc0));
      this.candleMeshes.push(this.flame(x, y, 2.02, 0.7, 0xffb050));
    }
    const holders = new THREE.Mesh(merge(parts), SOLID);
    this.candleMeshes.push(holders);
    this.scene.add(holders);
  }

  private flame(x: number, y: number, z: number, size: number, color: number): THREE.Group {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.9 }));
    sprite.scale.setScalar(size);
    // in a group of its own, so a candle can be lowered with the walls it's on
    const group = new THREE.Group();
    sprite.position.set(x, z, y);
    group.add(sprite);
    this.scene.add(group);
    this.flames.push({ sprite, base: size, phase: Math.random() * 10 });
    return group;
  }
}

/** Railings along one fence cell: bars with spikes between two rails. */
function railing(i: number, j: number, alongX: boolean, color: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const x = i + 0.5;
  const y = j + 0.5;
  for (let k = 0; k < 4; k++) {
    const o = -0.375 + k * 0.25;
    const bx = alongX ? x + o : x;
    const by = alongX ? y : y + o;
    parts.push(box(0.05, 2.1, 0.05, bx, 1.05, by, color), box(0.03, 0.18, 0.03, bx, 2.18, by, color));
  }
  parts.push(box(alongX ? 1 : 0.06, 0.07, alongX ? 0.06 : 1, x, 0.3, y, color), box(alongX ? 1 : 0.06, 0.07, alongX ? 0.06 : 1, x, 1.85, y, color));
  return parts;
}

function jitter(color: number, rnd: () => number, amount: number): number {
  const k = 1 + (rnd() - 0.5) * amount * 2;
  const r = Math.min(255, ((color >> 16) & 0xff) * k);
  const g = Math.min(255, ((color >> 8) & 0xff) * k);
  const b = Math.min(255, (color & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}
