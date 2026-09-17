import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { SOLID, box, glowTexture, merge, paint } from '../crossplay/models';
import { BuildingKind, Castle, GATE, KEEP_HEIGHT, LANTERN_REACH, SIZE, Tile, WALL, WALL_HEIGHT, type Building } from './castle';
import { lightPool } from './models';

/** How a peer sees the castle: a shinobi in the night, or the captain looking down on a map of it. */
export type ViewKind = 'shinobi' | 'captain';

const NIGHT = 0x070b16;
/** How much of their height things keep on the captain's map, so nothing tall hides the ground behind it. */
export const MAP_FLATTEN = 0.3;

const PLASTER = 0xd8d2c4;
const TIMBER = 0x3a2a1e;
const TILES = 0x2c3036;
const STONE = 0x6a665f;

/**
 * The castle as it's drawn: the forest, the stone wall with its tiled cap and its gate, watchtowers, the keep and the
 * halls, storehouses, tea houses and shrines, bushes, stone lanterns with their pools of light, and a moon. Everything
 * comes from the same grid the rules walk on (castle.ts): what looks like a roof is where you can stand.
 *
 * A shinobi sees it by moonlight, lanterns glowing in the dark. The captain sees the same castle lit up from above with
 * everything tall cut down (`setView`), a map to point at.
 */
export class Scenery {
  private readonly hemi = new THREE.HemisphereLight(0x6a7eb8, 0x141820, 0.7);
  private readonly moon = new THREE.DirectionalLight(0xa8bce8, 0.55);
  /** Everything tall, that flattens on the captain's map. */
  private readonly tall = new THREE.Group();
  private readonly flames: { sprite: THREE.Sprite; base: number; phase: number }[] = [];
  private readonly pools: THREE.Mesh[] = [];
  private t = 0;
  view: ViewKind = 'shinobi';
  /** How tall things are drawn: 1, or `MAP_FLATTEN` on the captain's map. Views put bodies on roofs with it. */
  heightScale = 1;

  constructor(
    private readonly castle: Castle,
    private readonly scene: THREE.Scene,
  ) {
    scene.add(this.hemi, this.moon, this.tall);
    this.moon.position.set(-0.5, 1, 0.4);
    scene.add(this.sky(), this.ground());
    this.tall.add(this.walls(), this.buildings(), this.bushes(), this.trees(), this.gatehouse());
    this.lanterns();
    this.setView('shinobi');
  }

  setView(view: ViewKind): void {
    this.view = view;
    const { scene } = this;
    if (view === 'captain') {
      scene.background = new THREE.Color(0x0d1220);
      scene.fog = null;
      this.hemi.color.setHex(0xb8c4e8);
      this.hemi.groundColor.setHex(0x3a3a48);
      this.hemi.intensity = 2;
      this.moon.intensity = 1.2;
      this.heightScale = MAP_FLATTEN;
    } else {
      scene.background = new THREE.Color(NIGHT);
      scene.fog = new THREE.FogExp2(NIGHT, 0.026);
      this.hemi.color.setHex(0x6a7eb8);
      this.hemi.groundColor.setHex(0x141820);
      this.hemi.intensity = 0.75;
      this.moon.intensity = 0.6;
      this.heightScale = 1;
    }
    this.tall.scale.y = this.heightScale;
    for (const f of this.flames) f.sprite.position.y = (f.sprite.userData.z as number) * this.heightScale;
    for (const p of this.pools) p.visible = view === 'shinobi';
  }

  /** Lanterns flicker. */
  update(dt: number): void {
    this.t += dt;
    for (const f of this.flames) {
      const k = 0.88 + Math.sin(this.t * 8 + f.phase) * 0.05 + Math.sin(this.t * 19 + f.phase * 3) * 0.04 + (Math.random() - 0.5) * 0.04;
      f.sprite.scale.setScalar(f.base * k);
    }
  }

  // -------------------------------------------------------------------------

  private sky(): THREE.Group {
    const sky = new THREE.Group();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xdfe8ff, fog: false, depthWrite: false, transparent: true }));
    glow.scale.setScalar(90);
    glow.position.set(-300, 320, 380);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(12, 28), new THREE.MeshBasicMaterial({ color: 0xf0f3ff, fog: false }));
    disc.position.copy(glow.position);
    disc.lookAt(48, 0, 48);
    const rnd = mulberry32(77);
    const stars = new Float32Array(1100 * 3);
    for (let i = 0; i < 1100; i++) {
      const a = rnd() * Math.PI * 2;
      const e = 0.1 + rnd() * 1.4;
      stars[i * 3] = 48 + Math.cos(a) * Math.cos(e) * 800;
      stars[i * 3 + 1] = Math.sin(e) * 800;
      stars[i * 3 + 2] = 48 + Math.sin(a) * Math.cos(e) * 800;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    sky.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xb4bed8, size: 1.5, sizeAttenuation: false, fog: false })), glow, disc);
    return sky;
  }

  /** Forest floor, raked gravel, the stone path, and dark hills beyond. */
  private ground(): THREE.Group {
    const { castle } = this;
    const rnd = mulberry32(castle.seed ^ 0x51);
    const parts: THREE.BufferGeometry[] = [];
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const t = castle.tile(i, j);
        let c: number;
        if (t === Tile.Grass || t === Tile.Tree || t === Tile.Out) c = jitter(0x1f2b1c, rnd, 0.2);
        else if (t === Tile.Path || t === Tile.Gate) c = (i + j) % 2 ? 0x77736a : 0x6c685f;
        else if (t === Tile.Gravel || t === Tile.Lantern) c = jitter(0x8a857a, rnd, 0.05);
        else if (t === Tile.Bush) c = jitter(0x3a4a30, rnd, 0.1);
        else continue;
        parts.push(paint(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(i + 0.5, 0, j + 0.5), c));
      }
    }
    const group = new THREE.Group();
    group.add(new THREE.Mesh(merge(parts), SOLID));
    const field = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2).translate(48, -0.03, 48), new THREE.MeshLambertMaterial({ color: 0x141c13 }));
    group.add(field);
    return group;
  }

  /** The compound wall: stone below, white plaster above, and a tiled cap along the top, which is where you walk. */
  private walls(): THREE.Mesh {
    const { castle } = this;
    const parts: THREE.BufferGeometry[] = [];
    for (let j = WALL.y0; j <= WALL.y1; j++) {
      for (let i = WALL.x0; i <= WALL.x1; i++) {
        if (castle.tile(i, j) !== Tile.Wall) continue;
        const x = i + 0.5;
        const z = j + 0.5;
        const alongX = j === WALL.y0 || j === WALL.y1;
        parts.push(box(1, 1.6, 1, x, 0.8, z, (i + j) % 3 ? STONE : 0x5f5b55));
        parts.push(box(0.9, WALL_HEIGHT - 1.9, 0.9, x, 1.6 + (WALL_HEIGHT - 1.9) / 2, z, PLASTER));
        // the tiled cap, overhanging either side
        parts.push(box(alongX ? 1 : 1.5, 0.3, alongX ? 1.5 : 1, x, WALL_HEIGHT - 0.15, z, TILES));
        if ((alongX ? i : j) % 4 === 0) parts.push(box(alongX ? 0.14 : 0.92, 0.9, alongX ? 0.92 : 0.14, x, 2.3, z, TIMBER));
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** A roofed beam over the gateway (just for looks: it can't be stood on). */
  private gatehouse(): THREE.Mesh {
    const w = GATE.x1 - GATE.x0 + 1;
    const cx = (GATE.x0 + GATE.x1 + 1) / 2;
    const z = GATE.y + 0.5;
    return new THREE.Mesh(
      merge([box(w, 0.5, 0.7, cx, WALL_HEIGHT - 0.6, z, TIMBER), box(w + 1.2, 0.3, 1.8, cx, WALL_HEIGHT + 0.1, z, TILES), box(w + 0.6, 0.25, 1.2, cx, WALL_HEIGHT + 0.35, z, 0x24272c)]),
      SOLID,
    );
  }

  /** Every building, tower and the keep. */
  private buildings(): THREE.Mesh {
    const parts: THREE.BufferGeometry[] = [];
    for (const b of this.castle.buildings) {
      if (b.kind === BuildingKind.Keep) this.keep(b, parts);
      else if (b.kind === BuildingKind.Tower) this.tower(b, parts);
      else this.house(b, parts);
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** A hall, storehouse, tea house or shrine: a stone footing, plaster and timber walls, a tiled roof with eaves. */
  private house(b: Building, parts: THREE.BufferGeometry[]): void {
    const w = b.x1 - b.x0 + 1;
    const d = b.y1 - b.y0 + 1;
    const cx = b.x0 + w / 2;
    const cz = b.y0 + d / 2;
    const h = b.height;
    const wall = b.kind === BuildingKind.Storehouse ? 0xe8e2d4 : b.kind === BuildingKind.Shrine ? 0x8a2a22 : PLASTER;
    const roof = b.kind === BuildingKind.TeaHouse ? 0x4a3a28 : TILES;
    parts.push(box(w, 0.5, d, cx, 0.25, cz, STONE));
    parts.push(box(w - 0.1, h - 0.9, d - 0.1, cx, 0.5 + (h - 0.9) / 2, cz, wall));
    // timber posts at the corners and along the sides
    for (let k = 0; k <= w; k += 2) for (const zz of [b.y0 + 0.02, b.y1 + 0.98]) parts.push(box(0.16, h - 0.9, 0.16, b.x0 + Math.min(k, w - 0.08) + 0.04, 0.5 + (h - 0.9) / 2, zz, TIMBER));
    for (let k = 0; k <= d; k += 2) for (const xx of [b.x0 + 0.02, b.x1 + 0.98]) parts.push(box(0.16, h - 0.9, 0.16, xx, 0.5 + (h - 0.9) / 2, b.y0 + Math.min(k, d - 0.08) + 0.04, TIMBER));
    parts.push(box(w + 0.2, 0.18, d + 0.2, cx, h - 0.45, cz, TIMBER));
    // a door on the south side
    parts.push(box(1.4, 1.9, 0.06, cx, 1.45, b.y0 - 0.02, 0x2a1d14));
    // the roof: eaves overhanging, and a flat top where you can stand, with a ridge along it
    parts.push(box(w + 1.2, 0.25, d + 1.2, cx, h - 0.3, cz, roof));
    parts.push(box(w + 0.4, 0.1, d + 0.4, cx, h - 0.05, cz, roof));
    parts.push(w >= d ? box(w, 0.08, 0.25, cx, h + 0.02, cz, 0x1d2024) : box(0.25, 0.08, d, cx, h + 0.02, cz, 0x1d2024));
  }

  /** The keep: a great stone base, two storeys of white plaster between tiers of eaves, and gold fish on the ridge. */
  private keep(b: Building, parts: THREE.BufferGeometry[]): void {
    const w = b.x1 - b.x0 + 1;
    const d = b.y1 - b.y0 + 1;
    const cx = b.x0 + w / 2;
    const cz = b.y0 + d / 2;
    const h = KEEP_HEIGHT;
    parts.push(box(w, 3, d, cx, 1.5, cz, 0x5e5a53));
    for (let k = 0; k < 6; k++) parts.push(box(w + 0.02, 0.06, d + 0.02, cx, 0.4 + k * 0.5, cz, 0x4e4a44));
    parts.push(box(w - 0.3, h - 3.4, d - 0.3, cx, 3 + (h - 3.4) / 2, cz, PLASTER));
    for (const [y, over] of [
      [3.2, 0.9],
      [6.2, 0.7],
    ] as const) {
      parts.push(box(w + over * 2, 0.28, d + over * 2, cx, y, cz, TILES));
      parts.push(box(w + 0.1, 0.2, d + 0.1, cx, y + 0.3, cz, TIMBER));
    }
    // windows
    for (let k = 1; k < w - 1; k += 3) {
      parts.push(box(0.6, 0.5, 0.06, b.x0 + k + 0.5, 4.7, b.y0 + 0.1, 0x1a1410), box(0.6, 0.5, 0.06, b.x0 + k + 0.5, 7.6, b.y0 + 0.1, 0x1a1410));
      parts.push(box(0.6, 0.5, 0.06, b.x0 + k + 0.5, 4.7, b.y1 + 0.9, 0x1a1410), box(0.6, 0.5, 0.06, b.x0 + k + 0.5, 7.6, b.y1 + 0.9, 0x1a1410));
    }
    parts.push(box(2.4, 2.4, 0.08, cx, 1.2, b.y0 - 0.03, 0x2a1d14));
    parts.push(box(w + 1.4, 0.3, d + 1.4, cx, h - 0.25, cz, TILES));
    parts.push(box(w + 0.4, 0.12, d + 0.4, cx, h - 0.04, cz, TILES));
    parts.push(box(w - 1, 0.12, 0.35, cx, h + 0.05, cz, 0x1d2024));
    for (const x of [b.x0 + 1, b.x1]) parts.push(paint(new THREE.ConeGeometry(0.18, 0.7, 5).rotateZ(x < cx ? 0.5 : -0.5).translate(x, h + 0.4, cz), 0xd6b04a));
  }

  /** A watchtower: a solid timber and plaster base, a railed platform on top, and a little roof over it on posts. */
  private tower(b: Building, parts: THREE.BufferGeometry[]): void {
    const w = b.x1 - b.x0 + 1;
    const cx = b.x0 + w / 2;
    const cz = b.y0 + w / 2;
    const h = b.height;
    parts.push(box(w, 1.2, w, cx, 0.6, cz, STONE));
    parts.push(box(w - 0.2, h - 1.2, w - 0.2, cx, 1.2 + (h - 1.2) / 2, cz, 0xcfc8b8));
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ])
      parts.push(box(0.22, h + 2.3, 0.22, cx + dx * (w / 2 - 0.12), (h + 2.3) / 2, cz + dz * (w / 2 - 0.12), TIMBER));
    parts.push(box(w + 0.3, 0.2, w + 0.3, cx, h - 0.1, cz, TIMBER));
    for (const s of [-1, 1]) {
      parts.push(box(w, 0.08, 0.08, cx, h + 0.9, cz + s * (w / 2 - 0.05), TIMBER));
      parts.push(box(0.08, 0.08, w, cx + s * (w / 2 - 0.05), h + 0.9, cz, TIMBER));
    }
    parts.push(box(w + 1, 0.25, w + 1, cx, h + 2.4, cz, TILES));
  }

  /** Round clipped bushes. */
  private bushes(): THREE.Mesh {
    const { castle } = this;
    const rnd = mulberry32(castle.seed ^ 0xb5);
    const parts: THREE.BufferGeometry[] = [];
    for (let j = WALL.y0; j <= WALL.y1; j++) {
      for (let i = WALL.x0; i <= WALL.x1; i++) {
        if (castle.tile(i, j) !== Tile.Bush) continue;
        const s = 0.75 + rnd() * 0.25;
        parts.push(paint(new THREE.IcosahedronGeometry(0.62 * s, 1).scale(1.1, 0.8, 1.1).translate(i + 0.5 + (rnd() - 0.5) * 0.2, 0.45 * s, j + 0.5 + (rnd() - 0.5) * 0.2), jitter(0x2f4a2a, rnd, 0.15)));
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** Pines in the forest round the castle. */
  private trees(): THREE.Mesh {
    const { castle } = this;
    const rnd = mulberry32(castle.seed ^ 0x7e);
    const parts: THREE.BufferGeometry[] = [];
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        if (castle.tile(i, j) !== Tile.Tree) continue;
        const x = i + 0.5 + (rnd() - 0.5) * 0.3;
        const z = j + 0.5 + (rnd() - 0.5) * 0.3;
        const h = 7 + rnd() * 5;
        parts.push(paint(new THREE.CylinderGeometry(0.14, 0.26, h, 5).translate(x, h / 2, z), 0x2a2019));
        for (let k = 0; k < 3; k++) {
          const r = 1.9 - k * 0.5;
          parts.push(paint(new THREE.ConeGeometry(r, 2.6, 7).translate(x, h * 0.45 + k * 1.6, z), jitter(0x1b3322, rnd, 0.15)));
        }
      }
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** Stone lanterns, lit, with a pool of warm light round each. */
  private lanterns(): void {
    const parts: THREE.BufferGeometry[] = [];
    for (const l of this.castle.lanterns) {
      const { x, y: z } = l;
      parts.push(box(0.55, 0.15, 0.55, x, 0.08, z, 0x7a766e), paint(new THREE.CylinderGeometry(0.1, 0.12, 0.6, 6).translate(x, 0.45, z), 0x86827a));
      parts.push(box(0.45, 0.08, 0.45, x, 0.78, z, 0x7a766e), box(0.34, 0.26, 0.34, x, 0.95, z, 0x86827a), box(0.36, 0.2, 0.36, x, 0.95, z, 0xffc070));
      parts.push(paint(new THREE.ConeGeometry(0.42, 0.25, 4).rotateY(Math.PI / 4).translate(x, 1.2, z), 0x7a766e));
      this.flame(x, z, 0.95, 0.9, 0xffb050);
      const pool = lightPool(LANTERN_REACH * 0.75);
      pool.position.set(x, 0.02, z);
      this.pools.push(pool);
      this.scene.add(pool);
    }
    this.tall.add(new THREE.Mesh(merge(parts), SOLID));
  }

  private flame(x: number, z: number, y: number, size: number, color: number): void {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.9 }));
    sprite.scale.setScalar(size);
    sprite.position.set(x, y, z);
    sprite.userData.z = y;
    this.scene.add(sprite);
    this.flames.push({ sprite, base: size, phase: Math.random() * 10 });
  }
}

function jitter(color: number, rnd: () => number, amount: number): number {
  const k = 1 + (rnd() - 0.5) * amount * 2;
  const r = Math.min(255, ((color >> 16) & 0xff) * k);
  const g = Math.min(255, ((color >> 8) & 0xff) * k);
  const b = Math.min(255, (color & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}
