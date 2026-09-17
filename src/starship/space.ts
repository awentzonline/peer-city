import * as THREE from 'three';
import type { EntityViews, PayloadOf } from '@engine/index';
import { ParticleLayer, rand } from '../crossplay/particles';
import type { RaiderEntity, ShipEntity, StarshipContext } from './context';
import { Beam3, Boom, Jolt, Phase, Raider, Result, Screen, Ship, Shot, Warp } from './defs';
import type { Torpedoes } from './flights';
import { glowSprite, planetModel, raiderModel, shipModel, starbaseModel, starfield } from './models';
import { MAX_IMPULSE } from './ship';

const SPACE = 0x02030a;
const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

interface Fading {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  age: number;
  life: number;
}

interface ShipView {
  root: THREE.Group;
  model: THREE.Group;
  shield: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  bank: number;
  lastHeading: number;
}

interface RaiderView {
  root: THREE.Group;
  bracket: THREE.Sprite;
  shield: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  flash: number;
}

/** A beam, as a thin glowing cylinder from one point to another (three.js axes). */
export function beamMesh(from: THREE.Vector3, to: THREE.Vector3, radius: number, color: number): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const len = from.distanceTo(to);
  const geo = new THREE.CylinderGeometry(radius, radius, 1, 6, 1, true);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.scale.set(1, Math.max(0.001, len), 1);
  mesh.quaternion.setFromUnitVectors(UP, tmp.copy(to).sub(from).normalize());
  return mesh;
}

/**
 * Space, as the viewscreen shows it: its own scene with the stars, the sun, the planets and the starbase, the ship and
 * the raiders, and the phaser beams, torpedoes and explosions of a fight. One camera frames it for whatever the
 * viewscreen's showing (`aim`), and both the viewer's screen and the bridge's viewscreen draw through it.
 */
export class SpaceView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 16 / 9, 2, 80000);
  private readonly stars = starfield();
  private readonly sky = new THREE.Group();
  private readonly streaks: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly sparks = new ParticleLayer(1200, true);
  private readonly smoke = new ParticleLayer(400, false);
  private readonly fading: Fading[] = [];
  private readonly torps = new Map<number, THREE.Sprite>();
  private readonly look = new THREE.Vector3();
  private lookReady = false;
  private shipView: ShipView | null = null;
  private readonly raiderViews = new Map<number, RaiderView>();
  private warpGlow = 0;
  private shake = 0;
  private t = 0;

  constructor(
    private readonly ctx: StarshipContext,
    views: EntityViews,
    private readonly torpedoes: Torpedoes,
  ) {
    const { scene } = this;
    const { sector } = ctx;
    scene.background = new THREE.Color(SPACE);
    scene.add(new THREE.HemisphereLight(0x8098c8, 0x100c18, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
    sun.position.set(sector.sun.x - sector.starbase.x, 800, sector.sun.y - sector.starbase.y);
    scene.add(sun, sun.target);
    this.sky.add(this.stars);
    const sunGlow = glowSprite(0xfff0c0, 9000, 0.9);
    const dir = new THREE.Vector3(sector.sun.x - sector.starbase.x, 800, sector.sun.y - sector.starbase.y).normalize();
    sunGlow.position.copy(dir).multiplyScalar(36000);
    const sunCore = glowSprite(0xffffff, 2200, 1);
    sunCore.position.copy(sunGlow.position);
    this.sky.add(sunGlow, sunCore);
    scene.add(this.sky);

    for (const p of sector.planets) {
      const model = planetModel(p.radius, p.biome, sector.seed + p.index);
      model.position.set(p.x, -p.radius * 0.35, p.y);
      scene.add(model);
    }
    const base = starbaseModel();
    base.position.set(sector.starbase.x, -20, sector.starbase.y);
    scene.add(base);

    const streakGeo = new THREE.BufferGeometry();
    streakGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(400 * 6), 3));
    this.streaks = new THREE.LineSegments(streakGeo, new THREE.LineBasicMaterial({ color: 0xc8e0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.streaks.frustumCulled = false;
    this.streaks.visible = false;
    scene.add(this.streaks, this.sparks.mesh, this.smoke.mesh);

    views.register(Ship, {
      create: (e) => {
        const root = new THREE.Group();
        const model = shipModel();
        const shield = new THREE.Mesh(
          new THREE.SphereGeometry(1, 20, 14),
          new THREE.MeshBasicMaterial({ color: 0x6ab8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
        );
        shield.scale.set(30, 12, 20);
        root.add(model, shield);
        scene.add(root);
        const view: ShipView = { root, model, shield, bank: 0, lastHeading: e.render.heading };
        this.shipView = view;
        return view;
      },
      update: (v, e: ShipEntity, dt) => {
        const s = e.render;
        v.root.visible = !(s.phase === Phase.Over && s.result === Result.Lost);
        v.root.position.set(s.x, 0, s.y);
        let turn = s.heading - v.lastHeading;
        if (turn > Math.PI) turn -= Math.PI * 2;
        if (turn < -Math.PI) turn += Math.PI * 2;
        v.lastHeading = s.heading;
        v.bank += (THREE.MathUtils.clamp((turn / Math.max(dt, 0.001)) * 0.6, -0.45, 0.45) - v.bank) * Math.min(1, dt * 3);
        v.root.rotation.set(0, -s.heading, 0);
        v.model.rotation.set(-v.bank, 0, 0);
        const m = v.shield.material;
        const idle = s.shieldsUp ? 0.05 + (s.shields / 100) * 0.05 : 0;
        m.opacity += (idle - m.opacity) * Math.min(1, dt * 4);
      },
      destroy: (v) => {
        v.root.removeFromParent();
        if (this.shipView === v) this.shipView = null;
      },
    });

    views.register(Raider, {
      create: (e) => {
        const root = raiderModel(e.render.kind);
        const bracket = new THREE.Sprite(new THREE.SpriteMaterial({ map: bracketTexture(), color: 0xff6a5a, transparent: true, depthTest: false, depthWrite: false, fog: false }));
        bracket.renderOrder = 20;
        bracket.visible = false;
        const shield = new THREE.Mesh(
          new THREE.SphereGeometry(1, 14, 10),
          new THREE.MeshBasicMaterial({ color: 0x5aff8a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
        );
        const size = e.render.kind === 1 ? 26 : 13;
        shield.scale.set(size * 1.2, size * 0.6, size);
        root.add(shield);
        scene.add(root, bracket);
        const view: RaiderView = { root, bracket, shield, flash: 0 };
        this.raiderViews.set(e.id, view);
        return view;
      },
      update: (v, e: RaiderEntity, dt) => {
        const s = e.render;
        v.root.position.set(e.x, 0, e.y);
        v.root.rotation.set(0, -s.heading, 0);
        const target = this.ctx.ship()?.render.target === e.id;
        v.bracket.visible = target;
        if (target) {
          v.bracket.position.set(e.x, 0, e.y);
          const d = this.camera.position.distanceTo(v.root.position);
          v.bracket.scale.setScalar(Math.max(s.kind === 1 ? 70 : 45, d * 0.06));
          v.bracket.material.color.setHex(s.scanned ? 0xffd35a : 0xff6a5a);
        }
        v.flash = Math.max(0, v.flash - dt * 3);
        v.shield.material.opacity = v.flash * 0.5;
      },
      destroy: (v, e) => {
        v.root.removeFromParent();
        v.bracket.removeFromParent();
        this.raiderViews.delete(e.id);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  beam(p: PayloadOf<typeof Beam3>): void {
    if (p.kind !== Shot.Phaser && p.kind !== Shot.Disruptor) return;
    const phaser = p.kind === Shot.Phaser;
    const from = new THREE.Vector3(p.x, phaser ? 2 : 0, p.y);
    const to = new THREE.Vector3(p.tx, 0, p.ty);
    const mesh = beamMesh(from, to, phaser ? 1.6 : 1.1, phaser ? 0xffa040 : 0x6aff5a);
    this.scene.add(mesh);
    this.fading.push({ mesh, age: 0, life: phaser ? 0.45 : 0.3 });
    if (p.hit) {
      for (let i = 0; i < 16; i++) this.sparks.emit({ x: p.tx, y: p.ty, z: 0, vx: rand(-40, 40), vy: rand(-40, 40), vz: rand(-40, 40), life: rand(0.2, 0.5), s0: 6, s1: 1, c0: phaser ? [1, 0.8, 0.4, 1] : [0.5, 1, 0.4, 1], c1: [1, 0.3, 0.1, 0], gravity: 0, drag: 2, floor: -1e9 });
      const v = [...this.ctx.world.all(Raider)].find((r) => Math.hypot(r.x - p.tx, r.y - p.ty) < 30);
      if (v) {
        const view = this.raiderViews.get(v.id);
        if (view && (v.render.shields ?? 0) > 0) view.flash = 1;
      }
    }
  }

  boom(p: PayloadOf<typeof Boom>): void {
    const size = [10, 30, 60, 90][p.size] ?? 30;
    const n = [30, 80, 140, 260][p.size] ?? 60;
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const b = rand(-1, 1);
      const sp = rand(0.2, 1) * size * 2.4;
      const r = Math.sqrt(1 - b * b);
      this.sparks.emit({ x: p.x, y: p.y, z: 0, vx: Math.cos(a) * r * sp, vy: Math.sin(a) * r * sp, vz: b * sp, life: rand(0.4, 1.4), s0: size * rand(0.3, 0.8), s1: size * 0.1, c0: [1, rand(0.6, 0.95), 0.4, 1], c1: [1, 0.2, 0.05, 0], gravity: 0, drag: 1.2, floor: -1e9 });
    }
    for (let i = 0; i < n / 4; i++) {
      this.smoke.emit({ x: p.x, y: p.y, z: 0, vx: rand(-1, 1) * size, vy: rand(-1, 1) * size, vz: rand(-1, 1) * size, life: rand(1.5, 3), s0: size * 0.5, s1: size * 1.6, c0: [0.3, 0.28, 0.3, 0.6], c1: [0.1, 0.1, 0.12, 0], gravity: 0, drag: 0.8, floor: -1e9 });
    }
    const flash = glowSprite(0xffe0a0, size * 6, 1);
    flash.position.set(p.x, 0, p.y);
    this.scene.add(flash);
    this.fading.push({ mesh: flash as unknown as Fading['mesh'], age: 0, life: 0.6 });
    const ship = this.ctx.ship();
    if (ship && Math.hypot(ship.x - p.x, ship.y - p.y) < 300) this.shake = Math.max(this.shake, p.size >= 3 ? 1 : 0.4);
  }

  jolt(p: PayloadOf<typeof Jolt>): void {
    const v = this.shipView;
    const ship = this.ctx.ship();
    if (!v || !ship) return;
    this.shake = Math.max(this.shake, Math.min(1, p.amount / 15));
    if (p.shielded || ship.render.shields > 0) v.shield.material.opacity = 0.5;
    if (!p.shielded) {
      const a = Math.atan2(p.y - ship.y, p.x - ship.x);
      for (let i = 0; i < 20; i++) this.sparks.emit({ x: ship.x + Math.cos(a) * 12, y: ship.y + Math.sin(a) * 8, z: rand(-2, 4), vx: rand(-30, 30), vy: rand(-30, 30), vz: rand(-20, 30), life: rand(0.3, 0.8), s0: 4, s1: 0.5, c0: [1, 0.8, 0.3, 1], c1: [1, 0.2, 0, 0], gravity: 0, drag: 1.5, floor: -1e9 });
    }
  }

  // -------------------------------------------------------------------------
  // Framing and drawing
  // -------------------------------------------------------------------------

  /** Whether a screen mode can be shown from space (the away team's is on the decks), given who's where. */
  canShow(mode: Screen): boolean {
    return mode !== Screen.Away;
  }

  /**
   * Put the camera where the viewscreen's mode says, easing its gaze so a change of target turns rather than cuts.
   * `aspect` is the screen it'll be drawn on.
   */
  aim(mode: Screen, aspect: number, dt: number): void {
    const ship = this.ctx.ship();
    const cam = this.camera;
    if (cam.aspect !== aspect) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    if (!ship) {
      cam.position.set(this.ctx.sector.dock.x - 200, 60, this.ctx.sector.dock.y);
      cam.lookAt(this.ctx.sector.starbase.x, 0, this.ctx.sector.starbase.y);
      return;
    }
    const s = ship.render;
    const h = s.heading;
    const fx = Math.cos(h);
    const fy = Math.sin(h);
    const want = tmp2;
    const warp = s.warp === Warp.Warping ? 1 : 0;
    const fov = 55 + warp * 25;
    switch (mode) {
      case Screen.Aft:
        cam.position.set(ship.x - fx * 26, 6, ship.y - fy * 26);
        want.set(ship.x - fx * 1000, 0, ship.y - fy * 1000);
        break;
      case Screen.Tactical:
        cam.position.set(ship.x - fx * 150, 70, ship.y - fy * 150);
        want.set(ship.x + fx * 80, 0, ship.y + fy * 80);
        break;
      case Screen.Target: {
        const target = s.target ? this.ctx.world.getAs(Raider, s.target) : undefined;
        if (target) {
          const a = Math.atan2(target.y - ship.y, target.x - ship.x);
          cam.position.set(ship.x + Math.cos(a) * 30, 8, ship.y + Math.sin(a) * 30);
          want.set(target.x, 0, target.y);
          break;
        }
        cam.position.set(ship.x + fx * 24, 6, ship.y + fy * 24);
        want.set(ship.x + fx * 1000, 0, ship.y + fy * 1000);
        break;
      }
      default:
        cam.position.set(ship.x + fx * 24, 6, ship.y + fy * 24);
        want.set(ship.x + fx * 1000, 0, ship.y + fy * 1000);
    }
    if (!this.lookReady || this.look.distanceToSquared(want) > 4e8) this.look.copy(want);
    else this.look.lerp(want, Math.min(1, dt * 4));
    this.lookReady = true;
    if (this.shake > 0.01) cam.position.add(tmp.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(this.shake * 3));
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - fov) > 0.1) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 3);
      cam.updateProjectionMatrix();
    }
    this.sky.position.copy(cam.position);
  }

  update(dt: number): void {
    this.t += dt;
    this.shake *= Math.exp(-dt * 5);
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      f.age += dt;
      f.mesh.material.opacity = Math.max(0, 1 - f.age / f.life);
      if (f.age >= f.life) {
        f.mesh.removeFromParent();
        f.mesh.geometry?.dispose();
        f.mesh.material.dispose();
        this.fading.splice(i, 1);
      }
    }
    // torpedoes, from the flights themselves
    const live = new Set<number>();
    for (const f of this.torpedoes.flights) {
      live.add(f.id);
      let s = this.torps.get(f.id);
      if (!s) {
        s = glowSprite(f.hostile ? 0x6aff5a : 0xff5a3a, 22, 1);
        this.torps.set(f.id, s);
        this.scene.add(s);
      }
      s.position.set(f.x, 0, f.y);
      s.scale.setScalar(20 + Math.sin(this.t * 30 + f.id) * 5);
      this.sparks.emit({ x: f.x, y: f.y, z: 0, vx: 0, vy: 0, vz: 0, life: 0.3, s0: 8, s1: 1, c0: f.hostile ? [0.4, 1, 0.3, 0.7] : [1, 0.4, 0.2, 0.7], c1: [1, 0.2, 0.1, 0], gravity: 0, drag: 0, floor: -1e9 });
    }
    for (const [id, s] of this.torps) {
      if (live.has(id)) continue;
      s.removeFromParent();
      s.material.dispose();
      this.torps.delete(id);
    }
    this.warpStreaks(dt);
  }

  private warpStreaks(dt: number): void {
    const ship = this.ctx.ship()?.render;
    const warping = ship?.warp === Warp.Warping;
    const charging = ship?.warp === Warp.Charging;
    this.warpGlow += ((warping ? 1 : charging ? 0.15 * ship!.warpT : 0) - this.warpGlow) * Math.min(1, dt * 3);
    const lines = this.streaks;
    lines.visible = this.warpGlow > 0.02 && !!ship;
    if (!lines.visible || !ship) return;
    lines.material.opacity = this.warpGlow;
    const pos = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const fx = Math.cos(ship.heading);
    const fy = Math.sin(ship.heading);
    const speed = Math.max(ship.speed, MAX_IMPULSE);
    const len = 40 + this.warpGlow * 260;
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    for (let i = 0; i < 400; i++) {
      const k = i * 6;
      // each streak rides forward from a random point near the camera and wraps round
      const phase = ((this.t * speed * 0.5 + i * 97.13) % 1600) - 400;
      const side = ((i * 53.7) % 400) - 200;
      const up = ((i * 31.3) % 240) - 120;
      const along = -phase;
      const x = cx + fx * along - fy * side;
      const z = cz + fy * along + fx * side;
      arr[k] = x;
      arr[k + 1] = this.camera.position.y + up;
      arr[k + 2] = z;
      arr[k + 3] = x - fx * len;
      arr[k + 4] = this.camera.position.y + up;
      arr[k + 5] = z - fy * len;
    }
    pos.needsUpdate = true;
  }

  /** Draw space through the camera into a render target (a screen in the world) or, with null, onto the page. */
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    if (!target) {
      renderer.render(this.scene, this.camera);
      return;
    }
    const xr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    const was = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(was);
    renderer.xr.enabled = xr;
  }
}

let bracket: THREE.CanvasTexture | null = null;

/** Four corner brackets, for tactical's target. */
function bracketTexture(): THREE.CanvasTexture {
  if (bracket) return bracket;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff';
  g.lineWidth = 8;
  for (const [x, y, dx, dy] of [
    [8, 8, 1, 1],
    [120, 8, -1, 1],
    [8, 120, 1, -1],
    [120, 120, -1, -1],
  ]) {
    g.beginPath();
    g.moveTo(x, y + dy * 30);
    g.lineTo(x, y);
    g.lineTo(x + dx * 30, y);
    g.stroke();
  }
  bracket = new THREE.CanvasTexture(c);
  return bracket;
}
