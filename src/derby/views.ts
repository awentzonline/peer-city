import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { bodyView, poseBody, type BodyView } from '../crossplay/avatarView';
import { SOLID, disposeLabel, setLabel, type HumanRig } from '../crossplay/models';
import type { Builder as BuilderRole } from './builder';
import type { DerbyContext, RacerEntity } from './context';
import { Builder, Racer, RacerMode } from './defs';
import { TOOLS, type Aim } from './kit';
import { debrisGeometry, disposeRacer, buildRacer, ghostCube, humanFor, sceneQuat, seatHuman, type RacerModel } from './models';
import { CELL, DIRS } from './parts';
import { rotate } from './physics';
import { designOf, quatOf } from './racer';

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own builder standing, e.g. from a chase camera. */
  showSelf(): boolean;
  /** Draw yourself sitting in your racer (not from the seat's own eyes). */
  showDriver(): boolean;
}

interface BuilderView extends BodyView {
  name: string;
}

interface RacerView {
  model: RacerModel;
  design: Uint8Array;
  broken: Uint8Array;
  driverSkin: number;
  name: string;
  ready: boolean | null;
  spin: number;
  flame: number;
  dust: number;
}

const tq = new THREE.Quaternion();
const q = { x: 0, y: 0, z: 0, w: 1 };
const v = { x: 0, y: 0, z: 0 };

export function registerViews(ctx: DerbyContext, views: EntityViews, scene: THREE.Scene, local: LocalView, builder: BuilderRole): { update(dt: number): void } {
  const { world, course } = ctx;

  views.register(Builder, {
    create: (e): BuilderView => {
      const rig = humanFor(e.state.skin);
      scene.add(rig.root);
      return { ...bodyView(rig, e.x, e.y), name: '' };
    },
    update: (view, e, dt) => {
      const s = e.render;
      const r = view.rig;
      const isMe = e === ctx.me;
      r.root.visible = !s.seated && (!isMe || local.showSelf());
      if (!r.root.visible) {
        view.lastX = e.x;
        view.lastY = e.y;
        return;
      }
      if (view.name !== s.name) {
        view.name = s.name;
        setLabel(r.label, s.name);
      }
      r.label.visible = !isMe;
      r.root.position.set(e.x, course.heightAt(e.x, e.y) + s.z, e.y);
      r.shadow.position.y = 0.04 - s.z;
      poseBody(view, s, e.x, e.y, dt, TOOLS);
    },
    destroy: (view) => {
      scene.remove(view.rig.root);
      disposeLabel(view.rig.label);
    },
  });

  views.register(Racer, {
    create: (e): RacerView => {
      const view: RacerView = { model: null as unknown as RacerModel, design: e.render.design, broken: e.render.broken, driverSkin: -1, name: '', ready: null, spin: 0, flame: 0, dust: 0 };
      rebuild(view, e);
      return view;
    },
    update: (view, e, dt) => {
      const s = e.render;
      if (view.design !== s.design || view.broken !== s.broken) {
        const puff = view.design !== s.design && s.mode === RacerMode.Parked;
        view.design = s.design;
        view.broken = s.broken;
        rebuild(view, e);
        if (puff) ctx.sfx.play('place', { x: s.x, y: s.y, z: s.z }, 0.5);
      }
      const m = view.model;
      m.root.position.set(s.x, s.z, s.y);
      m.root.quaternion.copy(sceneQuat(quatOf(s, q), tq));

      // the driver, sitting in the seat while racing
      const driver = world.getAs(Builder, s.builder);
      const seated = !!driver?.render.seated && s.mode !== RacerMode.Parked;
      const skin = seated ? driver!.render.skin : -1;
      if (skin !== view.driverSkin) {
        view.driverSkin = skin;
        if (m.driver) m.driver.root.removeFromParent();
        m.driver = skin >= 0 ? sitting(skin) : null;
        if (m.driver) m.root.add(m.driver.root);
      }
      if (m.driver) m.driver.root.visible = e !== ctx.racer || local.showDriver();

      const name = driver?.render.name ?? '';
      if (name !== view.name) {
        view.name = name;
        if (name) setLabel(m.label, name);
      }
      m.label.visible = !!name && e !== ctx.racer && s.mode !== RacerMode.Parked;
      const ready = s.mode === RacerMode.Parked ? s.ready : null;
      if (ready !== view.ready) {
        view.ready = ready;
        if (ready !== null) setLabel(m.ready, ready ? 'READY' : 'building…');
      }
      m.ready.visible = ready !== null;

      // wheels roll by how fast it's going, and the front ones steer
      view.spin -= (s.speed * dt) / 0.3;
      for (const w of m.wheels) {
        w.spin.rotation.z = (view.spin * 0.3) / w.radius;
        w.steer.rotation.y = w.steers ? s.steer * 0.5 : 0;
      }

      if (s.boost && m.rockets.length) {
        view.flame -= dt;
        if (view.flame <= 0) {
          view.flame = 0.03;
          quatOf(s, q);
          const vel = velocity(e);
          for (const r of m.rockets) {
            const at = rotate(q, r.at, v);
            const [dx, dy, dz] = DIRS[r.dir];
            const out = rotate(q, { x: dx, y: dy, z: dz }, { x: 0, y: 0, z: 0 });
            ctx.fx.flame(s.x + at.x, s.y + at.y, s.z + at.z, out.x, out.y, out.z, vel.x, vel.y, vel.z);
          }
          if (Math.random() < 0.25) ctx.sfx.play('boost', { x: s.x, y: s.y, z: s.z }, e === ctx.racer ? 0.6 : 1);
        }
      }
      if (Math.abs(s.speed) > 8 && s.mode !== RacerMode.Parked) {
        view.dust -= dt;
        if (view.dust <= 0) {
          view.dust = 0.06;
          ctx.fx.dust(s.x, s.y, s.z, Math.abs(s.speed));
        }
      }
    },
    destroy: (view) => {
      disposeRacer(view.model);
    },
  });

  /** A racer's moving velocity, from where it's been drawn. */
  const last = new WeakMap<RacerEntity, { x: number; y: number; z: number; t: number }>();
  function velocity(e: RacerEntity): { x: number; y: number; z: number } {
    const s = e.render;
    const prev = last.get(e);
    const now = ctx.now;
    const out = { x: 0, y: 0, z: 0 };
    if (prev && now > prev.t) {
      const k = 1000 / (now - prev.t);
      out.x = (s.x - prev.x) * k;
      out.y = (s.y - prev.y) * k;
      out.z = (s.z - prev.z) * k;
    }
    last.set(e, { x: s.x, y: s.y, z: s.z, t: now });
    return out;
  }

  function rebuild(view: RacerView, e: RacerEntity): void {
    const old = view.model;
    const { design, keep } = designOf(e);
    view.model = buildRacer(design, keep, e.render.color);
    scene.add(view.model.root);
    if (old) {
      if (old.driver) view.model.driver = old.driver;
      if (old.driver) view.model.root.add(old.driver.root);
      disposeRacer(old);
    }
    view.name = '';
    view.ready = null;
  }

  // ghosts where the part gun would put a part (or the wrench take one off), one per hand
  const ghosts = [ghostCube(), ghostCube()];
  for (const g of ghosts) scene.add(g);

  // parts torn off, flying about
  const debris: THREE.Mesh[] = [];

  return {
    update: () => {
      builder.aims.forEach((aim, i) => showGhost(ghosts[i], aim));

      const list = ctx.physics.debris;
      while (debris.length < list.length) {
        const mesh = new THREE.Mesh(undefined, SOLID);
        scene.add(mesh);
        debris.push(mesh);
      }
      debris.forEach((mesh, i) => {
        const d = list[i];
        mesh.visible = !!d;
        if (!d) return;
        const geo = debrisGeometry(d.kind, d.dir);
        if (mesh.geometry !== geo) mesh.geometry = geo;
        const t = d.body.translation();
        mesh.position.set(t.x, t.z, t.y);
        mesh.quaternion.copy(sceneQuat(d.body.rotation(), tq));
      });
    },
  };
}

/** A seated human, for a racer's driver. */
function sitting(skin: number): HumanRig {
  const rig = humanFor(skin);
  seatHuman(rig);
  return rig;
}

function showGhost(ghost: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>, aim: Aim): void {
  const t = aim.target;
  ghost.visible = !!t && (!!aim.cell || aim.remove);
  if (!t) return;
  const { design } = designOf(t.racer);
  const cell = aim.remove ? design[t.part] : aim.cell;
  if (!cell) return;
  const local = { x: cell.x * CELL, y: cell.y * CELL, z: cell.z * CELL };
  const s = t.racer.render;
  quatOf(s, q);
  const w = rotate(q, local, v);
  ghost.position.set(s.x + w.x, s.z + w.z, s.y + w.y);
  ghost.quaternion.copy(sceneQuat(q, tq));
  const bad = !!aim.problem;
  ghost.material.color.setHex(aim.remove ? (bad ? 0x636e72 : 0xff5252) : bad ? 0xff7675 : 0x55efc4);
  ghost.scale.setScalar(aim.remove ? 1.12 : 1);
}
