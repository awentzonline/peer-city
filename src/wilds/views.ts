import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { bodyView, poseBody, type BodyView } from '../crossplay/avatarView';
import { SOLID, buildHuman, buildToolPickup, disposeLabel, setLabel, toolMesh } from '../crossplay/models';
import type { WildsContext } from './context';
import { Animal, AnimalKind, AnimalMode, Campfire, Crop, Item, Plot, Stump, Survivor } from './defs';
import { growth } from './homestead';
import { ARROWS, ARROW_LENGTH, BOW, TOOLS } from './kit';
import { ObstacleKind } from './land';
import { BowString, SOIL, arrowMesh, buildAnimal, buildCampfire, buildStump, cropGeometry, type AnimalRig, type FireRig } from './models';

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own survivor, e.g. while dead. */
  showSelf(): boolean;
}

const SHIRTS = [0xa8322d, 0x3b5f8a, 0x4f6b3a, 0x8a6a3a, 0x6b3f6e, 0x2f2f33, 0xc07a2e, 0x2e6e6a];
const PANTS = [0x3a3024, 0x2c3340, 0x4a4238, 0x55503f];
const SKINS = [0xf5d0a9, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a1e];
const HAIR = [0x2c1b0e, 0x6b4423, 0xd4a017, 0x1a1a1a, 0xa52a2a, 0xbbbbbb];

interface SurvivorView extends BodyView {
  name: string;
  string: BowString;
}

interface AnimalView {
  rig: AnimalRig;
  lastX: number;
  lastY: number;
  phase: number;
  speed: number;
  mode: number;
}

interface PlotView {
  root: THREE.Group;
  crop: THREE.Mesh;
  stage: number;
}

const pull = new THREE.Vector3();
const FALL_SECONDS = 1.8;
/** How long a felled trunk lies there before it's gone. */
const LOG_SECONDS = 40;
/** Campfires that light up their surroundings at once. A fixed pool: changing how many lights there are recompiles every material. */
const FIRE_LIGHTS = 3;

export function registerViews(ctx: WildsContext, views: EntityViews, scene: THREE.Scene, local: LocalView): { update(dt: number): void } {
  const { world, land } = ctx;

  views.register(Survivor, {
    create: (e): SurvivorView => {
      const k = e.state.skin;
      const rig = buildHuman({ shirt: SHIRTS[k % SHIRTS.length], pants: PANTS[(k * 5) % PANTS.length], skin: SKINS[(k * 7) % SKINS.length], hair: HAIR[(k * 3) % HAIR.length], hat: k % 3 === 0 ? 0x5a4630 : undefined });
      scene.add(rig.root);
      return { ...bodyView(rig, e.x, e.y), name: '', string: new BowString(scene) };
    },
    update: (v, e, dt) => {
      const s = e.render;
      const r = v.rig;
      const isMe = e === ctx.me;
      r.root.visible = !isMe || local.showSelf();
      if (!r.root.visible) {
        v.lastX = e.x;
        v.lastY = e.y;
        v.string.update(null, null, false);
        return;
      }
      if (v.name !== s.name) {
        v.name = s.name;
        setLabel(r.label, s.name);
      }
      const dead = s.hp <= 0;
      r.label.visible = !isMe && !dead;
      r.root.position.set(e.x, land.heightAt(e.x, e.y) + s.z, e.y);
      r.shadow.position.y = 0.04 - s.z;
      if (dead) {
        r.body.rotation.set(0, -s.yaw, Math.PI / 2);
        r.body.position.y = 0.14;
        r.tool.visible = r.toolL.visible = false;
        r.shadow.visible = false;
        v.string.update(null, null, false);
        return;
      }
      poseBody(v, s, e.x, e.y, dt, TOOLS);

      // the bow's string, pulled back to the drawing hand (a headset's) or straight back (a crosshair's)
      const bowRight = s.tool === BOW.id;
      const bow = bowRight ? r.tool : s.ltool === BOW.id ? r.toolL : null;
      let at: THREE.Vector3 | null = null;
      if (bow && s.draw > 0) {
        r.root.updateMatrixWorld(true);
        const other = bowRight ? r.toolL : r.tool;
        const otherTool = bowRight ? s.ltool : s.tool;
        if (otherTool === ARROWS.id) at = other.getWorldPosition(pull);
        else at = toolMesh(bow).localToWorld(pull.set(0, 0, 0.13 + 0.55 * s.draw));
      }
      v.string.update(bow, at, s.draw > 0);
    },
    destroy: (v) => {
      scene.remove(v.rig.root);
      disposeLabel(v.rig.label);
      v.string.dispose();
    },
  });

  views.register(Animal, {
    create: (e): AnimalView => {
      const rig = buildAnimal(e.state.kind);
      scene.add(rig.root);
      return { rig, lastX: e.x, lastY: e.y, phase: Math.random() * 6, speed: 0, mode: e.state.mode };
    },
    update: (v, e, dt) => {
      const s = e.render;
      const r = v.rig;
      const ground = land.heightAt(e.x, e.y);
      r.root.position.set(e.x, ground, e.y);
      if (s.mode !== v.mode) {
        if (s.mode === AnimalMode.Hunt && s.kind === AnimalKind.Wolf) ctx.sfx.play('howl', { x: e.x, y: e.y, z: ground + 1 });
        v.mode = s.mode;
      }
      if (s.mode === AnimalMode.Dead) {
        r.body.rotation.set(Math.PI / 2, -s.angle, 0, 'YXZ');
        r.body.position.y = 0.15;
        r.shadow.visible = false;
        v.lastX = e.x;
        v.lastY = e.y;
        return;
      }
      r.shadow.visible = true;
      r.body.rotation.set(0, -s.angle, 0);
      const moved = Math.hypot(e.x - v.lastX, e.y - v.lastY) / Math.max(dt, 0.001);
      v.lastX = e.x;
      v.lastY = e.y;
      v.speed += ((moved > 20 ? 0 : moved) - v.speed) * Math.min(1, dt * 8);
      v.phase += v.speed * dt * (s.kind === AnimalKind.Rabbit ? 5 : 2.4);
      const swing = Math.min(1, v.speed / 3) * 0.7 * Math.sin(v.phase);
      if (s.kind === AnimalKind.Rabbit) {
        r.body.position.y = Math.abs(Math.sin(v.phase)) * Math.min(1, v.speed) * 0.15;
      } else {
        r.body.position.y = 0;
        r.legs.forEach((leg, i) => (leg.rotation.z = (i === 0 || i === 3 ? 1 : -1) * swing));
      }
      // grazing: head down while standing still
      r.head.rotation.z = s.mode === AnimalMode.Graze && v.speed < 0.2 ? -0.9 : 0;
    },
    destroy: (v) => scene.remove(v.rig.root),
  });

  views.register(Plot, {
    create: (e): PlotView => {
      const root = new THREE.Group();
      root.add(new THREE.Mesh(SOIL, SOLID));
      const crop = new THREE.Mesh(cropGeometry(0), SOLID);
      crop.visible = false;
      root.add(crop);
      root.position.set(e.x, land.heightAt(e.x, e.y), e.y);
      scene.add(root);
      return { root, crop, stage: -1 };
    },
    update: (v, e) => {
      const g = growth(e, ctx.wall);
      const stage = e.render.crop === Crop.None ? -1 : g >= 1 ? 2 : g >= 0.4 ? 1 : 0;
      if (stage === v.stage) return;
      v.stage = stage;
      v.crop.visible = stage >= 0;
      if (stage >= 0) v.crop.geometry = cropGeometry(stage);
    },
    destroy: (v) => scene.remove(v.root),
  });

  views.register(Stump, {
    create: (e) => {
      const o = land.obstacles[e.state.tree];
      const root = buildStump(o?.kind ?? ObstacleKind.Oak, o?.r ?? 0.4);
      root.position.set(e.x, (o?.base ?? land.heightAt(e.x, e.y)) - 0.05, e.y);
      const trunk = root.getObjectByName('trunk') as THREE.Mesh;
      const pivot = new THREE.Group();
      pivot.position.y = 0.5;
      pivot.rotation.y = (e.state.tree * 2.39996) % (Math.PI * 2); // falls a different way each tree
      root.add(pivot);
      pivot.add(trunk);
      trunk.scale.set(o?.r ?? 0.4, (o?.h ?? 6) * 0.8, o?.r ?? 0.4);
      scene.add(root);
      return { root, trunk };
    },
    update: (v, e) => {
      const t = ctx.wall - e.render.felled;
      const fall = Math.min(1, Math.max(0, t / FALL_SECONDS));
      v.trunk.rotation.z = -(fall * fall) * (Math.PI / 2 - 0.08);
      v.trunk.visible = t < LOG_SECONDS;
    },
    destroy: (v) => scene.remove(v.root),
  });

  const lights = Array.from({ length: FIRE_LIGHTS }, () => {
    const light = new THREE.PointLight(0xff9a40, 0, 18, 1.5);
    scene.add(light);
    return light;
  });

  views.register(Campfire, {
    create: (e): FireRig & { next: number; crackle: number } => {
      const rig = buildCampfire();
      rig.root.position.set(e.x, land.heightAt(e.x, e.y), e.y);
      scene.add(rig.root);
      return { ...rig, next: 0, crackle: 0 };
    },
    update: (v, e, dt) => {
      const lit = e.render.until > ctx.wall;
      const z = v.root.position.y;
      v.logs.scale.setScalar(lit ? 1 : 0.6);
      v.next -= dt;
      if (v.next > 0) return;
      v.next = lit ? 0.05 : 0.6;
      if (lit) {
        ctx.fx.flame(e.x, e.y, z + 0.15, 1);
        if (Math.random() < 0.3) ctx.fx.ember(e.x, e.y, z + 0.4);
        if (Math.random() < 0.2) ctx.fx.smoke(e.x, e.y, z + 1.1);
        v.crackle -= 0.05;
        if (v.crackle <= 0) {
          v.crackle = 0.4 + Math.random() * 0.8;
          ctx.sfx.play('crackle', { x: e.x, y: e.y, z: z + 0.3 });
        }
      } else if (ctx.wall - e.render.until < 30) {
        ctx.fx.smoke(e.x, e.y, z + 0.2);
      }
    },
    destroy: (v) => scene.remove(v.root),
  });

  views.register(Item, {
    create: (e) => {
      const tool = TOOLS.get(e.state.tool);
      const rig = tool ? buildToolPickup(tool) : { root: new THREE.Group(), spin: new THREE.Group() };
      rig.root.position.set(e.x, land.heightAt(e.x, e.y), e.y);
      rig.root.scale.setScalar(1.3);
      scene.add(rig.root);
      return { ...rig, t: Math.random() * 6 };
    },
    update: (v, e, dt) => {
      v.t += dt;
      v.root.position.set(e.x, land.heightAt(e.x, e.y) - 0.3, e.y);
      v.spin.rotation.y = v.t * 1.5;
      v.spin.position.y = 0.6 + Math.sin(v.t * 2.5) * 0.06;
    },
    destroy: (v) => {
      scene.remove(v.root);
      v.root.traverse((o) => {
        if (o instanceof THREE.Sprite) o.material.dispose();
      });
    },
  });

  // arrows in flight (and stuck where they landed), and lights for the nearest fires
  const flights: THREE.Mesh[] = [];
  const toward = new THREE.Vector3();
  return {
    update: () => {
      const list = ctx.arrows.flights;
      while (flights.length < list.length) {
        const m = arrowMesh();
        scene.add(m);
        flights.push(m);
      }
      flights.forEach((m, i) => {
        const f = list[i];
        m.visible = !!f;
        if (!f) return;
        m.position.set(f.x, f.z, f.y);
        toward.set(f.x + f.vx, f.z + f.vz, f.y + f.vy);
        m.lookAt(toward);
        m.rotateY(Math.PI); // arrows point down -Z from the nock
        m.translateZ(ARROW_LENGTH); // the flight is where the tip is
      });

      const me = ctx.me;
      const fires = [...world.all(Campfire)].filter((f) => f.render.until > ctx.wall);
      if (me) fires.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
      lights.forEach((light, i) => {
        const f = fires[i];
        light.intensity = f ? 14 + Math.sin(ctx.now / 90 + i) * 2 + Math.random() * 2 : 0;
        if (f) light.position.set(f.x, land.heightAt(f.x, f.y) + 0.9, f.y);
      });
    },
  };
}
