import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { bodyView, poseBody, stride, type BodyView } from '../crossplay/avatarView';
import { disposeLabel, glowTexture, setLabel, toolGeometry, SOLID } from '../crossplay/models';
import type { Rig } from '../crossplay/rig';
import type { CaptainRole } from './captain';
import type { Scenery } from './scenery';
import type { BeaconEntity, BladeEntity, GuardEntity, ShinobiContext, ShinobiEntity } from './context';
import { Alert, Beacon, Blade, Captain, Guard, GuardKind, GuardMode, Shinobi, ShinobiMode, Weapon } from './defs';
import { GUARDS } from './guards';
import { PING_MS, SIGHTING_MS, type Ping } from './intel';
import { KUNAI, SHURIKEN, TOOLS, arrowGeometry, thrownTool } from './kit';
import { brazierGeometry, disposeSprite, fanGeometry, groundRing, guardModel, iconMaterial, lightPool, poseClimbing, poseDead, poseDowned, shinobiModel, textSprite, type GuardModel } from './models';
import { BRAZIER_REACH, HAND_LANTERN } from './shinobi';

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own shinobi, e.g. when spectating yourself. */
  showSelf(): boolean;
}

interface ShinobiView extends BodyView {
  name: string;
  t: number;
  /** The captain's red ring round a shinobi a guard sees. */
  marker: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

interface GuardView extends BodyView {
  model: GuardModel;
  kind: GuardKind;
  t: number;
  strikes: number;
  lunge: number;
  icon: THREE.Sprite;
  /** The captain's map: what it can see, whether it's picked out, and a cross once it's known to be dead. */
  fan: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  cross: THREE.Sprite;
  pool: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** A glow in its kind's colour over its head, so the captain can find it from far off. */
  badge: THREE.Sprite;
}

/** Each kind's colour on the captain's map. */
const BADGES: Record<GuardKind, number> = {
  [GuardKind.Spear]: 0x8fd0ff,
  [GuardKind.Archer]: 0x9fe08a,
  [GuardKind.Samurai]: 0xff9a5a,
  [GuardKind.Lord]: 0xffd35a,
};

/** Point lights shared out among the nearest fires. A fixed number, so the shaders never recompile. */
const LIGHTS = 6;

const camPos = new THREE.Vector3();
const lanternPos = new THREE.Vector3();

/** A fire that wants a real light: where it is and how bright. */
interface Fire {
  x: number;
  y: number;
  z: number;
  reach: number;
  d: number;
}

export function registerViews(ctx: ShinobiContext, views: EntityViews, scene: THREE.Scene, rig: Rig, scenery: Scenery, local: LocalView, captain: CaptainRole | null): { update(dt: number): void } {
  const fires: Fire[] = [];
  const lights: THREE.PointLight[] = [];
  for (let i = 0; i < LIGHTS; i++) {
    const light = new THREE.PointLight(0xffa850, 0, 9, 1.4);
    scene.add(light);
    lights.push(light);
  }
  const lift = () => scenery.heightScale;
  const intel = captain?.intel ?? null;

  views.register(Shinobi, {
    create: (e): ShinobiView => {
      const model = shinobiModel(e.state.skin);
      model.body.rotation.order = 'YXZ';
      const marker = groundRing(0.6, 0.85, 0xff3a2a);
      marker.visible = false;
      scene.add(model.root, marker);
      return { ...bodyView(model, e.x, e.y), name: '', t: Math.random() * 10, marker };
    },
    update: (view, e: ShinobiEntity, dt) => {
      const s = e.render;
      const r = view.rig;
      const isMe = e === ctx.me;
      view.t += dt;
      // the captain only sees who a guard sees
      const seen = !intel || intel.sees(e.id);
      r.root.visible = (!isMe || local.showSelf()) && seen && s.mode !== ShinobiMode.Escaped;
      view.marker.visible = !!intel && seen && r.root.visible;
      if (view.marker.visible) {
        view.marker.position.set(e.x, s.z * lift() + 0.08, e.y);
        view.marker.scale.setScalar(zoomScale(e.x, e.y) * (1 + Math.sin(view.t * 8) * 0.12));
      }
      if (view.name !== s.name) {
        view.name = s.name;
        setLabel(r.label, s.name);
      }
      r.label.visible = !isMe && !intel && s.mode !== ShinobiMode.Dead;
      r.root.position.set(e.x, s.z * lift(), e.y);
      switch (s.mode) {
        case ShinobiMode.Downed:
          poseDowned(r, s.yaw, view.t);
          r.tool.visible = r.toolL.visible = false;
          view.lastX = e.x;
          view.lastY = e.y;
          break;
        case ShinobiMode.Dead:
          poseDead(r, s.yaw);
          r.tool.visible = r.toolL.visible = false;
          break;
        default:
          poseBody(view, s, e.x, e.y, dt, TOOLS);
          if (s.climbing) poseClimbing(r, view.t);
      }
    },
    destroy: (view) => {
      scene.remove(view.rig.root, view.marker);
      disposeLabel(view.rig.label);
      view.marker.geometry.dispose();
      view.marker.material.dispose();
    },
  });

  views.register(Guard, {
    create: (e): GuardView => {
      const kind = e.state.kind;
      const model = guardModel(kind);
      model.body.rotation.order = 'YXZ';
      const spec = GUARDS[kind];
      const icon = new THREE.Sprite(iconMaterial('?', '#ffd24a').clone());
      icon.position.y = 2.45;
      icon.scale.setScalar(0.6);
      icon.visible = false;
      icon.renderOrder = 20;
      model.root.add(icon);
      const fan = new THREE.Mesh(fanGeometry(spec.sight * 0.55, spec.fov), new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xbfd4ff, transparent: true, opacity: 0.22, depthWrite: false, fog: false, side: THREE.DoubleSide }));
      fan.visible = false;
      fan.renderOrder = 3;
      const ring = groundRing(0.55, 0.75, 0x6ad0ff);
      ring.visible = false;
      const cross = new THREE.Sprite(iconMaterial('✕', '#ff5a4a'));
      cross.visible = false;
      cross.renderOrder = 21;
      const pool = lightPool(HAND_LANTERN * 0.8, 0xffa850, 0.22);
      pool.visible = false;
      const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: BADGES[kind], blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, fog: false }));
      badge.renderOrder = 19;
      badge.visible = false;
      scene.add(model.root, fan, ring, cross, pool, badge);
      return { ...bodyView(model, e.x, e.y), model, kind, t: Math.random() * 10, strikes: e.state.strikes, lunge: 0, icon, fan, ring, cross, pool, badge };
    },
    update: (view, e: GuardEntity, dt) => animateGuard(view, e, dt),
    destroy: (view) => {
      scene.remove(view.model.root, view.fan, view.ring, view.cross, view.pool, view.badge);
      view.badge.material.dispose();
      view.icon.material.dispose();
      view.fan.material.dispose();
      view.ring.geometry.dispose();
      view.ring.material.dispose();
      view.pool.material.dispose();
      disposeLabel(view.model.label);
      view.model.lanternGlow.material.dispose();
    },
  });

  function animateGuard(view: GuardView, e: GuardEntity, dt: number): void {
    const s = e.render;
    const m = view.model;
    view.t += dt;
    const knownDead = s.mode === GuardMode.Dead && (!intel || !intel.standing(e));
    const z = s.z * lift();
    m.root.position.set(e.x, z, e.y);
    const swing = knownDead || s.mode === GuardMode.Dead ? 0 : stride(view, e.x, e.y, dt);

    if (s.strikes !== view.strikes) {
      view.strikes = s.strikes;
      view.lunge = 1;
    }
    view.lunge = Math.max(0, view.lunge - dt * 3.5);
    const lunge = Math.sin(view.lunge * Math.PI);

    if (knownDead) {
      poseDead(m, s.angle);
      m.weapon.visible = view.kind === GuardKind.Spear;
    } else {
      m.body.rotation.set(0, -s.angle, 0);
      m.body.position.set(0, 0, 0);
      m.weapon.visible = true;
      m.shadow.visible = true;
      m.head.rotation.set(0, -s.look, 0);
      m.legL.rotation.set(0, 0, swing);
      m.legR.rotation.set(0, 0, -swing);
      m.armL.rotation.set(0, 0, -swing * 0.6);
      const fighting = s.mode === GuardMode.Chase || s.alert === Alert.Alarmed;
      switch (view.kind) {
        case GuardKind.Spear:
          // upright on patrol; levelled at an intruder, and thrust
          m.weapon.rotation.z = fighting ? -1.35 : 0;
          m.weapon.position.set(fighting ? -0.3 + lunge * 0.7 : 0.12, fighting ? 1.15 : 0.05, fighting ? 0.25 : 0.42);
          m.armR.rotation.set(0, 0, fighting ? 1.2 + lunge * 0.4 : swing * 0.6);
          break;
        case GuardKind.Archer:
          m.armL.rotation.set(0, 0, fighting ? 1.55 : -swing * 0.6);
          m.armR.rotation.set(0, 0, fighting ? 1.3 - lunge * 0.4 : swing * 0.6);
          m.weapon.position.set(fighting ? 0.7 : 0.3, fighting ? 1.45 : 1.2, fighting ? -0.28 : -0.38);
          break;
        case GuardKind.Samurai:
          m.weapon.rotation.z = fighting ? -0.5 - lunge * 1.4 : -1.9;
          m.weapon.position.set(fighting ? 0.35 : 0.1, fighting ? 1.3 : 0.95, fighting ? 0.25 : -0.3);
          m.armR.rotation.set(0, 0, fighting ? 1.6 - lunge : swing * 0.6);
          break;
        default:
          m.armR.rotation.set(0, 0, swing * 0.6);
      }
    }
    const lantern = s.lantern && !knownDead && s.mode !== GuardMode.Dead;
    m.lantern.visible = lantern;
    view.pool.visible = lantern && !intel;
    if (lantern) {
      m.lantern.rotation.z = Math.sin(view.t * 2.2) * 0.12;
      m.lanternGlow.material.opacity = 0.75 + Math.sin(view.t * 9) * 0.08;
      view.pool.position.set(e.x + Math.cos(s.angle) * 0.4, z + 0.03, e.y + Math.sin(s.angle) * 0.4);
      m.lantern.getWorldPosition(lanternPos);
      rig.camera.getWorldPosition(camPos);
      fires.push({ x: lanternPos.x, y: lanternPos.z, z: lanternPos.y - 0.2, reach: HAND_LANTERN * 1.6, d: camPos.distanceTo(lanternPos) });
    }

    // what it's thinking, over its head
    const alive = s.mode !== GuardMode.Dead;
    const alarmed = alive && s.alert === Alert.Alarmed;
    const wary = alive && !alarmed && (s.alert === Alert.Suspicious || s.sus > 0.08) && view.kind !== GuardKind.Lord;
    view.icon.visible = alarmed || wary || (view.kind === GuardKind.Lord && alive);
    if (view.icon.visible) {
      const want = view.kind === GuardKind.Lord && !alarmed ? iconMaterial('◆', '#ffd35a') : alarmed ? iconMaterial('!', '#ff4a3a') : iconMaterial('?', '#ffd24a');
      if (view.icon.material.map !== want.map) {
        view.icon.material.map = want.map;
        view.icon.material.needsUpdate = true;
      }
      const lord = view.kind === GuardKind.Lord;
      // the lord's marker shows through walls, so shinobi can find their mark
      view.icon.material.depthTest = !lord || !!intel;
      rig.camera.getWorldPosition(camPos);
      // the lord's mark stays a readable size however far off he is
      const scale = lord ? (intel ? 0.45 : Math.max(0.6, camPos.distanceTo(m.root.position) * 0.05)) : alarmed ? 0.75 : 0.35 + 0.45 * Math.min(1, s.sus);
      view.icon.scale.setScalar(scale * (intel ? zoomScale(e.x, e.y) * 1.3 : 1));
      view.icon.position.y = (lord ? 2.7 : 2.45) + Math.sin(view.t * 4) * 0.04;
      view.icon.material.opacity = lord ? 0.85 : alarmed ? 1 : 0.55 + 0.45 * Math.min(1, s.sus);
    }

    // the captain's map
    const mapped = !!captain;
    const standing = mapped && !knownDead;
    view.fan.visible = standing && view.kind !== GuardKind.Lord;
    if (view.fan.visible) {
      view.fan.position.set(e.x, z + 0.06, e.y);
      view.fan.rotation.y = -(s.angle + s.look);
      view.fan.material.color.setHex(alarmed ? 0xff5a4a : s.alert === Alert.Suspicious ? 0xffd24a : 0xbfd4ff);
      view.fan.material.opacity = alarmed ? 0.32 : 0.22;
    }
    view.ring.visible = mapped && captain!.selected.has(e.id) && !knownDead;
    if (view.ring.visible) {
      view.ring.position.set(e.x, z + 0.07, e.y);
      view.ring.scale.setScalar(zoomScale(e.x, e.y));
    }
    view.badge.visible = standing;
    if (standing) {
      const zoom = zoomScale(e.x, e.y);
      view.badge.position.set(e.x, z + 2.2 * lift() + 0.4 * zoom, e.y);
      view.badge.scale.setScalar((view.ring.visible ? 1.3 : 0.9) * zoom);
      view.badge.material.color.setHex(alarmed ? 0xff5a4a : BADGES[view.kind]);
    }
    view.cross.visible = mapped && knownDead;
    if (view.cross.visible) {
      view.cross.position.set(e.x, 1.2, e.y);
      view.cross.scale.setScalar(0.9 * zoomScale(e.x, e.y));
    }
  }

  views.register(Blade, {
    create: (e) => {
      const tool = thrownTool(e.state.kind) ?? KUNAI;
      const mesh = new THREE.Mesh(toolGeometry(tool), SOLID);
      const glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xcfe0ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.5 }));
      glint.scale.setScalar(0.25);
      const root = new THREE.Group();
      root.add(mesh, glint);
      root.rotation.order = 'YXZ';
      scene.add(root);
      return { root, glint, t: Math.random() * 10 };
    },
    update: (view, e: BladeEntity, dt) => {
      const s = e.render;
      view.t += dt;
      view.root.visible = !captain;
      view.root.position.set(e.x, s.z * lift(), e.y);
      // stuck where it hit, point first (or lying flat where it dropped)
      view.root.rotation.set(s.pitch, -s.yaw - Math.PI / 2, 0);
      view.glint.material.opacity = 0.25 + Math.max(0, Math.sin(view.t * 3)) * 0.5;
    },
    destroy: (view) => {
      view.root.removeFromParent();
      view.glint.material.dispose();
    },
  });

  views.register(Beacon, {
    create: (e) => {
      const root = new THREE.Group();
      const offsets = [
        [0, 0],
        [2.2, 1.2],
        [-2, 1.6],
        [0.6, -2.2],
      ];
      const flames: THREE.Sprite[] = [];
      for (const [dx, dz] of offsets) {
        const b = new THREE.Mesh(brazierGeometry(), SOLID);
        b.position.set(dx, 0, dz);
        const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff9a3a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
        flame.position.set(dx, 1.5, dz);
        flame.scale.setScalar(1.4);
        flames.push(flame);
        root.add(b, flame);
      }
      const pool = lightPool(BRAZIER_REACH * 0.8, 0xffa040, 0.35);
      pool.position.y = 0.03;
      root.add(pool);
      const ring = groundRing(BRAZIER_REACH - 0.4, BRAZIER_REACH, 0xffa040);
      ring.position.y = 0.05;
      root.add(ring);
      root.position.set(e.x, 0, e.y);
      scene.add(root);
      return { root, flames, pool, ring, t: 0 };
    },
    update: (view, e: BeaconEntity, dt) => {
      view.t += dt;
      const fade = Math.min(1, e.render.left / 5);
      view.root.scale.y = lift();
      view.pool.visible = !captain;
      view.ring.visible = !!captain;
      view.ring.material.opacity = 0.4 * fade;
      view.flames.forEach((f, i) => {
        f.scale.setScalar((1.2 + Math.sin(view.t * 11 + i) * 0.15 + Math.random() * 0.1) * fade);
        if (Math.random() < dt * 5) ctx.fx.ember(e.x + f.position.x, e.y + f.position.z, 1.6 * lift());
      });
      rig.camera.getWorldPosition(camPos);
      fires.push({ x: e.x, y: e.y, z: 1.6, reach: BRAZIER_REACH * 1.4 * fade, d: Math.hypot(camPos.x - e.x, camPos.z - e.y) });
    },
    destroy: (view) => {
      view.root.removeFromParent();
      for (const f of view.flames) f.material.dispose();
      view.pool.material.dispose();
      view.ring.geometry.dispose();
      view.ring.material.dispose();
    },
  });

  // another captain's pointer
  views.register(Captain, {
    create: () => {
      const ring = groundRing(0.8, 1.05, 0x6ad0ff);
      ring.visible = false;
      scene.add(ring);
      return { ring };
    },
    update: (view, e) => {
      const s = e.render;
      view.ring.visible = !!captain && e !== ctx.captain && s.pointing;
      view.ring.position.set(s.px, 0.08, s.py);
      view.ring.scale.setScalar(zoomScale(s.px, s.py));
    },
    destroy: (view) => {
      view.ring.removeFromParent();
      view.ring.geometry.dispose();
      view.ring.material.dispose();
    },
  });

  // kunai, shuriken and arrows in flight
  const missiles: THREE.Mesh[] = [];
  const arrowGeo = arrowGeometry();
  const missileGeo = (kind: Weapon) => (kind === Weapon.Arrow ? arrowGeo : toolGeometry(kind === Weapon.Shuriken ? SHURIKEN : KUNAI));

  // the captain's pings and last sightings
  const pings = new Map<Ping, { ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; label: THREE.Sprite }>();
  const ghosts = new Map<number, { ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; mark: THREE.Sprite }>();
  const stations: THREE.Mesh[] = [];
  if (captain) {
    for (const st of ctx.castle.stations) {
      const r = groundRing(0.9, 1.1, 0xffd35a);
      r.position.set(st.x, 0.05, st.y);
      r.material.opacity = 0.35;
      scene.add(r);
      stations.push(r);
    }
  }

  function updateIntel(): void {
    if (!intel) return;
    const now = ctx.now;
    for (const p of intel.pings) {
      if (pings.has(p)) continue;
      const color = p.kind === 'body' || p.kind === 'quiet' || p.kind === 'shout' || p.kind === 'cry' ? 0xff5a4a : 0xffd24a;
      const ring = groundRing(0.8, 1, color);
      const label = textSprite(p.text, p.kind === 'steps' || p.kind === 'clatter' || p.kind === 'land' ? '#ffe08a' : '#ff9a8a');
      scene.add(ring, label);
      pings.set(p, { ring, label });
      ctx.sfx.play('ping');
    }
    for (const [p, v] of pings) {
      const age = (now - p.at) / PING_MS;
      if (age >= 1 || !intel.pings.includes(p)) {
        v.ring.removeFromParent();
        v.ring.geometry.dispose();
        v.ring.material.dispose();
        v.label.removeFromParent();
        disposeSprite(v.label);
        pings.delete(p);
        continue;
      }
      const zoom = zoomScale(p.x, p.y);
      v.ring.position.set(p.x, 0.1, p.y);
      v.ring.scale.setScalar((1 + ((age * 4) % 1) * 3) * zoom);
      v.ring.material.opacity = (1 - age) * (1 - ((age * 4) % 1)) * 0.9;
      v.label.position.set(p.x, 2.5 * zoom, p.y);
      v.label.scale.set(6.4 * zoom * 0.6, zoom * 0.6, 1);
      v.label.material.opacity = Math.min(1, (1 - age) * 2);
    }
    for (const [id, sighting] of intel.sightings) {
      let g = ghosts.get(id);
      if (!g) {
        const ring = groundRing(0.5, 0.7, 0xff3a2a);
        const mark = new THREE.Sprite(iconMaterial('?', '#ff5a4a').clone());
        mark.renderOrder = 22;
        scene.add(ring, mark);
        ghosts.set(id, (g = { ring, mark }));
      }
      const age = Math.min(1, (now - sighting.at) / SIGHTING_MS);
      const show = !sighting.seen;
      g.ring.visible = g.mark.visible = show;
      const zoom = zoomScale(sighting.x, sighting.y);
      g.ring.position.set(sighting.x, sighting.z * lift() + 0.08, sighting.y);
      g.ring.scale.setScalar(zoom);
      g.ring.material.opacity = 0.8 * (1 - age);
      g.mark.position.set(sighting.x, sighting.z * lift() + 1.4 * zoom, sighting.y);
      g.mark.scale.setScalar(0.8 * zoom);
      g.mark.material.opacity = 1 - age;
    }
    for (const [id, g] of ghosts) {
      if (intel.sightings.has(id)) continue;
      g.ring.removeFromParent();
      g.ring.geometry.dispose();
      g.ring.material.dispose();
      g.mark.removeFromParent();
      g.mark.material.dispose();
      ghosts.delete(id);
    }
    for (const s of stations) s.scale.setScalar(Math.min(2, zoomScale(s.position.x, s.position.z)));
  }

  /** On the captain's map, markers grow with distance so they stay a readable size. */
  function zoomScale(x: number, y: number): number {
    if (!captain) return 1;
    rig.camera.getWorldPosition(camPos);
    return Math.max(1, Math.hypot(camPos.x - x, camPos.y, camPos.z - y) / 26);
  }

  return {
    update: () => {
      // blades in flight
      const flying = ctx.flights.all;
      while (missiles.length < flying.length) {
        const m = new THREE.Mesh(arrowGeo, SOLID);
        m.rotation.order = 'YXZ';
        scene.add(m);
        missiles.push(m);
      }
      missiles.forEach((m, i) => {
        const f = flying[i];
        m.visible = !!f && !captain;
        if (!f) return;
        m.geometry = missileGeo(f.kind);
        m.position.set(f.x, f.z, f.y);
        const yaw = Math.atan2(f.vx, f.vy);
        const pitch = Math.atan2(f.vz, Math.hypot(f.vx, f.vy));
        if (f.kind === Weapon.Shuriken) m.rotation.set(0, f.spin, 0);
        else m.rotation.set(f.stuckAt ? pitch : pitch + (f.kind === Weapon.Kunai ? f.spin * 0.2 : 0), yaw + Math.PI, 0);
      });

      // the nearest fires get the real lights
      if (!captain) {
        rig.camera.getWorldPosition(camPos);
        for (const l of ctx.castle.lanterns) {
          const d = Math.hypot(camPos.x - l.x, camPos.z - l.y);
          if (d < 40) fires.push({ x: l.x, y: l.y, z: 1.1, reach: 8, d });
        }
        fires.sort((a, b) => a.d - b.d);
      }
      for (let i = 0; i < LIGHTS; i++) {
        const light = lights[i];
        const fire = captain ? undefined : fires[i];
        if (!fire) {
          light.intensity = 0;
          continue;
        }
        light.intensity = 5 + Math.random() * 0.6;
        light.distance = fire.reach;
        light.position.set(fire.x, fire.z, fire.y);
      }
      fires.length = 0;
      updateIntel();
    },
  };
}
