import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { bodyView, poseBody, type BodyView } from '../crossplay/avatarView';
import { disposeLabel, nameTag, setLabel, type HumanRig } from '../crossplay/models';
import { headingOf, quatOf, sceneQuat } from '../crossplay/rigid';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import { Club, Flight, carry } from './ball';
import type { BallEntity, GolfContext } from './context';
import { Ball, BallMode, Cart, Golfer, Phase } from './defs';
import { driverOf, type Golfer as GolferRole } from './golfer';
import { targetHole } from './match';
import { TOOLS } from './kit';
import { ballGeometry, buildCart, golferColor, humanFor, poseLying, poseSeated, type CartModel } from './models';

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own golfer standing, e.g. from behind your ball. */
  showSelf(): boolean;
  /** Draw yourself sitting in your cart (not from the seat's own eyes). */
  showDriver(): boolean;
}

interface GolferView extends BodyView {
  name: string;
  t: number;
  stars: number;
}

/** How long a ball's trail lasts, s, and how many points it keeps. */
const TRAIL_SECONDS = 2.2;
const TRAIL_POINTS = 64;

interface BallView {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  trail: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  points: { x: number; y: number; z: number; t: number }[];
  color: number;
}

const tq = new THREE.Quaternion();
const q = { x: 0, y: 0, z: 0, w: 1 };
const eye = new THREE.Vector3();

export function registerViews(ctx: GolfContext, views: EntityViews, scene: THREE.Scene, rig: Rig, local: LocalView, golfer: GolferRole): { update(dt: number): void } {
  const { course } = ctx;
  let clock = 0;

  views.register(Golfer, {
    create: (e): GolferView => {
      const rig = humanFor(e.state.skin);
      rig.body.rotation.order = 'YXZ';
      scene.add(rig.root);
      return { ...bodyView(rig, e.x, e.y), name: '', t: Math.random() * 10, stars: 0 };
    },
    update: (view, e, dt) => {
      const s = e.render;
      const r = view.rig;
      const isMe = e === ctx.me;
      r.root.visible = !s.cart && (!isMe || local.showSelf());
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
      const ground = course.heightAt(e.x, e.y);
      r.root.position.set(e.x, ground + s.z, e.y);
      r.shadow.position.y = 0.04 - s.z;
      view.t += dt;
      if (s.down) {
        poseLying(r, s.yaw, view.t);
        view.lastX = e.x;
        view.lastY = e.y;
        view.stars -= dt;
        if (view.stars <= 0) {
          view.stars = 0.08;
          ctx.fx.dizzy(e.x - Math.cos(s.yaw) * 0.8, e.y - Math.sin(s.yaw) * 0.8, ground + 0.5, view.t);
        }
        return;
      }
      r.body.position.y = 0;
      poseBody(view, s, e.x, e.y, dt, TOOLS);
      if (s.address || s.charge > 0) twoHanded(r, s.yaw);
    },
    destroy: (view) => {
      scene.remove(view.rig.root);
      disposeLabel(view.rig.label);
    },
  });

  views.register(Ball, {
    create: (): BallView => {
      const mesh = new THREE.Mesh(ballGeometry(), new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x333333 }));
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
      trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 4), 4));
      const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      trail.frustumCulled = false;
      scene.add(mesh, trail);
      return { mesh, trail, points: [], color: -1 };
    },
    update: (view, e) => {
      const s = e.render;
      const visible = s.mode === BallMode.Rest || s.mode === BallMode.Moving;
      view.mesh.visible = visible;
      if (view.color !== s.color) {
        view.color = s.color;
        // white, with a tint of its golfer's colour so you can tell yours from across a green
        view.mesh.material.color.setHex(golferColor(s.color)).lerp(new THREE.Color(0xffffff), 0.55);
      }
      const x = e.x;
      const y = e.y;
      const z = s.z + 0.01;
      view.mesh.position.set(x, z, y);
      // bigger from further away, so it can be followed in the air and found on the ground: sooner once it's stopped
      rig.camera.getWorldPosition(eye);
      const d = Math.hypot(eye.x - x, eye.y - z, eye.z - y);
      view.mesh.scale.setScalar(Math.max(1, d / 18, s.mode === BallMode.Rest ? Math.min(4.5, d / 4) : 0));
      drawTrail(view, e, clock, visible && s.mode === BallMode.Moving);
    },
    destroy: (view) => {
      scene.remove(view.mesh, view.trail);
      view.mesh.material.dispose();
      view.trail.geometry.dispose();
      view.trail.material.dispose();
    },
  });

  views.register(Cart, {
    create: (e): CartModel => {
      const m = buildCart(e.state.slot);
      scene.add(m.root);
      return m;
    },
    update: (m, e, dt) => {
      const s = e.render;
      m.root.position.set(s.x, s.z, s.y);
      m.root.quaternion.copy(sceneQuat(quatOf(s, q), tq));
      for (const w of m.wheels) {
        w.spin.rotation.z -= (s.speed * dt) / 0.23;
        w.steer.rotation.y = w.front ? s.steer * 0.5 : 0;
      }
      const driver = driverOf(ctx, e);
      const skin = driver ? driver.render.skin : -1;
      if (skin !== m.driverSkin) {
        m.driverSkin = skin;
        if (m.driver) m.driver.root.removeFromParent();
        m.driver = skin >= 0 ? seated(skin) : null;
        if (m.driver) m.root.add(m.driver.root);
        if (driver) setLabel(m.label, driver.render.name);
      }
      const mine = !!driver && driver === ctx.me;
      if (m.driver) m.driver.root.visible = !mine || local.showDriver();
      m.label.visible = !!driver && !mine;
      if (Math.abs(s.speed) > 4 && Math.random() < dt * 20) {
        const back = headingOf(q) + Math.PI;
        const bx = s.x + Math.cos(back) * 1.1;
        const by = s.y + Math.sin(back) * 1.1;
        ctx.fx.dust(bx, by, Math.abs(s.speed), course.lieAt(bx, by));
      }
    },
    destroy: (m) => {
      m.root.removeFromParent();
      disposeLabel(m.label);
    },
  });

  // the aiming guide: a line out from your ball to where the shot comes down
  const guideGeo = new THREE.BufferGeometry();
  guideGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
  const guide = new THREE.Line(guideGeo, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.8, depthWrite: false }));
  guide.frustumCulled = false;
  const landing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 40, 8, 1, true).translate(0, 20, 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  // the hole being played: a column of light over its pin, and its number, until you're close enough to see the flag
  const pinBeacon = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  pinBeacon.frustumCulled = false;
  // a ring round your ball on the ground, from a few steps off until the column takes over
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 1, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
  );
  halo.renderOrder = 2;
  const pinLabel = nameTag(0);
  pinLabel.material.depthTest = false;
  pinLabel.renderOrder = 10;
  let pinLabelled = -1;
  scene.add(guide, landing, beacon, halo, pinBeacon, pinLabel);

  return {
    update: (dt) => {
      clock += dt;
      showGuide();
    },
  };

  function showGuide(): void {
    const me = ctx.me?.state;
    const ball = golfer.sim;
    const match = ctx.match()?.state;
    const aiming = !!me && (golfer.addressing || (me.platform === Platform.Vr && golfer.playable && Math.hypot(me.x - ball.x, me.y - ball.y) < 3));
    guide.visible = landing.visible = aiming;
    if (aiming) {
      const heading = golfer.addressing ? golfer.aimHeading : Math.atan2(golfer.hole.pin.y - ball.y, golfer.hole.pin.x - ball.x);
      const power = golfer.charging ? Math.max(0.05, golfer.charge) : 1;
      const end = carry(ball, golfer.club, power, heading, golfer.lie, course);
      const pos = guideGeo.getAttribute('position') as THREE.BufferAttribute;
      const n = pos.count;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = ball.x + (end.x - ball.x) * t;
        const y = ball.y + (end.y - ball.y) * t;
        // hugging the ground for a putt, arcing a little for everything else
        const lift = golfer.club === Club.Putter ? 0.03 : Math.sin(t * Math.PI) * Math.min(6, Math.hypot(end.x - ball.x, end.y - ball.y) * 0.05);
        pos.setXYZ(i, x, course.heightAt(x, y) + 0.05 + lift, y);
      }
      pos.needsUpdate = true;
      guide.computeLineDistances();
      landing.position.set(end.x, course.heightAt(end.x, end.y) + 0.06, end.y);
      landing.scale.setScalar(Math.max(0.6, Math.hypot(end.x - ball.x, end.y - ball.y) / 40));
      landing.material.color.setHex(golfer.charging ? 0xffd32a : 0xffffff);
    }

    // a column of light over your ball when it's waiting a long way off
    const b = ctx.ball?.state;
    const waiting = !!me && !!b && b.mode === BallMode.Rest && match?.phase === Phase.Playing && !(ball.flight === Flight.Air);
    const away = me ? Math.hypot(me.x - ball.x, me.y - ball.y) : 0;
    const far = waiting && away > 18;
    beacon.visible = far;
    // fades in from 3 m and stays on a little past where the column starts
    const near = waiting && !golfer.addressing ? Math.min(1, Math.max(0, (away - 3) / 4)) * Math.min(1, Math.max(0, (30 - away) / 6)) : 0;
    halo.visible = near > 0;
    if (near > 0) {
      halo.position.set(ball.x, course.heightAt(ball.x, ball.y) + 0.04, ball.y);
      halo.scale.setScalar((0.3 + away * 0.06) * (1 + ((clock * 0.8) % 1) * 0.35));
      halo.material.color.setHex(golferColor(b!.color)).lerp(new THREE.Color(0xffffff), 0.15);
      halo.material.opacity = near * (0.9 - ((clock * 0.8) % 1) * 0.5);
    }
    if (far) {
      beacon.position.set(ball.x, ball.z, ball.y);
      beacon.material.color.setHex(golferColor(b!.color));
      beacon.material.opacity = 0.25 + Math.sin(clock * 3) * 0.1;
    }
    showPin();
  }

  function showPin(): void {
    const match = ctx.match()?.state;
    const b = ctx.ball?.state;
    const target = match && targetHole(match);
    const playing = !!target && !target.waiting && !!b && b.mode !== BallMode.Holed;
    rig.camera.getWorldPosition(eye);
    const pin = playing ? course.holes[target.hole].pin : null;
    const d = pin ? Math.hypot(eye.x - pin.x, eye.z - pin.y) : 0;
    // fades in from 25 m, where the flag's easy to see
    const fade = pin ? Math.min(1, Math.max(0, (d - 25) / 35)) : 0;
    pinBeacon.visible = pinLabel.visible = fade > 0;
    if (!pin) return;
    // wider with distance, so it's a few pixels across wherever you are
    const width = Math.max(0.15, d * 0.004);
    const height = 45 + d * 0.15;
    pinBeacon.position.set(pin.x, pin.z, pin.y);
    pinBeacon.scale.set(width, height, width);
    pinBeacon.material.opacity = fade * (0.38 + Math.sin(clock * 2.5) * 0.08);
    if (pinLabelled !== target!.hole) {
      pinLabelled = target!.hole;
      setLabel(pinLabel, `Hole ${target!.hole + 1}`);
    }
    const k = Math.max(1, d / 9);
    pinLabel.position.set(pin.x, pin.z + height + 1.5 * k, pin.y);
    pinLabel.scale.set(3.2 * k, 0.8 * k, 1);
    pinLabel.material.opacity = fade;
  }
}

/** A crosshair golfer over the ball holds the club with both hands, bent a little at the waist. */
function twoHanded(r: HumanRig, yaw: number): void {
  r.body.rotation.z = -0.12;
  const target = r.tool.position;
  const shoulder = new THREE.Vector3(0.1, 1.45, -0.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  const reach = target.clone().sub(shoulder).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  if (reach.lengthSq() > 1e-4) r.armL.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), reach.normalize());
}

function seated(skin: number): HumanRig {
  const rig = humanFor(skin);
  poseSeated(rig, true);
  return rig;
}

/** A moving ball leaves a fading line behind it. */
function drawTrail(view: BallView, e: BallEntity, now: number, moving: boolean): void {
  const pts = view.points;
  if (moving) {
    const last = pts[pts.length - 1];
    if (!last || now - last.t > 0.03) pts.push({ x: e.x, y: e.y, z: e.render.z, t: now });
    if (pts.length > TRAIL_POINTS) pts.shift();
  }
  while (pts.length && now - pts[0].t > TRAIL_SECONDS) pts.shift();
  const geo = view.trail.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  pts.forEach((p, i) => {
    pos.setXYZ(i, p.x, p.z + 0.02, p.y);
    col.setXYZW(i, 1, 1, 1, 0.7 * (1 - (now - p.t) / TRAIL_SECONDS) * (i / pts.length));
  });
  geo.setDrawRange(0, pts.length);
  view.trail.visible = pts.length > 1;
  pos.needsUpdate = true;
  col.needsUpdate = true;
}
