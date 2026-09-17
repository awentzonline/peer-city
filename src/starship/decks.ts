import * as THREE from 'three';
import { mulberry32, type EntityViews, type PayloadOf } from '@engine/index';
import { bodyView, poseBody, type BodyView } from '../crossplay/avatarView';
import { SOLID, box, disposeLabel, merge, paint, setLabel } from '../crossplay/models';
import { ParticleLayer, rand } from '../crossplay/particles';
import { labelTexture } from '../crossplay/textures';
import type { CrewEntity, FaultEntity, RelicEntity, SentinelEntity, StarshipContext } from './context';
import { CELL, CONSOLES, MACHINES, PAD, RACK, ROOMS, SHIP, SITE_SIZE, TUBES, Tile, VIEWSCREEN, WALL_HEIGHT } from './deck';
import { Beam3, Carry, Crew, CrewMode, Fault, FaultKind, Noise, Relic, Sentinel, ShipSystem, Shot, Sound, Station } from './defs';
import { EXTINGUISHER, TOOLS } from './kit';
import { GLOW, STATION_COLORS, biomeColors, crewModel, glowSprite, relicModel, sentinelModel, torpedoCasing } from './models';
import { efficiency } from './ship';
import { beamMesh } from './space';

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

interface CrewView extends BodyView {
  name: string;
  beams: number;
  torpedo: THREE.Mesh;
  t: number;
}

interface Fading {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  age: number;
  life: number;
}

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own crew member, e.g. from a chase camera. */
  showSelf(): boolean;
}

/**
 * The decks as they're drawn, in the game's main scene: the ship's interior, room by room from the same grid the crew
 * walk on (deck.ts), with the bridge's consoles and its viewscreen, the transporter pad, the torpedo rack and tubes and
 * each system's machine; and the away sites on the planets, with their rocks, ruins and plinths. Crew, sentinels,
 * faults and relics are drawn here too, with the hand phaser's beams, sentinels' bolts, sparks, fires and transporter
 * shimmer. Red alert turns the lights red.
 */
export class DeckView {
  /** What the bridge's viewscreen shows: space, drawn into it each frame someone's aboard to see it. */
  readonly screen = new THREE.WebGLRenderTarget(1024, 436);
  readonly viewscreen: THREE.Mesh;
  private readonly hemi = new THREE.HemisphereLight(0xdde6f4, 0x3a4250, 1.5);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 0.6);
  private readonly strips: THREE.MeshBasicMaterial;
  private readonly machines = new Map<ShipSystem, THREE.MeshBasicMaterial>();
  private readonly tubeLights: THREE.MeshBasicMaterial[] = [];
  private readonly rackTorps: THREE.Mesh[] = [];
  private readonly padGlow: THREE.MeshBasicMaterial;
  /** Each console's lit top and its floating name, which a headset's own console panels stand in for. */
  private readonly consoleDressing = new Map<Station, THREE.Object3D[]>();
  private readonly sparks = new ParticleLayer(1500, true);
  private readonly smoke = new ParticleLayer(500, false);
  private readonly fading: Fading[] = [];
  private readonly sky: Record<number, THREE.Color> = {};
  /** The ship's interior, and each away site: only the one the camera's in is drawn. */
  private readonly interior = new THREE.Group();
  private readonly sites: THREE.Group[] = [];
  /** Things on the decks, each in a holder shown only while the camera's in the same place. */
  private readonly placed = new Map<THREE.Object3D, () => number>();
  private shimmer = 0;
  private t = 0;

  constructor(
    private readonly ctx: StarshipContext,
    readonly scene: THREE.Scene,
    views: EntityViews,
    local: LocalView,
  ) {
    scene.background = new THREE.Color(0x0a0c12);
    this.sun.position.set(0.3, 1, 0.5);
    scene.add(this.hemi, this.sun, this.sparks.mesh, this.smoke.mesh);
    this.strips = new THREE.MeshBasicMaterial({ color: 0x9ad8ff, fog: false });
    this.padGlow = new THREE.MeshBasicMaterial({ color: 0x6ad0ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });

    this.buildInterior();
    this.viewscreen = new THREE.Mesh(new THREE.PlaneGeometry(VIEWSCREEN.width, VIEWSCREEN.height), new THREE.MeshBasicMaterial({ map: this.screen.texture, fog: false }));
    this.viewscreen.rotation.y = -Math.PI / 2;
    this.viewscreen.position.set(VIEWSCREEN.x - 0.08, VIEWSCREEN.z, VIEWSCREEN.y);
    this.interior.add(this.viewscreen);
    scene.add(this.interior);
    this.buildSites();
    this.registerViews(views, local);
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  private buildInterior(): void {
    const { deck } = this.ctx;
    const walls: THREE.BufferGeometry[] = [];
    const trims: THREE.BufferGeometry[] = [];
    const floorAt = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < deck.cols && cy < deck.rows && deck.tiles[cy * deck.cols + cx] !== Tile.Solid;
    for (let cy = -1; cy <= Math.ceil(SHIP.y1 / CELL) + 1; cy++) {
      for (let cx = -1; cx <= Math.ceil(SHIP.x1 / CELL) + 1; cx++) {
        if (floorAt(cx, cy)) continue;
        if (!floorAt(cx + 1, cy) && !floorAt(cx - 1, cy) && !floorAt(cx, cy + 1) && !floorAt(cx, cy - 1)) continue;
        const x = (cx + 0.5) * CELL;
        const y = (cy + 0.5) * CELL;
        walls.push(box(CELL, WALL_HEIGHT, CELL, x, WALL_HEIGHT / 2, y, (cx + cy) % 4 === 0 ? 0xaab2be : 0xbcc4d0));
        walls.push(box(CELL + 0.02, 0.25, CELL + 0.02, x, 0.12, y, 0x3a404c));
        trims.push(box(CELL + 0.03, 0.05, CELL + 0.03, x, 1.2, y, 0xffffff));
      }
    }
    const floors: THREE.BufferGeometry[] = [];
    for (const r of ROOMS) {
      const color = r.name === 'Bridge' ? 0x2a3444 : r.name === 'Corridor' ? 0x3a404a : r.name === 'Transporter Room' ? 0x2e3a4a : 0x363c46;
      floors.push(paint(new THREE.PlaneGeometry(r.x1 - r.x0, r.y1 - r.y0).rotateX(-Math.PI / 2).translate((r.x0 + r.x1) / 2, 0, (r.y0 + r.y1) / 2), color));
    }
    // doorways' floors
    floors.push(paint(new THREE.PlaneGeometry(SHIP.x1, SHIP.y1).rotateX(-Math.PI / 2).translate(SHIP.x1 / 2, -0.01, SHIP.y1 / 2), 0x30343c));
    const ceiling = paint(new THREE.PlaneGeometry(SHIP.x1 + 1, SHIP.y1 + 1).rotateX(Math.PI / 2).translate(SHIP.x1 / 2, WALL_HEIGHT, SHIP.y1 / 2), 0x1e222a);
    for (let x = 2; x < SHIP.x1; x += 4) trims.push(box(0.15, 0.02, 12, x, WALL_HEIGHT - 0.02, 7, 0xffffff));
    this.interior.add(new THREE.Mesh(merge([...walls, ...floors, ceiling]), SOLID));
    this.interior.add(new THREE.Mesh(merge(trims), this.strips));

    // consoles
    for (const c of CONSOLES) {
      const g = new THREE.Group();
      g.position.set(c.x, 0, c.y);
      g.rotation.y = -c.heading;
      const top = new THREE.Mesh(paint(new THREE.PlaneGeometry(0.8, 0.45).rotateX(-Math.PI / 2).rotateZ(0.9).translate(0.05, 1.02, 0), STATION_COLORS[c.station]), GLOW);
      g.add(new THREE.Mesh(merge([box(0.7, 0.9, 1, 0, 0.45, 0, 0x4a5262), box(0.5, 0.06, 0.9, -0.1, 0.95, 0, 0x2a2e38)]), SOLID), top);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(['HELM', 'TACTICAL', 'SCIENCE', 'ENGINEERING'][c.station]), transparent: true, depthWrite: false }));
      label.scale.set(0.9, 0.23, 1);
      label.position.set(0, 1.45, 0);
      g.add(label);
      this.consoleDressing.set(c.station, [top, label]);
      this.interior.add(g);
    }
    // the captain's chair, and the viewscreen's frame
    this.interior.add(new THREE.Mesh(merge([box(0.7, 0.5, 0.7, 28.4, 0.25, 7, 0x6a3a2a), box(0.15, 0.8, 0.7, 28.05, 0.9, 7, 0x6a3a2a), box(0.12, 0.25, 0.12, 28.4, 0.12, 7, 0x2a2e38)]), SOLID));
    this.interior.add(new THREE.Mesh(box(0.1, VIEWSCREEN.height + 0.3, VIEWSCREEN.width + 0.3, VIEWSCREEN.x, VIEWSCREEN.z, VIEWSCREEN.y, 0x1a1c22), SOLID));

    // room names over the doors
    for (const r of ROOMS) {
      if (r.name === 'Corridor') continue;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(r.name.toUpperCase()), transparent: true, depthWrite: false, opacity: 0.8 }));
      label.scale.set(1.6, 0.4, 1);
      label.position.set(r.name === 'Bridge' ? r.x0 + 1.2 : (r.x0 + r.x1) / 2, 2.7, (r.y0 + r.y1) / 2);
      this.interior.add(label);
    }

    // the transporter pad
    this.interior.add(new THREE.Mesh(merge([paint(new THREE.CylinderGeometry(PAD.radius, PAD.radius + 0.1, 0.12, 24).translate(PAD.x, 0.06, PAD.y), 0x5a6272)]), SOLID));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.34, 16).rotateX(-Math.PI / 2), this.padGlow);
      disc.position.set(PAD.x + Math.cos(a) * 0.72, 0.13, PAD.y + Math.sin(a) * 0.72);
      this.interior.add(disc);
    }
    const emitter = new THREE.Mesh(new THREE.CylinderGeometry(PAD.radius, PAD.radius, 0.08, 24), this.padGlow);
    emitter.position.set(PAD.x, WALL_HEIGHT - 0.05, PAD.y);
    this.interior.add(emitter);

    // the torpedo rack and tubes
    this.interior.add(new THREE.Mesh(merge([box(2, 0.1, 0.9, RACK.x, 0.3, RACK.y, 0x4a5262), box(2, 0.1, 0.9, RACK.x, 1.0, RACK.y, 0x4a5262), box(0.08, 1.6, 0.9, RACK.x - 1, 0.8, RACK.y, 0x3a404c), box(0.08, 1.6, 0.9, RACK.x + 1, 0.8, RACK.y, 0x3a404c)]), SOLID));
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(torpedoCasing(), SOLID);
      m.rotation.y = Math.PI / 2;
      m.position.set(RACK.x - 0.72 + (i % 5) * 0.36, i < 5 ? 0.52 : 1.22, RACK.y);
      this.rackTorps.push(m);
      this.interior.add(m);
    }
    TUBES.forEach((tube) => {
      this.interior.add(new THREE.Mesh(merge([paint(new THREE.CylinderGeometry(0.32, 0.32, 0.7, 14).rotateZ(Math.PI / 2).translate(tube.x + 0.3, 1, tube.y), 0x2a2e38), box(0.4, 1, 0.9, tube.x + 0.45, 0.5, tube.y, 0x4a5262)]), SOLID));
      const light = new THREE.MeshBasicMaterial({ color: 0x5aff7a });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 6, 16).rotateY(Math.PI / 2), light);
      ring.position.set(tube.x - 0.06, 1, tube.y);
      this.tubeLights.push(light);
      this.interior.add(ring);
    });

    // each system's machine
    const machine = (sys: ShipSystem, solid: THREE.BufferGeometry, glow: THREE.BufferGeometry, color: number) => {
      const m = MACHINES[sys];
      const mat = new THREE.MeshBasicMaterial({ color, fog: false });
      this.machines.set(sys, mat);
      const g = new THREE.Group();
      g.position.set(m.x, 0, m.y);
      g.add(new THREE.Mesh(solid, SOLID), new THREE.Mesh(glow, mat));
      this.interior.add(g);
    };
    machine(
      ShipSystem.Engines,
      merge([paint(new THREE.CylinderGeometry(0.9, 1, 0.4, 16).translate(0, 0.2, 0), 0x4a5262), paint(new THREE.CylinderGeometry(0.9, 1, 0.4, 16).translate(0, WALL_HEIGHT - 0.2, 0), 0x4a5262), ...[0, 1, 2, 3].map((k) => box(0.08, WALL_HEIGHT, 0.08, Math.cos((k * Math.PI) / 2) * 0.75, WALL_HEIGHT / 2, Math.sin((k * Math.PI) / 2) * 0.75, 0x8a929e))]),
      new THREE.CylinderGeometry(0.45, 0.45, WALL_HEIGHT - 0.8, 16).translate(0, WALL_HEIGHT / 2, 0),
      0x6ab8ff,
    );
    machine(ShipSystem.Weapons, merge([box(1.6, 1.3, 1.2, 0, 0.65, 0, 0x4a5262)]), new THREE.BoxGeometry(1.2, 0.5, 0.05).translate(0, 1.0, -0.62), 0xff6a4a);
    machine(ShipSystem.Shields, merge([paint(new THREE.CylinderGeometry(0.8, 0.9, 0.8, 12).translate(0, 0.4, 0), 0x4a5262), paint(new THREE.TorusGeometry(0.75, 0.05, 6, 20).rotateX(Math.PI / 2).translate(0, 1.5, 0), 0x8a929e)]), new THREE.SphereGeometry(0.5, 16, 12).translate(0, 1.5, 0), 0x6aff9a);
    machine(ShipSystem.Sensors, merge([box(0.3, 1.2, 0.3, 0, 0.6, 0, 0x4a5262), paint(new THREE.SphereGeometry(0.9, 16, 8, 0, Math.PI * 2, 0, 1.1).rotateX(0.5).translate(0, 1.2, 0), 0x9aa2ae)]), new THREE.SphereGeometry(0.14, 8, 6).translate(0, 1.9, 0.3), 0xc88aff);
  }

  private buildSites(): void {
    const { deck, sector } = this.ctx;
    for (const site of deck.sites) {
      const planet = sector.planets[site.planet];
      const colors = biomeColors(planet.biome);
      this.sky[site.planet] = new THREE.Color(colors.sky);
      const rand = mulberry32(sector.seed * 7 + site.planet);
      const cx = site.x0 + SITE_SIZE / 2;
      const cy = site.y0 + SITE_SIZE / 2;
      const ground = new THREE.PlaneGeometry(SITE_SIZE + 60, SITE_SIZE + 60, 40, 40).rotateX(-Math.PI / 2);
      const pos = ground.getAttribute('position');
      const col = new Float32Array(pos.count * 3);
      const base = new THREE.Color(colors.ground);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const edge = Math.max(Math.abs(x), Math.abs(z)) - SITE_SIZE / 2;
        if (edge > 1) pos.setY(i, edge * 0.35 + rand() * 1.5);
        c.copy(base).multiplyScalar(0.85 + rand() * 0.3).toArray(col, i * 3);
      }
      ground.setAttribute('color', new THREE.BufferAttribute(col, 3));
      ground.computeVertexNormals();
      ground.translate(cx, 0, cy);
      const parts: THREE.BufferGeometry[] = [ground];
      for (const r of site.rocks) parts.push(paint(new THREE.DodecahedronGeometry(r.r, 0).scale(1, 0.7, 1).rotateY(rand() * 6).translate(r.x, r.r * 0.3, r.y), new THREE.Color(colors.low).multiplyScalar(0.9 + rand() * 0.3).getHex()));
      for (const p of site.pillars) {
        const h = 1.5 + rand() * 2.5;
        parts.push(box(1, h, 1, p.x, h / 2, p.y, 0xb8b0a0), box(1.2, 0.3, 1.2, p.x, h, p.y, 0xa8a090));
      }
      parts.push(paint(new THREE.CylinderGeometry(0.55, 0.7, 1, 8).translate(site.plinth.x, 0.5, site.plinth.y), 0xc8c0b0));
      // the arrival spot
      parts.push(paint(new THREE.RingGeometry(1.8, 2.1, 24).rotateX(-Math.PI / 2).translate(site.arrive.x, 0.03, site.arrive.y), 0x8ad0ff));
      const group = new THREE.Group();
      group.add(new THREE.Mesh(merge(parts), SOLID));
      group.visible = false;
      this.sites.push(group);
      this.scene.add(group);
    }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private registerViews(views: EntityViews, local: LocalView): void {
    const { ctx } = this;
    views.register(Crew, {
      create: (e): CrewView => {
        const rig = crewModel(e.render.skin);
        const torpedo = new THREE.Mesh(torpedoCasing(), SOLID);
        torpedo.position.set(0.45, 1.15, 0);
        torpedo.visible = false;
        rig.body.add(torpedo);
        this.place(rig.root, () => e.x);
        return { ...bodyView(rig, e.x, e.y), name: '', beams: e.render.beams, torpedo, t: 0 };
      },
      update: (v, e: CrewEntity, dt) => {
        const s = e.render;
        const r = v.rig;
        v.t += dt;
        r.root.visible = e !== ctx.me || local.showSelf();
        if (v.name !== s.name) {
          v.name = s.name;
          setLabel(r.label, s.name);
          r.label.visible = true;
        }
        r.label.visible = e !== ctx.me;
        r.root.position.set(e.x, s.z, e.y);
        poseBody(v, s, e.x, e.y, dt, TOOLS);
        v.torpedo.visible = s.carry === Carry.Torpedo;
        if (s.carry !== Carry.Nothing) {
          r.armL.rotation.set(0, 0, 1.2);
          r.armR.rotation.set(0, 0, 1.2);
        }
        if (s.mode === CrewMode.Down) {
          r.body.rotation.set(0, -s.yaw, -Math.PI / 2 + 0.05, 'YXZ');
          r.body.position.y = 0.25;
          r.shadow.visible = false;
        } else if (s.seat) {
          r.legL.rotation.z = r.legR.rotation.z = 1.4;
          r.body.position.y = -0.4;
        }
        if (s.beams !== v.beams) {
          v.beams = s.beams;
          this.shimmer1(e.x, e.y);
        }
        if (s.spray && s.tool === EXTINGUISHER.id) {
          const heading = s.aimYaw;
          const pitch = s.aimPitch >= Math.PI ? s.aimPitch - Math.PI * 2 : s.aimPitch;
          const hx = e.x + s.hx;
          const hy = e.y + s.hy;
          const sp = 5;
          for (let i = 0; i < 3; i++) {
            this.smoke.emit({ x: hx + Math.cos(heading) * 0.35, y: hy + Math.sin(heading) * 0.35, z: s.z + s.hz, vx: Math.cos(heading) * Math.cos(pitch) * sp + rand(-0.6, 0.6), vy: Math.sin(heading) * Math.cos(pitch) * sp + rand(-0.6, 0.6), vz: Math.sin(pitch) * sp + rand(-0.5, 0.5), life: rand(0.4, 0.8), s0: 0.1, s1: 0.8, c0: [0.95, 0.97, 1, 0.7], c1: [0.9, 0.92, 0.95, 0], gravity: 1, drag: 3 });
          }
        }
      },
      destroy: (v) => {
        this.unplace(v.rig.root);
        disposeLabel(v.rig.label);
      },
    });

    views.register(Sentinel, {
      create: (e) => {
        const m = sentinelModel();
        this.place(m.root, () => e.x);
        return { ...m, shots: e.render.shots, t: Math.random() * 10 };
      },
      update: (v, e: SentinelEntity, dt) => {
        v.t += dt;
        v.root.position.set(e.x, e.render.z, e.y);
        v.root.rotation.y = -e.render.heading;
        v.ring.rotation.set(Math.sin(v.t * 2) * 0.3, v.t * 3, 0);
        if (v.shots !== e.render.shots) v.shots = e.render.shots;
      },
      destroy: (v) => this.unplace(v.root),
    });

    views.register(Fault, {
      create: (e) => {
        const fire = e.render.kind === FaultKind.Fire;
        const glow = glowSprite(fire ? 0xff7a2a : 0x9ad8ff, fire ? 1.6 : 0.8, 0.8);
        this.place(glow, () => e.x);
        return { glow, fire, t: 0, next: 0 };
      },
      update: (v, e: FaultEntity, dt) => {
        v.t += dt;
        const f = e.render;
        const size = 0.4 + f.left * 0.6;
        v.glow.position.set(e.x, f.z + (v.fire ? 0.5 : 0), e.y);
        if (v.fire) {
          v.glow.scale.setScalar((1.6 + Math.sin(v.t * 13) * 0.2) * size);
          for (let i = 0; i < 2; i++) {
            this.sparks.emit({ x: e.x + rand(-0.3, 0.3) * size, y: e.y + rand(-0.3, 0.3) * size, z: f.z + 0.1, vx: rand(-0.2, 0.2), vy: rand(-0.2, 0.2), vz: rand(1, 2.2), life: rand(0.35, 0.7), s0: 0.45 * size, s1: 0.05, c0: [1, 0.75, 0.25, 0.9], c1: [1, 0.2, 0.05, 0], gravity: 0, drag: 1 });
          }
          if (Math.random() < 0.3) this.smoke.emit({ x: e.x, y: e.y, z: f.z + 1, vx: 0, vy: 0, vz: 0.8, life: 2, s0: 0.3, s1: 1.2, c0: [0.2, 0.2, 0.22, 0.4], c1: [0.1, 0.1, 0.1, 0], gravity: -0.2, drag: 0.5 });
        } else {
          const on = Math.sin(v.t * 31) > 0.2 || Math.random() < 0.1;
          v.glow.material.opacity = on ? 0.9 : 0.1;
          v.glow.scale.setScalar(0.9 * size);
          if (v.t > v.next) {
            v.next = v.t + rand(0.1, 0.6);
            for (let i = 0; i < 10; i++) this.sparks.emit({ x: e.x, y: e.y, z: f.z, vx: rand(-2, 2), vy: rand(-2, 2), vz: rand(-0.5, 2.5), life: rand(0.2, 0.6), s0: 0.06, s1: 0.02, c0: [0.7, 0.9, 1, 1], c1: [1, 0.8, 0.3, 0], gravity: 9, drag: 0.5 });
          }
        }
      },
      destroy: (v) => {
        this.unplace(v.glow);
        v.glow.material.dispose();
      },
    });

    views.register(Relic, {
      create: (e) => {
        const m = relicModel();
        this.place(m.root, () => e.x);
        return { ...m, t: 0 };
      },
      update: (v, e: RelicEntity, dt) => {
        v.t += dt;
        v.root.position.set(e.x, e.render.z + Math.sin(v.t * 2) * 0.05, e.y);
        v.gem.rotation.y = v.t * 1.5;
      },
      destroy: (v) => this.unplace(v.root),
    });
  }

  /** Put something on the decks that's drawn only while the camera's in the same place as it. */
  private place(obj: THREE.Object3D, x: () => number): void {
    const holder = new THREE.Group();
    holder.add(obj);
    this.scene.add(holder);
    this.placed.set(holder, x);
  }

  private unplace(obj: THREE.Object3D): void {
    const holder = obj.parent;
    obj.removeFromParent();
    if (holder && this.placed.delete(holder)) holder.removeFromParent();
  }

  /** Which place a deck x is in: -1 for the ship, else the away site's planet. */
  private areaOf(x: number): number {
    return this.ctx.deck.onShip(x) ? -1 : this.ctx.deck.siteAt(x);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * A headset's own console panels (consoleVr.ts) stand where the console's lit top and floating name are, so those give
   * way while one is up.
   */
  dressConsole(station: Station, shown: boolean): void {
    for (const o of this.consoleDressing.get(station) ?? []) o.visible = shown;
  }

  beam(p: PayloadOf<typeof Beam3>): void {
    if (p.kind !== Shot.HandPhaser && p.kind !== Shot.Bolt) return;
    const phaser = p.kind === Shot.HandPhaser;
    const mesh = beamMesh(tmpA.set(p.x, p.z, p.y), tmpB.set(p.tx, p.tz, p.ty), phaser ? 0.018 : 0.035, phaser ? 0xffa040 : 0xff3a2a);
    this.scene.add(mesh);
    this.fading.push({ mesh, age: 0, life: phaser ? 0.18 : 0.25 });
    for (let i = 0; i < (p.hit ? 14 : 5); i++) {
      this.sparks.emit({ x: p.tx, y: p.ty, z: p.tz, vx: rand(-2, 2), vy: rand(-2, 2), vz: rand(-1, 3), life: rand(0.15, 0.4), s0: 0.08, s1: 0.02, c0: phaser ? [1, 0.8, 0.4, 1] : [1, 0.4, 0.3, 1], c1: [1, 0.2, 0.1, 0], gravity: 6, drag: 1 });
    }
  }

  noise(p: PayloadOf<typeof Noise>): void {
    switch (p.kind) {
      case Sound.Beam:
        this.shimmer = 1.2;
        break;
      case Sound.Wreck:
        for (let i = 0; i < 40; i++) this.sparks.emit({ x: p.x, y: p.y, z: p.z, vx: rand(-4, 4), vy: rand(-4, 4), vz: rand(-1, 5), life: rand(0.3, 0.9), s0: 0.15, s1: 0.02, c0: [1, 0.7, 0.3, 1], c1: [1, 0.2, 0, 0], gravity: 9, drag: 0.6 });
        for (let i = 0; i < 12; i++) this.smoke.emit({ x: p.x, y: p.y, z: p.z, vx: rand(-1, 1), vy: rand(-1, 1), vz: rand(0, 1.5), life: rand(1, 2), s0: 0.3, s1: 1.2, c0: [0.25, 0.25, 0.28, 0.6], c1: [0.1, 0.1, 0.1, 0], gravity: 0, drag: 1 });
        break;
      case Sound.Repair:
        for (let i = 0; i < 8; i++) this.sparks.emit({ x: p.x, y: p.y, z: p.z, vx: rand(-1.5, 1.5), vy: rand(-1.5, 1.5), vz: rand(0, 2), life: rand(0.2, 0.4), s0: 0.05, s1: 0.01, c0: [1, 0.9, 0.5, 1], c1: [1, 0.5, 0.1, 0], gravity: 8, drag: 0.5 });
        break;
      case Sound.Relic:
        for (let i = 0; i < 24; i++) this.sparks.emit({ x: p.x, y: p.y, z: p.z, vx: rand(-1, 1), vy: rand(-1, 1), vz: rand(0, 2), life: rand(0.5, 1), s0: 0.12, s1: 0, c0: [1, 0.85, 0.4, 1], c1: [1, 0.7, 0.2, 0], gravity: 0, drag: 1 });
        break;
    }
  }

  /** A column of sparkle where someone's beamed in or out. */
  private shimmer1(x: number, y: number): void {
    for (let i = 0; i < 70; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(0, 0.45);
      this.sparks.emit({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, z: rand(0, 2), vx: 0, vy: 0, vz: rand(-0.3, 0.3), life: rand(0.5, 1.4), s0: rand(0.04, 0.12), s1: 0, c0: [0.7, 0.9, 1, 1], c1: [0.4, 0.7, 1, 0], gravity: 0, drag: 0 });
    }
  }

  /**
   * The lights for where the camera is: the ship's, red and pulsing on red alert, or a planet's sky and haze. `x` is the
   * camera's deck x, or null to light for the ship.
   */
  ambience(x: number | null): void {
    const { deck } = this.ctx;
    const ship = this.ctx.ship()?.render;
    const scene = this.scene;
    const area = x === null ? -1 : this.areaOf(x);
    this.interior.visible = area === -1;
    this.sites.forEach((g, i) => (g.visible = i === area));
    for (const [holder, at] of this.placed) holder.visible = this.areaOf(at()) === area;
    if (x !== null && !deck.onShip(x)) {
      const site = deck.siteAt(x);
      const sky = this.sky[site];
      if (!(scene.background instanceof THREE.Color) || !scene.background.equals(sky)) scene.background = sky.clone();
      if (!scene.fog) scene.fog = new THREE.Fog(sky.getHex(), 30, 90);
      (scene.fog as THREE.Fog).color.copy(sky);
      this.hemi.color.setHex(0xffffff);
      this.hemi.groundColor.copy(sky).multiplyScalar(0.5);
      this.hemi.intensity = 1.6;
      this.sun.intensity = 1.4;
      return;
    }
    scene.fog = null;
    if (!(scene.background instanceof THREE.Color) || scene.background.getHex() !== 0x0a0c12) scene.background = new THREE.Color(0x0a0c12);
    const alert = !!ship?.alert;
    const pulse = alert ? 0.5 + 0.5 * Math.sin(this.t * 4) : 0;
    this.hemi.color.setRGB(0.87 + pulse * 0.13, 0.9 - pulse * 0.6, 0.96 - pulse * 0.66);
    this.hemi.groundColor.setHex(0x3a4250);
    this.hemi.intensity = alert ? 1.1 : 1.5;
    this.sun.intensity = alert ? 0.3 : 0.6;
    this.strips.color.setRGB(alert ? 1 : 0.6, alert ? 0.15 + pulse * 0.1 : 0.85, alert ? 0.1 : 1);
  }

  update(dt: number): void {
    this.t += dt;
    const ship = this.ctx.ship()?.render;
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      f.age += dt;
      f.mesh.material.opacity = Math.max(0, 1 - f.age / f.life);
      if (f.age >= f.life) {
        f.mesh.removeFromParent();
        f.mesh.geometry.dispose();
        f.mesh.material.dispose();
        this.fading.splice(i, 1);
      }
    }
    if (!ship) return;
    // machines glow with how well their systems work, and flicker when they're hurt
    for (const [sys, mat] of this.machines) {
      const eff = Math.min(1.5, efficiency(ship, sys));
      const hurt = (['hEng', 'hWep', 'hShd', 'hSen'] as const)[sys];
      const flicker = ship[hurt] < 0.7 && Math.random() < (0.7 - ship[hurt]) * 0.4 ? 0.3 : 1;
      mat.opacity = 1;
      const base = new THREE.Color([0x6ab8ff, 0xff6a4a, 0x6aff9a, 0xc88aff][sys]);
      mat.color.copy(base).multiplyScalar((0.15 + eff * 0.6) * flicker);
    }
    this.tubeLights.forEach((m, i) => m.color.setHex(ship.tubes & (1 << i) ? 0x5aff7a : 0xff3a2a));
    this.rackTorps.forEach((m, i) => (m.visible = i < ship.torps));
    this.shimmer = Math.max(0, this.shimmer - dt);
    const beaming = ship.beam !== 0 ? 0.4 + ship.beamT * 0.6 : 0;
    this.padGlow.opacity = 0.35 + Math.max(beaming * (0.6 + 0.4 * Math.sin(this.t * 20)), this.shimmer);
    if (beaming > 0 && Math.random() < 0.8) {
      const a = rand(0, Math.PI * 2);
      const r = rand(0, PAD.radius);
      this.sparks.emit({ x: PAD.x + Math.cos(a) * r, y: PAD.y + Math.sin(a) * r, z: rand(0.1, 2.8), vx: 0, vy: 0, vz: rand(-0.5, 0.5), life: 0.6, s0: 0.08, s1: 0, c0: [0.6, 0.9, 1, 1], c1: [0.4, 0.7, 1, 0], gravity: 0, drag: 0 });
    }
  }

  /** The station colours, for anything that wants to match the consoles. */
  static stationColor(station: Station): number {
    return STATION_COLORS[station];
  }
}
