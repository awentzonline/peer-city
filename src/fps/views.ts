import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { NO_WEAPON } from './arsenal';
import { angleDiff, clamp, headingToYaw, signedAngle, type GameContext } from './context';
import { Car, CarKind, CarMode, Ped, PedMode, Pickup, Player } from './defs';
import { HUMAN, MAT, buildCar, buildHuman, buildPickup, disposeLabel, setGunModel, setLabel, type CarRig, type HumanRig, type PickupRig } from './models';
import type { PlayerController } from './player';
import { COP_SKINS, PED_SKINS, carSpec, humanLook } from './specs';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const shoulder = new THREE.Vector3();
const reach = new THREE.Vector3();

interface HumanView {
  rig: HumanRig;
  lastX: number;
  lastY: number;
  phase: number;
  speed: number;
  dead: boolean;
  name: string;
  /** Gun models currently in the right and left hands. */
  weapons: [number, number];
}

interface CarView {
  rig: CarRig;
  wrecked: boolean;
  fx: number;
  spin: number;
  name: string;
}

function createHuman(ctx: GameContext, skin: number, cop: boolean, x: number, y: number): HumanView {
  const rig = buildHuman(humanLook(skin, cop));
  rig.root.position.set(x, 0, y);
  ctx.scene.add(rig.root);
  return { rig, lastX: x, lastY: y, phase: Math.random() * 6, speed: 0, dead: false, name: '', weapons: [0, 0] };
}

function destroyHuman(ctx: GameContext, v: HumanView): void {
  ctx.scene.remove(v.rig.root);
  disposeLabel(v.rig.label);
}

/** Walk cycle from how far the rendered position moved; returns the limb swing angle. */
function stride(v: HumanView, x: number, y: number, dt: number): number {
  const moved = Math.hypot(x - v.lastX, y - v.lastY);
  v.lastX = x;
  v.lastY = y;
  const speed = moved / Math.max(dt, 0.001);
  v.speed += ((speed > 15 ? 0 : speed) - v.speed) * Math.min(1, dt * 8);
  v.phase += v.speed * dt * 2.2;
  return Math.min(v.speed / 4, 1) * 0.65 * Math.sin(v.phase);
}

function pose(ctx: GameContext, v: HumanView, heading: number, dead: boolean): void {
  const r = v.rig;
  if (dead !== v.dead) {
    v.dead = dead;
    if (dead) ctx.fx.blood(r.root.position.x, r.root.position.z);
  }
  // falling over: tip backwards about the feet, then face the heading
  r.body.rotation.set(0, -heading, dead ? Math.PI / 2 : 0);
  r.body.position.y = dead ? 0.14 : 0;
  r.shadow.visible = !dead;
}

/** Point an arm from its shoulder at a target given in root space. */
function aimArm(r: HumanRig, heading: number, target: THREE.Vector3, left = false): void {
  shoulder.set(0, HUMAN.shoulder * r.body.scale.y, left ? -HUMAN.shoulderZ : HUMAN.shoulderZ).applyAxisAngle(UP, -heading);
  reach.copy(target).sub(shoulder).applyAxisAngle(UP, heading);
  if (reach.lengthSq() < 1e-4) return;
  (left ? r.armL : r.armR).quaternion.setFromUnitVectors(DOWN, reach.normalize());
}

/**
 * Put a replicated hand's gun in place and point that arm at it. An empty hand
 * only reaches out for headset players, whose hands are really tracked;
 * otherwise the arm is left swinging.
 */
function holdGun(v: HumanView, heading: number, side: 0 | 1, weapon: number, x: number, y: number, z: number, aimYaw: number, aimPitch: number, tracked: boolean): void {
  const r = v.rig;
  const gun = side ? r.gunL : r.gun;
  const armed = weapon !== NO_WEAPON;
  if (armed && v.weapons[side] !== weapon) {
    v.weapons[side] = weapon;
    setGunModel(gun, weapon);
  }
  gun.visible = armed;
  if (!armed && !tracked) return;
  gun.position.set(x, z, y);
  gun.rotation.set(signedAngle(aimPitch), headingToYaw(aimYaw), 0);
  aimArm(r, heading, gun.position, side === 1);
}

export function registerViews(ctx: GameContext, views: EntityViews, player: PlayerController): void {
  const { world } = ctx;

  views.register(Player, {
    create: (e) => createHuman(ctx, e.state.skin % PED_SKINS, false, e.x, e.y),
    update: (v, e, dt) => {
      const s = e.render;
      const r = v.rig;
      const isMe = e === ctx.me;
      r.root.visible = !isMe || player.showSelf;
      if (!r.root.visible) {
        v.lastX = e.x;
        v.lastY = e.y;
        return;
      }
      if (v.name !== s.name) {
        v.name = s.name;
        setLabel(r.label, s.name);
      }
      const dead = s.hp === 0;
      r.label.visible = !isMe && !dead;
      const car = s.car && !dead ? world.getAs(Car, s.car) : undefined;
      r.legL.visible = r.legR.visible = !car;

      if (car) {
        // sit in the driver's seat
        const spec = carSpec(car.state.kind);
        const a = car.render.angle;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const lx = spec.eye[0] - 0.08;
        const lz = spec.eye[2];
        r.root.position.set(car.x + lx * c - lz * sn, spec.floor + 0.42 - HUMAN.hip, car.y + lx * sn + lz * c);
        r.body.rotation.set(0, -a, 0);
        r.body.position.y = 0;
        r.body.scale.y = 1;
        r.head.rotation.set(0, -clamp(angleDiff(a, s.yaw), -1.3, 1.3), clamp(signedAngle(s.pitch), -0.8, 0.8));
        r.armL.rotation.set(0, 0, -1);
        r.armR.rotation.set(0, 0, -1);
        r.gun.visible = r.gunL.visible = false;
        r.shadow.visible = false;
        v.lastX = e.x;
        v.lastY = e.y;
        v.dead = false;
        return;
      }

      r.root.position.set(e.x, s.z, e.y);
      r.shadow.position.y = 0.04 - s.z;
      pose(ctx, v, s.yaw, dead);
      if (dead) {
        r.gun.visible = r.gunL.visible = false;
        return;
      }
      r.body.scale.y = clamp(s.head / 1.65, 0.55, 1.15); // VR players crouching for real
      r.head.rotation.set(0, 0, clamp(signedAngle(s.pitch), -0.9, 0.9));
      const swing = stride(v, e.x, e.y, dt);
      r.legL.rotation.z = swing;
      r.legR.rotation.z = -swing;
      r.armL.rotation.set(0, 0, -swing * 0.8);
      r.armR.rotation.set(0, 0, swing * 0.8);
      holdGun(v, s.yaw, 0, s.weapon, s.hx, s.hy, s.hz, s.aimYaw, s.aimPitch, s.vr);
      holdGun(v, s.yaw, 1, s.lweapon, s.lhx, s.lhy, s.lhz, s.laimYaw, s.laimPitch, s.vr);
    },
    destroy: (v) => destroyHuman(ctx, v),
  });

  views.register(Ped, {
    create: (e) => createHuman(ctx, e.state.skin % (e.state.cop ? COP_SKINS : PED_SKINS), e.state.cop, e.x, e.y),
    update: (v, e, dt) => {
      const s = e.render;
      const r = v.rig;
      const dead = s.mode === PedMode.Dead;
      r.root.position.set(e.x, 0, e.y);
      pose(ctx, v, s.angle, dead);
      if (dead) {
        r.gun.visible = false;
        return;
      }
      const swing = stride(v, e.x, e.y, dt);
      r.legL.rotation.z = swing;
      r.legR.rotation.z = -swing;
      r.armL.rotation.set(0, 0, -swing * 0.8);
      const aiming = s.cop && s.mode === PedMode.Attack;
      r.gun.visible = aiming;
      if (aiming) {
        const c = Math.cos(s.angle);
        const sn = Math.sin(s.angle);
        r.gun.position.set(c * 0.55 - sn * 0.2, 1.4, sn * 0.55 + c * 0.2);
        r.gun.rotation.set(0, headingToYaw(s.angle), 0);
        aimArm(r, s.angle, r.gun.position);
      } else {
        r.armR.rotation.set(0, 0, swing * 0.8);
      }
    },
    destroy: (v) => destroyHuman(ctx, v),
  });

  views.register(Car, {
    create: (e): CarView => {
      const rig = buildCar(e.state.kind, e.state.color);
      rig.root.position.set(e.x, 0, e.y);
      ctx.scene.add(rig.root);
      return { rig, wrecked: false, fx: 0, spin: 0, name: '' };
    },
    update: (v, e, dt) => {
      const s = e.render;
      const r = v.rig;
      const spec = carSpec(s.kind);
      r.root.position.set(e.x, 0, e.y);
      r.root.rotation.y = -s.angle;

      const wrecked = s.mode === CarMode.Wrecked;
      if (wrecked !== v.wrecked) {
        v.wrecked = wrecked;
        r.body.material = wrecked ? MAT.burnt : MAT.car;
      }
      v.spin -= (s.speed * dt) / spec.wheelR;
      for (const w of r.wheels) w.rotation.z = v.spin;
      const mine = !!ctx.me && ctx.me.state.car === e.id;
      r.steering.children[0].rotation.x = mine ? player.steer * 1.6 : 0;

      if (r.sirens.length) {
        const on = s.siren && s.kind === CarKind.Police && !wrecked;
        const phase = Math.floor(ctx.now / 180) % 2;
        r.sirens[0].material = MAT.sirenRed[on && phase === 0 ? 1 : 0];
        r.sirens[1].material = MAT.sirenBlue[on && phase === 1 ? 1 : 0];
      }
      r.npc.visible = !wrecked && (s.mode === CarMode.Traffic || s.mode === CarMode.Chase);

      v.fx -= dt;
      if (v.fx <= 0) {
        const hood = spec.length / 2 - 0.6;
        const hx = e.x + Math.cos(s.angle) * hood;
        const hy = e.y + Math.sin(s.angle) * hood;
        if (wrecked) {
          ctx.fx.fire(e.x, e.y, 1.1, 2);
          ctx.fx.smoke(e.x, e.y, 1.6);
          v.fx = 0.09;
        } else if (s.hp < 35) {
          ctx.fx.smoke(hx, hy, spec.belt + 0.1);
          if (s.hp < 15) ctx.fx.fire(hx, hy, spec.belt);
          v.fx = s.hp < 15 ? 0.1 : 0.25;
        } else {
          v.fx = 0.3;
        }
      }

      const driver = s.driver && s.mode === CarMode.Driven ? world.getAs(Player, s.driver) : undefined;
      const name = driver && driver !== ctx.me ? driver.render.name : '';
      if (name !== v.name) {
        v.name = name;
        if (name) setLabel(r.label, name);
      }
      r.label.visible = name !== '';
    },
    destroy: (v, e, reason) => {
      if (reason === 'destroyed' && v.wrecked) ctx.fx.smoke(e.x, e.y, 1.5, 6);
      ctx.scene.remove(v.rig.root);
      disposeLabel(v.rig.label);
    },
  });

  views.register(Pickup, {
    create: (e) => {
      const rig = buildPickup(e.state.kind, e.state.weapon);
      rig.root.position.set(e.x, 0, e.y);
      ctx.scene.add(rig.root);
      return { rig, t: Math.random() * 6 } as { rig: PickupRig; t: number };
    },
    update: (v, e, dt) => {
      v.t += dt;
      v.rig.root.position.set(e.x, 0, e.y);
      v.rig.spin.rotation.y = v.t * 2;
      v.rig.spin.position.y = 0.6 + Math.sin(v.t * 3) * 0.08;
    },
    destroy: (v) => {
      ctx.scene.remove(v.rig.root);
      v.rig.root.traverse((o) => {
        if (o instanceof THREE.Sprite) o.material.dispose();
      });
    },
  });
}
