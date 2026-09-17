import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { bodyView, poseBody, type BodyView } from '../crossplay/avatarView';
import { headingToYaw, signedAngle } from '../crossplay/math';
import { disposeLabel, setLabel, toolTip } from '../crossplay/models';
import type { Rig } from '../crossplay/rig';
import type { HauntContext, KeyEntity, MonsterEntity, SurvivorEntity } from './context';
import { Haunt, Key, Monster, MonsterKind, MonsterMode, Survivor, SurvivorMode } from './defs';
import type { HauntRole } from './haunt';
import { BEAM_HALF_ANGLE, BEAM_RANGE, FLASHLIGHT, TOOLS } from './kit';
import { MONSTERS } from './monsters';
import { beamGeometry, disposeMonster, groundRing, keyModel, monsterModel, poseDead, poseDowned, presenceModel, survivorModel, type MonsterModel } from './models';

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own survivor, e.g. when spectating yourself. */
  showSelf(): boolean;
  /** Draw a cone for your own flashlight's beam: a headset sees its own hand, a screen doesn't. */
  showOwnBeam(): boolean;
}

interface SurvivorView extends BodyView {
  name: string;
  t: number;
  beam: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  marker: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

interface MonsterView {
  model: MonsterModel;
  kind: MonsterKind;
  t: number;
  strikes: number;
  lunge: number;
  dissolve: number;
  nextEmber: number;
  nextMoan: number;
  lastX: number;
  lastY: number;
}

/** A beam that wants a real light: where it starts, which way, and how near the camera it is. */
interface Beam {
  from: THREE.Vector3;
  dir: THREE.Vector3;
  near: number;
  mine: boolean;
}

/** Spotlights shared out among the nearest beams. A fixed number, so the shaders never recompile. */
const SPOTS = 4;

const tip = new THREE.Vector3();
const camPos = new THREE.Vector3();
const tq = new THREE.Quaternion();

export function registerViews(
  ctx: HauntContext,
  views: EntityViews,
  scene: THREE.Scene,
  rig: Rig,
  local: LocalView,
  haunt: HauntRole | null,
): { update(dt: number): void } {
  const beams: Beam[] = [];
  const spots: THREE.SpotLight[] = [];
  for (let i = 0; i < SPOTS; i++) {
    const spot = new THREE.SpotLight(0xfff0d0, 0, BEAM_RANGE + 6, BEAM_HALF_ANGLE * 1.25, 0.45, 1.5);
    spot.visible = true;
    scene.add(spot, spot.target);
    spots.push(spot);
  }
  const flashTip = toolTip(FLASHLIGHT);

  views.register(Survivor, {
    create: (e): SurvivorView => {
      const model = survivorModel(e.state.skin);
      model.body.rotation.order = 'YXZ';
      const beam = new THREE.Mesh(beamGeometry(BEAM_RANGE * 0.8, BEAM_HALF_ANGLE), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      beam.visible = false;
      const marker = groundRing(0.55, 0.75, 0xff4a3a);
      marker.visible = false;
      scene.add(model.root, beam, marker);
      return { ...bodyView(model, e.x, e.y), name: '', t: Math.random() * 10, beam, marker };
    },
    update: (view, e, dt) => {
      const s = e.render;
      const r = view.rig;
      const isMe = e === ctx.me;
      view.t += dt;
      r.root.visible = !isMe || local.showSelf();
      view.marker.visible = !!haunt && s.mode === SurvivorMode.Alive;
      if (view.marker.visible) {
        view.marker.position.set(e.x, 0.06, e.y);
        view.marker.scale.setScalar(zoomScale(e.x, e.y));
        view.marker.material.opacity = 0.55 + Math.sin(view.t * 5) * 0.25;
      }
      if (view.name !== s.name) {
        view.name = s.name;
        setLabel(r.label, s.name);
      }
      r.label.visible = !isMe && s.mode !== SurvivorMode.Dead;
      r.root.position.set(e.x, s.z, e.y);
      switch (s.mode) {
        case SurvivorMode.Downed:
          poseDowned(r, s.yaw, view.t);
          view.lastX = e.x;
          view.lastY = e.y;
          r.tool.visible = r.toolL.visible = false;
          break;
        case SurvivorMode.Dead:
          poseDead(r, s.yaw);
          r.tool.visible = r.toolL.visible = false;
          break;
        default:
          r.body.position.y = 0;
          poseBody(view, s, e.x, e.y, dt, TOOLS);
      }
      showBeam(view, e, isMe);
    },
    destroy: (view) => {
      scene.remove(view.rig.root, view.beam, view.marker);
      disposeLabel(view.rig.label);
      view.beam.material.dispose();
      view.marker.geometry.dispose();
      view.marker.material.dispose();
    },
  });

  /** A lit flashlight's beam, from the tip of whichever hand holds it, and a request for a real light. */
  function showBeam(view: SurvivorView, e: SurvivorEntity, isMe: boolean): void {
    const s = e.render;
    const side = s.tool === FLASHLIGHT.id ? 0 : s.ltool === FLASHLIGHT.id ? 1 : -1;
    if (!s.light || side < 0 || s.mode === SurvivorMode.Dead) {
      view.beam.visible = false;
      return;
    }
    const group = side === 0 ? view.rig.tool : view.rig.toolL;
    const [hx, hy, hz, yaw, pitch] = side === 0 ? [s.hx, s.hy, s.hz, s.aimYaw, s.aimPitch] : [s.lhx, s.lhy, s.lhz, s.laimYaw, s.laimPitch];
    const q = tq.setFromEuler(new THREE.Euler(signedAngle(pitch), headingToYaw(yaw), 0, 'YXZ'));
    const from = new THREE.Vector3(e.x + hx, s.z + hz, e.y + hy).add(tip.copy(flashTip).applyQuaternion(q));
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    if (s.mode === SurvivorMode.Downed) group.visible = false;
    view.beam.visible = !isMe || local.showOwnBeam();
    view.beam.position.copy(from);
    view.beam.quaternion.copy(q);
    rig.camera.getWorldPosition(camPos);
    beams.push({ from, dir, near: isMe ? -1 : from.distanceTo(camPos), mine: isMe });
  }

  views.register(Monster, {
    create: (e): MonsterView => {
      const model = monsterModel(e.state.kind);
      scene.add(model.root);
      return { model, kind: e.state.kind, t: Math.random() * 10, strikes: e.state.strikes, lunge: 0, dissolve: 0, nextEmber: 0, nextMoan: 3 + Math.random() * 10, lastX: e.x, lastY: e.y };
    },
    update: (view, e, dt) => animateMonster(view, e, dt),
    destroy: (view) => disposeMonster(view.model),
  });

  function animateMonster(view: MonsterView, e: MonsterEntity, dt: number): void {
    const s = e.render;
    const m = view.model;
    const spec = MONSTERS[view.kind];
    view.t += dt;
    const moved = Math.hypot(e.x - view.lastX, e.y - view.lastY) / Math.max(dt, 1e-3);
    view.lastX = e.x;
    view.lastY = e.y;
    const pace = Math.min(1, moved / spec.speed);
    m.root.position.set(e.x, 0, e.y);
    // models face +X, which is a heading of 0
    m.root.rotation.y = -s.angle;

    if (s.strikes !== view.strikes) {
      view.strikes = s.strikes;
      view.lunge = 1;
    }
    view.lunge = Math.max(0, view.lunge - dt * 3.5);
    const lunge = Math.sin(view.lunge * Math.PI) * 0.45;

    switch (view.kind) {
      case MonsterKind.Shade:
        m.body.position.set(lunge, 0.15 + Math.sin(view.t * 2) * 0.12, 0);
        m.body.rotation.z = -pace * 0.25 - lunge * 0.5;
        m.limbs.forEach((l, i) => {
          if (i < 7) l.rotation.x = Math.sin(view.t * 4 + i) * 0.35 + pace * 0.5;
          else l.rotation.z = 0.4 + lunge * 1.5 + Math.sin(view.t * 3 + i) * 0.1;
        });
        break;
      case MonsterKind.Crawler: {
        m.body.position.set(lunge * 1.2, Math.abs(Math.sin(view.t * 12 * pace)) * 0.06, 0);
        const swing = Math.sin(view.t * 14) * 0.7 * pace;
        m.limbs.forEach((l, i) => (l.rotation.z = (i % 2 ? swing : -swing) * (i < 2 ? 1 : -1)));
        break;
      }
      case MonsterKind.Brute: {
        m.body.position.set(lunge, 0, 0);
        const swing = Math.sin(view.t * 5) * 0.5 * pace;
        const [armL, armR, legL, legR] = m.limbs;
        legL.rotation.z = swing;
        legR.rotation.z = -swing;
        armL.rotation.z = -swing * 0.6 + lunge * 3;
        armR.rotation.z = swing * 0.6 + lunge * 3;
        break;
      }
    }

    // burning in a beam: the flesh glows, embers fly, and it shrinks from the light
    const lit = s.lit;
    const flicker = lit > 0 ? 0.7 + Math.random() * 0.3 : 0;
    for (const mat of m.materials) {
      // a faint ember-red smoulder: a flat glow would wash out the shading, and the embers say enough
      if (mat instanceof THREE.MeshLambertMaterial) mat.emissive.setRGB(lit * 0.14 * flicker, lit * 0.02 * flicker, 0);
      // (linear values: the shroud stays near black until it burns)
      else mat.color.setRGB(0.004 + lit * 0.05 * flicker, 0.003 + lit * 0.012 * flicker, 0.008);
    }
    if (lit > 0.05) {
      view.nextEmber -= dt;
      if (view.nextEmber <= 0) {
        view.nextEmber = 0.08;
        ctx.fx.embers(e.x, e.y, spec.height, lit);
        ctx.sfx.play('sizzle', { x: e.x, y: e.y, z: spec.height }, lit * 0.8);
      }
    }
    const shrink = 1 - lit * 0.12;

    // dissolving
    if (s.mode === MonsterMode.Dead) view.dissolve = Math.min(1, view.dissolve + dt / 1.2);
    const k = (1 - view.dissolve) * shrink;
    m.body.scale.set(k, (1 - view.dissolve * 0.6) * shrink, k);
    m.shadow.scale.setScalar((1 - view.dissolve) * (view.kind === MonsterKind.Brute ? 1.4 : 1));
    for (const eye of m.eyes) eye.visible = view.dissolve < 0.3;

    // eyes carry through the dark further than anything else, but not forever
    rig.camera.getWorldPosition(camPos);
    const d = camPos.distanceTo(m.root.position);
    const eyeFade = haunt ? 1 : Math.max(0, Math.min(1, (22 - d) / 10));
    for (const eye of m.eyes) eye.material.opacity = eyeFade * (0.75 + Math.sin(view.t * 7) * 0.2);

    // only the Haunt sees these
    const mine = !!haunt && s.haunt === ctx.haunt?.id;
    const zoom = haunt ? zoomScale(e.x, e.y) : 1;
    m.ring.visible = mine && haunt!.selected.has(e.id) && s.mode !== MonsterMode.Dead;
    m.ring.scale.setScalar(zoom);
    m.badge.visible = !!haunt && s.mode !== MonsterMode.Dead;
    m.badge.scale.setScalar((0.6 + (m.ring.visible ? 0.3 : 0)) * zoom * (mine ? 1.2 : 0.8));
    m.badge.material.opacity = mine ? 0.95 : 0.5;
    m.bar.visible = !!haunt && s.mode !== MonsterMode.Dead;
    m.bar.scale.setScalar(zoom);
    if (m.bar.visible) {
      m.barFill.scale.x = Math.max(0.01, s.hp / spec.hp);
      (m.barFill.material as THREE.MeshBasicMaterial).color.setHex(mine ? 0xb46bff : 0x7a6a8a);
      rig.camera.getWorldQuaternion(m.bar.quaternion);
      m.bar.quaternion.premultiply(tq.copy(m.root.quaternion).invert());
    }

    // now and then, a moan in the dark
    if (!haunt && s.mode !== MonsterMode.Dead) {
      view.nextMoan -= dt;
      if (view.nextMoan <= 0) {
        view.nextMoan = 6 + Math.random() * 12;
        ctx.sfx.play('moan', { x: e.x, y: e.y, z: spec.height }, view.kind === MonsterKind.Brute ? 1 : 0.6);
      }
    }
  }

  views.register(Key, {
    create: () => {
      const model = keyModel();
      scene.add(model.root);
      return { ...model, t: Math.random() * 10, mote: 0 };
    },
    update: (view, e: KeyEntity, dt) => {
      const s = e.render;
      view.t += dt;
      const loose = !s.holder && !s.socket;
      view.root.position.set(e.x, s.z + (loose ? 0.25 + Math.sin(view.t * 2) * 0.08 : 0), e.y);
      view.spin.rotation.set(s.socket ? Math.PI / 2 : 0, loose ? view.t * 1.5 : 0, s.socket ? 0 : 0.3);
      view.glow.material.opacity = loose ? 0.75 + Math.sin(view.t * 3) * 0.2 : 0.4;
      view.glow.scale.setScalar(loose ? 1.1 : 0.6);
      view.mote -= dt;
      if (loose && view.mote <= 0) {
        view.mote = 0.25;
        ctx.fx.mote(e.x, e.y, s.z + 0.3, [1, 0.8, 0.3, 0.9]);
      }
    },
    destroy: (view) => {
      view.root.removeFromParent();
      view.glow.material.dispose();
    },
  });

  views.register(Haunt, {
    create: () => {
      const presence = presenceModel();
      const cursor = groundRing(0.7, 0.95, 0x9f7bff);
      presence.root.visible = cursor.visible = false;
      scene.add(presence.root, cursor);
      return { ...presence, cursor, fade: 0, t: 0 };
    },
    update: (view, e, dt) => {
      const s = e.render;
      view.t += dt;
      const self = e === ctx.haunt;
      // survivors feel a presence; another Haunt sees where its partner points
      view.fade += ((s.present ? 1 : 0) - view.fade) * Math.min(1, dt * 2);
      view.root.visible = !haunt && view.fade > 0.02;
      view.cursor.visible = !!haunt && !self && view.fade > 0.02;
      view.root.position.set(s.px, Math.sin(view.t * 1.3) * 0.15, s.py);
      view.cursor.position.set(s.px, 0.07, s.py);
      view.cursor.material.opacity = view.fade * 0.7;
      view.mist.forEach((m, i) => {
        m.material.opacity = view.fade * 0.75;
        m.position.x = Math.sin(view.t * 0.9 + i) * 0.3;
        m.position.z = Math.cos(view.t * 0.7 + i * 2) * 0.3;
      });
      for (const eye of view.eyes) {
        eye.material.opacity = view.fade * (0.5 + Math.sin(view.t * 11) * 0.2 + Math.random() * 0.2);
        eye.visible = Math.sin(view.t * 0.8) > -0.85;
      }
      rig.camera.getWorldPosition(camPos);
      view.root.rotation.y = Math.atan2(camPos.x - s.px, camPos.z - s.py) - Math.PI / 2;
    },
    destroy: (view) => {
      view.root.removeFromParent();
      view.cursor.removeFromParent();
      view.cursor.geometry.dispose();
      view.cursor.material.dispose();
    },
  });

  /** On the Haunt's screen, markers grow with distance so they stay a readable size. */
  function zoomScale(x: number, y: number): number {
    rig.camera.getWorldPosition(camPos);
    return Math.max(1, Math.hypot(camPos.x - x, camPos.y, camPos.z - y) / 22);
  }

  return {
    update: () => {
      // the nearest beams get the real lights, your own first
      beams.sort((a, b) => a.near - b.near);
      for (let i = 0; i < SPOTS; i++) {
        const spot = spots[i];
        const beam = beams[i];
        if (!beam) {
          spot.intensity = 0;
          continue;
        }
        spot.intensity = beam.mine ? 16 : 11;
        spot.position.copy(beam.from);
        spot.target.position.copy(beam.from).addScaledVector(beam.dir, 8);
        spot.target.updateMatrixWorld();
        // a little dust hanging in your own beam
        if (beam.mine && Math.random() < 0.35) ctx.fx.dust(beam.from.x, beam.from.z, beam.from.y, beam.dir.x, beam.dir.z, beam.dir.y);
      }
      beams.length = 0;
    },
  };
}
