import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { bodyView, poseBody, type BodyView } from '../crossplay/avatarView';
import { direction } from '../crossplay/math';
import { disposeLabel, setLabel } from '../crossplay/models';
import { painterRig } from './models';
import type { WallsContext } from './context';
import { Painter } from './defs';
import type { PaintAim, PaintTool } from './kit';
import type { Painter as PainterRole } from './painter';
import { Brush, PX_PER_M, type Surface } from './wall';
import { swatchAt } from './yard';

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own painter, e.g. from a chase camera. */
  showSelf(): boolean;
}

interface PainterView extends BodyView {
  name: string;
  /** Seconds to the next puff of mist and hiss, per hand. */
  puff: [number, number];
}

const v = { x: 0, y: 0, z: 0 };
const dir = { x: 0, y: 0, z: 0 };

export function registerViews(ctx: WallsContext, views: EntityViews, scene: THREE.Scene, local: LocalView, painter: PainterRole): { update(dt: number): void } {
  views.register(Painter, {
    create: (e): PainterView => {
      const rig = painterRig(e.state.skin);
      scene.add(rig.root);
      return { ...bodyView(rig, e.x, e.y), name: '', puff: [0, 0] };
    },
    update: (view, e, dt) => {
      const s = e.render;
      const r = view.rig;
      const isMe = e === ctx.me;
      if (view.name !== s.name) {
        view.name = s.name;
        setLabel(r.label, s.name);
      }
      r.root.visible = !isMe || local.showSelf();
      r.label.visible = !isMe;
      r.root.position.set(e.x, s.z, e.y);
      r.shadow.position.y = 0.04 - s.z;
      poseBody(view, s, e.x, e.y, dt, painter.inventory.tools);

      // paint mist out of a spraying can, from where that hand is and the way it points
      const hands = [
        { on: s.spraying, x: s.hx, y: s.hy, z: s.hz, yaw: s.aimYaw, pitch: s.aimPitch },
        { on: s.lspraying, x: s.lhx, y: s.lhy, z: s.lhz, yaw: s.laimYaw, pitch: s.laimPitch },
      ];
      hands.forEach((h, i) => {
        if (!h.on) {
          view.puff[i] = 0;
          return;
        }
        view.puff[i] -= dt;
        if (view.puff[i] > 0) return;
        view.puff[i] = 0.03;
        direction(h.yaw, h.pitch, dir);
        v.x = e.x + h.x + dir.x * 0.06;
        v.y = e.y + h.y + dir.y * 0.06;
        v.z = s.z + h.z + 0.1;
        ctx.fx.spray(v.x, v.y, v.z, dir.x, dir.y, dir.z, s.color);
        if (Math.random() < 0.45) ctx.sfx.play('hiss', v, isMe ? 0.6 : 1);
      });
    },
    destroy: (view) => {
      scene.remove(view.rig.root);
      disposeLabel(view.rig.label);
    },
  });

  const walls = new WallViews(scene, ctx.surfaces);
  const reticles = [new Reticle(scene), new Reticle(scene)];
  const swatchFrame = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.235, 4, 1).rotateZ(Math.PI / 4), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  scene.add(swatchFrame);
  const noises = [0, 0];

  return {
    update: (dt) => {
      walls.update();
      let swatch: number | null = null;
      painter.aims.forEach((aim, i) => {
        reticles[i].show(aim, ctx.surfaces, painter.color);
        if (aim.swatch !== null) swatch = aim.swatch;
        // the marker squeaks and the roller rumbles while they're moving on the wall
        noises[i] -= dt;
        if (aim.painting && aim.hit && noises[i] <= 0) {
          noises[i] = 0.09;
          const brush = (painter.hand(i).tool as PaintTool | null)?.spec.brush;
          ctx.surfaces[aim.hit.surface].toWorld(aim.hit.px, aim.hit.py, 0, v);
          if (brush === Brush.Marker) ctx.sfx.play('squeak', v, 0.7);
          else if (brush === Brush.Roller) ctx.sfx.play('roll', v, 0.7);
        }
      });
      swatchFrame.visible = swatch !== null;
      if (swatch !== null) {
        const c = swatchAt(swatch);
        swatchFrame.position.set(c.x, c.z, c.y + 0.03);
      }
      ctx.fx.update(dt);
    },
  };
}

/** The walls' paint: a textured quad per tile, re-uploaded only when that tile changes. */
class WallViews {
  private readonly tiles: { surface: Surface; textures: THREE.DataTexture[] }[] = [];
  private readonly dirty: number[] = [];

  constructor(scene: THREE.Scene, surfaces: readonly Surface[]) {
    for (const surface of surfaces) {
      const textures: THREE.DataTexture[] = [];
      const basis = faceBasis(surface);
      for (let t = 0; t < surface.tileCount; t++) {
        const r = surface.tileRect(t);
        const tex = new THREE.DataTexture(new Uint8Array(r.w * r.h * 4), r.w, r.h, THREE.RGBAFormat);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = 4;
        textures.push(tex);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(r.w / PX_PER_M, r.h / PX_PER_M), new THREE.MeshLambertMaterial({ map: tex }));
        const c = surface.toWorld(r.x + r.w / 2, r.y + r.h / 2, 0.004, v);
        mesh.position.set(c.x, c.z, c.y);
        mesh.quaternion.setFromRotationMatrix(basis);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        scene.add(mesh);
      }
      this.tiles.push({ surface, textures });
    }
  }

  update(): void {
    for (const { surface, textures } of this.tiles) {
      for (const t of surface.takeDirty(this.dirty)) {
        const r = surface.tileRect(t);
        const tex = textures[t];
        const out = tex.image.data as Uint8Array;
        for (let y = 0; y < r.h; y++) {
          const from = ((r.y + y) * surface.w + r.x) * 4;
          out.set(surface.data.subarray(from, from + r.w * 4), y * r.w * 4);
        }
        tex.needsUpdate = true;
      }
    }
  }
}

/** A wall face's axes in the scene: right along it, up, and out of it. */
function faceBasis(s: Surface): THREE.Matrix4 {
  const u = new THREE.Vector3(s.ux, 0, s.uy);
  const n = new THREE.Vector3(s.spec.nx, 0, s.spec.ny);
  return new THREE.Matrix4().makeBasis(u, new THREE.Vector3(0, 1, 0), n);
}

/** Where a tool would paint: a ring the size of the brush in the paint's colour, faint when it's out of reach. */
class Reticle {
  private readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly bases = new Map<number, THREE.Matrix4>();

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 32), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false }));
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  show(aim: PaintAim, surfaces: readonly Surface[], rgb: number): void {
    const hit = aim.hit;
    this.mesh.visible = !!hit;
    if (!hit) return;
    const s = surfaces[hit.surface];
    let basis = this.bases.get(hit.surface);
    if (!basis) this.bases.set(hit.surface, (basis = faceBasis(s)));
    s.toWorld(hit.px, hit.py, 0.012, v);
    this.mesh.position.set(v.x, v.z, v.y);
    this.mesh.quaternion.setFromRotationMatrix(basis);
    this.mesh.scale.setScalar(Math.max(0.012, aim.radius));
    const m = this.mesh.material;
    m.color.setHex(rgb);
    m.opacity = aim.inReach ? (aim.painting ? 0.25 : 0.85) : 0.3;
  }
}
