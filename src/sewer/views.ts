import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { bodyView, poseBody, type BodyView } from '../crossplay/avatarView';
import { headingToYaw, signedAngle } from '../crossplay/math';
import { disposeLabel, setLabel, toolTip } from '../crossplay/models';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import { waterLevel, type GoblinEntity, type LootEntity, type SewerContext, type Vec3 } from './context';
import { Goblin, GoblinMode, Lord, LordMode, Loot, LootWhere, SplatKind } from './defs';
import { HOSE, HOSE_RANGE, TOOLS } from './kit';
import { goblinRig, lootModel, lordModel, poseDead, poseDowned, restGoblin, type GoblinRig, type LordModel } from './models';
import type { Ragdolls } from './ragdoll';

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own Lord, e.g. when watching yourself from behind. */
  showSelf(): boolean;
  /** Where your own hose's nozzle is seen (a first-person model), or null to use your replicated hand. */
  nozzle(out: Vec3): Vec3 | null;
}

interface LordView extends BodyView {
  rig: LordModel;
  name: string;
  t: number;
  punches: number;
  punch: number;
  nextSpray: number;
  nextStep: number;
}

interface GoblinView {
  rig: GoblinRig;
  t: number;
  strikes: number;
  lunge: number;
  lastX: number;
  lastY: number;
  speed: number;
  nextGiggle: number;
  splatted: boolean;
}

/** Point lights shared among the nearest other Lordz's headlamps. A fixed number, so shaders never recompile. */
const LAMPS = 3;

const tq = new THREE.Quaternion();
const te = new THREE.Euler(0, 0, 0, 'YXZ');
const tipV = new THREE.Vector3();
const camPos = new THREE.Vector3();
const nozzleTmp: Vec3 = { x: 0, y: 0, z: 0 };
const hoseTip = toolTip(HOSE);

/**
 * How Lordz, goblins and loot are drawn. Lordz wear their tools and a sack once they've loot, and swing when they punch;
 * a hose that's spraying throws a jet (and fat where it lands). Goblins scurry, lunge, flail when held, and vanish into a
 * ragdoll or a burst of gunk the moment they're splattered. Loot glints on the walkways, rides on goblins' heads, and is
 * hidden in the silt or someone's sack.
 */
export function registerViews(ctx: SewerContext, views: EntityViews, scene: THREE.Scene, rig: Rig, local: LocalView, ragdolls: Ragdolls): { update(dt: number): void; splat(p: { goblin: number; kind: SplatKind; x: number; y: number; z: number; angle: number; vx: number; vy: number; vz: number }): void } {
  const lamps: THREE.PointLight[] = [];
  for (let i = 0; i < LAMPS; i++) {
    const l = new THREE.PointLight(0xfff0c8, 0, 9, 1.5);
    scene.add(l);
    lamps.push(l);
  }
  const heads: { at: THREE.Vector3; d: number }[] = [];
  const splatted = new Set<number>();

  views.register(Lord, {
    create: (e): LordView => {
      const model = lordModel(e.state.skin);
      model.body.rotation.order = 'YXZ';
      scene.add(model.root);
      return { ...bodyView(model, e.x, e.y), rig: model, name: '', t: Math.random() * 10, punches: e.state.punches, punch: 0, nextSpray: 0, nextStep: 0 };
    },
    update: (view, e, dt) => {
      const s = e.render;
      const r = view.rig;
      const isMe = e === ctx.me;
      view.t += dt;
      const gone = s.mode === LordMode.Surfaced;
      r.root.visible = !gone && (!isMe || local.showSelf());
      if (view.name !== s.name) {
        view.name = s.name;
        setLabel(r.label, s.name);
      }
      r.label.visible = !isMe && !gone && s.mode !== LordMode.Dead;
      const ground = ctx.map.groundAt(e.x, e.y);
      r.root.position.set(e.x, ground + s.z, e.y);
      switch (s.mode) {
        case LordMode.Downed:
          poseDowned(r, s.yaw, view.t);
          view.lastX = e.x;
          view.lastY = e.y;
          r.tool.visible = r.toolL.visible = false;
          break;
        case LordMode.Dead:
          r.root.position.y = waterLevel(ctx) - 0.2;
          poseDead(r, s.yaw, view.t);
          r.tool.visible = r.toolL.visible = false;
          break;
        default:
          r.body.position.y = 0;
          poseBody(view, s, e.x, e.y, dt, TOOLS);
      }
      // a punch thrown: the arm shoots out (a headset's arms already follow the hands)
      if (s.punches !== view.punches) {
        view.punches = s.punches;
        view.punch = 1;
      }
      view.punch = Math.max(0, view.punch - dt * 5);
      if (view.punch > 0 && s.platform !== Platform.Vr && s.tool === 255) r.armR.rotation.set(0, 0, Math.sin(view.punch * Math.PI) * 1.7);
      r.sack.visible = s.sack > 0 && !gone && s.mode !== LordMode.Dead;
      r.sack.scale.setScalar(0.8 + s.sack * 0.12);
      r.lamp.visible = !gone && s.mode !== LordMode.Dead;
      // wading: a squelch now and then, from someone else
      if (!isMe && view.speed > 0.8 && view.t > view.nextStep) {
        view.nextStep = view.t + 0.45;
        ctx.sfx.play('squelch', { x: e.x, y: e.y, z: ground }, 0.5);
      }
      if (s.spraying && !gone) spray(view, e, isMe);
      if (!isMe && !gone && s.mode !== LordMode.Dead) {
        r.head.getWorldPosition(camPos);
        heads.push({ at: camPos.clone(), d: 0 });
      }
    },
    destroy: (view) => {
      view.rig.root.removeFromParent();
      disposeLabel(view.rig.label);
    },
  });

  /** A spraying hose: the jet from its nozzle, and fat flying where it lands. */
  function spray(view: LordView, e: { x: number; y: number; render: { hx: number; hy: number; hz: number; aimYaw: number; aimPitch: number; lhx: number; lhy: number; lhz: number; laimYaw: number; laimPitch: number; tool: number; ltool: number; z: number } }, isMe: boolean): void {
    const s = e.render;
    const left = s.ltool === HOSE.id && s.tool !== HOSE.id;
    const [hx, hy, hz, yaw, pitch] = left ? [s.lhx, s.lhy, s.lhz, s.laimYaw, s.laimPitch] : [s.hx, s.hy, s.hz, s.aimYaw, s.aimPitch];
    tq.setFromEuler(te.set(signedAngle(pitch), headingToYaw(yaw), 0));
    tipV.copy(hoseTip).applyQuaternion(tq);
    const ground = ctx.map.groundAt(e.x, e.y);
    const o = (isMe && local.nozzle(nozzleTmp)) || { x: e.x + hx + tipV.x, y: e.y + hy + tipV.z, z: ground + s.z + hz + tipV.y };
    const d = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: Math.sin(pitch) };
    const hit = ctx.plug.raycast(o, d, HOSE_RANGE);
    ctx.fx.jet(o.x, o.y, o.z, d.x, d.y, d.z, hit?.dist ?? HOSE_RANGE, 1);
    if (hit) ctx.fx.blast(hit.at.x, hit.at.y, hit.at.z, d.x, d.y, d.z);
    if (view.t >= view.nextSpray) {
      view.nextSpray = view.t + 0.13;
      ctx.sfx.play('spray', o, isMe ? 0.7 : 1);
    }
  }

  views.register(Goblin, {
    create: (e): GoblinView => {
      const r = goblinRig(e.state.look);
      restGoblin(r);
      scene.add(r.root);
      return { rig: r, t: Math.random() * 10, strikes: e.state.strikes, lunge: 0, lastX: e.x, lastY: e.y, speed: 0, nextGiggle: 4 + Math.random() * 10, splatted: false };
    },
    update: (view, e, dt) => animateGoblin(view, e as GoblinEntity, dt),
    destroy: (view) => view.rig.root.removeFromParent(),
  });

  function animateGoblin(view: GoblinView, e: GoblinEntity, dt: number): void {
    const s = e.render;
    const r = view.rig;
    const p = r.pivots;
    view.t += dt;
    if (view.splatted || splatted.has(e.id) || s.mode === GoblinMode.Dead || s.mode === GoblinMode.Gone) {
      r.root.visible = false;
      return;
    }
    r.root.visible = true;
    const moved = Math.hypot(e.x - view.lastX, e.y - view.lastY) / Math.max(dt, 1e-3);
    view.lastX = e.x;
    view.lastY = e.y;
    view.speed += ((moved > 12 ? 0 : moved) - view.speed) * Math.min(1, dt * 8);
    r.root.position.set(e.x, s.z, e.y);
    r.root.rotation.set(0, -s.angle, 0);
    if (s.strikes !== view.strikes) {
      view.strikes = s.strikes;
      view.lunge = 1;
    }
    view.lunge = Math.max(0, view.lunge - dt * 4);
    const lunge = Math.sin(view.lunge * Math.PI);
    restGoblin(r);
    const pace = Math.min(1, view.speed / 3);
    const cycle = view.t * (6 + view.speed * 3);
    const swing = Math.sin(cycle) * 0.8 * pace;
    switch (s.mode) {
      case GoblinMode.Held: {
        // kicking and flailing
        const k = view.t * 16;
        p.legL.rotation.z = Math.sin(k) * 0.9;
        p.legR.rotation.z = -Math.sin(k) * 0.9;
        p.armL.rotation.set(Math.sin(k * 1.3) * 0.6, 0, 2 + Math.sin(k) * 0.6);
        p.armR.rotation.set(-Math.sin(k * 1.1) * 0.6, 0, 2 - Math.sin(k) * 0.6);
        p.head.rotation.set(Math.sin(k * 0.7) * 0.4, 0, -0.3);
        break;
      }
      case GoblinMode.Stagger: {
        const k = view.t * 9;
        r.body.rotation.set(Math.sin(k) * 0.35, Math.sin(k * 0.5) * 0.3, -0.25);
        p.head.rotation.set(Math.sin(k * 1.4) * 0.5, 0, 0.3);
        p.armL.rotation.z = -0.6;
        p.armR.rotation.z = -0.6;
        break;
      }
      case GoblinMode.Flee:
        p.legL.rotation.z = swing * 1.2;
        p.legR.rotation.z = -swing * 1.2;
        // arms up, holding whatever it's got over its head
        p.armL.rotation.set(-0.2, 0, 2.8);
        p.armR.rotation.set(0.2, 0, 2.8);
        r.body.rotation.z = -0.25;
        r.body.position.y += Math.abs(Math.sin(cycle)) * 0.08;
        break;
      default:
        p.legL.rotation.z = swing;
        p.legR.rotation.z = -swing;
        p.armL.rotation.z = -swing * 0.9 + (s.mode === GoblinMode.Chase ? 1.1 : 0) + lunge * 1.6;
        p.armR.rotation.z = swing * 0.9 + (s.mode === GoblinMode.Chase ? 1.1 : 0) + lunge * 1.6;
        r.body.rotation.z = -0.2 - pace * 0.25 - lunge * 0.4;
        r.body.position.x = lunge * 0.3;
        r.body.position.y += Math.abs(Math.sin(cycle)) * 0.05 * pace;
        p.head.rotation.set(Math.sin(view.t * 1.7) * 0.2, 0, 0.2 + pace * 0.2);
    }
    // cackling to itself in the dark
    view.nextGiggle -= dt;
    if (view.nextGiggle <= 0) {
      view.nextGiggle = 5 + Math.random() * 12;
      ctx.sfx.play('giggle', { x: e.x, y: e.y, z: s.z + 1 });
    }
  }

  views.register(Loot, {
    create: (e) => {
      const model = lootModel(e.state.kind);
      scene.add(model.root);
      return { ...model, t: Math.random() * 10, nextGlint: 0 };
    },
    update: (view, e: LootEntity, dt) => {
      const s = e.render;
      view.t += dt;
      const carriedByLord = s.where === LootWhere.Carried && !!ctx.world.getAs(Lord, s.carrier);
      view.root.visible = s.where !== LootWhere.Buried && !carriedByLord;
      if (!view.root.visible) return;
      const water = waterLevel(ctx);
      const loose = s.where === LootWhere.Lying;
      view.root.position.set(e.x, s.z, e.y);
      view.spin.rotation.y = loose ? view.t * 0.6 : view.t * 4;
      view.glint.visible = s.z + 0.1 > water;
      view.glint.material.opacity = 0.5 + Math.sin(view.t * 3) * 0.3;
      view.nextGlint -= dt;
      if (view.glint.visible && view.nextGlint <= 0) {
        view.nextGlint = 0.3 + Math.random() * 0.5;
        ctx.fx.glint(e.x, e.y, s.z + 0.1);
      }
    },
    destroy: (view) => view.root.removeFromParent(),
  });

  return {
    update: () => {
      // the nearest other Lordz's headlamps get the real lights
      rig.camera.getWorldPosition(camPos);
      for (const h of heads) h.d = h.at.distanceToSquared(camPos);
      heads.sort((a, b) => a.d - b.d);
      lamps.forEach((l, i) => {
        const h = heads[i];
        l.intensity = h ? 5 : 0;
        if (h) l.position.copy(h.at).add(tipV.set(0, 0.25, 0));
      });
      heads.length = 0;
      ctx.fx.water = waterLevel(ctx);
      ragdolls.water = ctx.fx.water;
    },
    splat: (p) => {
      if (splatted.has(p.goblin)) return;
      splatted.add(p.goblin);
      const g = ctx.world.getAs(Goblin, p.goblin);
      ragdolls.splat(p.kind, g?.render.look ?? 0, p.x, p.y, p.z, p.angle, p.vx, p.vy, p.vz);
      if (p.kind === SplatKind.Gib) ctx.fx.burst(p.x, p.y, p.z, p.vx, p.vy, p.vz);
      else if (p.kind === SplatKind.Tear) {
        const len = Math.hypot(p.vx, p.vy) || 1;
        ctx.fx.tear(p.x, p.y, p.z, p.vx / len, p.vy / len);
      } else ctx.fx.gunk(p.x, p.y, p.z + 0.8, p.vx * 0.4, p.vy * 0.4, p.vz * 0.4, 18);
      if (splatted.size > 400) splatted.clear();
    },
  };
}
