import * as THREE from 'three';
import type { DesktopInput } from '../crossplay/input';
import { OverheadView, pageViewport, type OverheadLimits, type Viewport } from '../crossplay/overhead';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import { BRAZIER_REACH } from './shinobi';
import type { CaptainFrontend, CaptainRole } from './captain';
import { WALL } from './castle';
import type { ShinobiContext } from './context';
import { OrderKind } from './defs';
import type { CaptainKeys } from './hud';
import { Call, idleCaptainIntent, stillCaptain, type CaptainIntent } from './intent';
import { groundRing } from './models';

const KEYS: CaptainKeys = {
  place: 'Click where',
  pick: 'Click or drag round your guards to pick them out',
  send: 'Right-click',
  bar: '<b>1-4</b> calls · <b>Click</b> pick out / call · <b>Drag</b> pick out many · <b>Right-click</b> search there · <b>H</b> stand watch there · <b>R</b> back to rounds · <b>Space</b> all · <b>G</b> gather · <b>WASD</b>/<b>right-drag</b> move · <b>Wheel</b> zoom · <b>Q E</b> turn · <b>Esc</b> settings',
};

/** Where the captain's map can look, and how close. */
export const CAPTAIN_VIEW: OverheadLimits = { minX: WALL.x0 - 4, minY: WALL.y0 - 6, maxX: WALL.x1 + 4, maxY: WALL.y1 + 4, near: 12, far: 110, tiltNear: 0.55, tiltFar: 0.2 };
export const CAPTAIN_START = { x: 48, y: 44, distance: 90, heading: Math.PI / 2 };

const CLICK_SLOP = 6;
const REFUSAL_MS = 1800;

/**
 * The captain on keyboard and mouse: a free pointer over the map of the castle, the way strategy games play. Click your
 * guards (or drag a box round them) to pick them out, right-click to send them searching, H to have them stand watch
 * where you point and R to send them back to their rounds. 1-4 or a card arms a call, and a click makes it.
 */
export class DesktopCaptain implements CaptainFrontend {
  readonly platform = Platform.Desktop;
  readonly cursor = true;
  readonly view = new OverheadView(CAPTAIN_VIEW, CAPTAIN_START);
  private readonly intent = idleCaptainIntent();
  private readonly marker: CaptainMarker;
  private readonly box = document.getElementById('select-box') as HTMLElement | null;
  private left: { x: number; y: number; dragging: boolean } | null = null;
  private right: { x: number; y: number; moved: number } | null = null;
  private arm: Call | 'none' | null = null;
  private refusal = { text: '', until: 0 };

  constructor(
    private readonly ctx: ShinobiContext,
    private readonly role: CaptainRole,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
    scene: THREE.Scene,
  ) {
    rig.setMode('desktop');
    this.marker = new CaptainMarker(ctx, scene);
    ctx.hud.onCall = (c) => (this.arm = c);
  }

  dispose(): void {
    this.marker.dispose();
    this.ctx.hud.onCall = null;
    if (this.box) this.box.hidden = true;
  }

  read(dt: number): CaptainIntent {
    const { input: k, intent, view } = this;
    const vp = pageViewport(this.rig.camera.fov);
    stillCaptain(intent);
    const [mdx, mdy] = k.consumeMouse();
    if (this.arm !== null) {
      intent.arm = this.arm;
      this.arm = null;
    }
    if (this.ctx.settings.open) {
      this.left = this.right = null;
      return intent;
    }
    const px = k.pointer.x;
    const py = k.pointer.y;

    const key = (code: string) => (k.down(code) ? 1 : 0);
    const speed = view.distance * 0.9 * dt * (k.down('ShiftLeft') ? 2 : 1);
    view.pan((key('KeyD') + key('ArrowRight') - key('KeyA') - key('ArrowLeft')) * speed, (key('KeyW') + key('ArrowUp') - key('KeyS') - key('ArrowDown')) * speed);
    const turn = key('KeyE') - key('KeyQ');
    if (turn) view.turn(turn * 1.4 * dt, vp.width / 2, vp.height / 2, vp);
    const wheel = k.wheel();
    if (wheel) view.zoom(1.15 ** wheel, px, py, vp);

    if (k.pressed('Mouse2')) this.right = { ...k.downAt(2), moved: 0 };
    if (this.right) {
      if (k.mouse(2)) {
        this.right.moved += Math.hypot(mdx, mdy);
        if (this.right.moved > CLICK_SLOP) view.drag(px - mdx, py - mdy, px, py, vp);
      } else {
        if (this.right.moved <= CLICK_SLOP) intent.secondary = true;
        this.right = null;
      }
    }

    intent.focus.x = view.x;
    intent.focus.y = view.y;
    const ground = k.pointer.inside ? view.groundAt(px, py, vp) : null;
    intent.pointer = ground ? { x: ground.x, y: ground.y } : null;
    intent.reach = Math.max(1.2, view.distance * 0.028);

    if (k.pressed('Mouse0')) this.left = { ...k.downAt(0), dragging: false };
    if (this.left) {
      if (Math.hypot(px - this.left.x, py - this.left.y) > CLICK_SLOP) this.left.dragging = true;
      if (!k.mouse(0)) {
        if (this.left.dragging) intent.select = { ids: this.boxed(this.left.x, this.left.y, px, py, vp), add: k.down('ShiftLeft') };
        else intent.primary = true;
        this.left = null;
      }
    }
    this.drawBox(px, py);

    for (let i = 0; i < 4; i++) if (k.pressed(`Digit${i + 1}`)) intent.arm = i as Call;
    intent.selectAll = k.pressed('Space');
    intent.gather = k.pressed('KeyG');
    intent.post = k.pressed('KeyH');
    intent.dismiss = k.pressed('KeyR');
    return intent;
  }

  private boxed(x0: number, y0: number, x1: number, y1: number, vp: Viewport): number[] {
    const ids: number[] = [];
    const lx = Math.min(x0, x1);
    const hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1);
    const hy = Math.max(y0, y1);
    for (const g of this.role.guards()) {
      const p = this.view.toScreen({ x: g.x, y: g.y, z: 0.8 }, vp);
      if (p && p.x >= lx && p.x <= hx && p.y >= ly && p.y <= hy) ids.push(g.id);
    }
    return ids;
  }

  private drawBox(px: number, py: number): void {
    const el = this.box;
    if (!el) return;
    const l = this.left;
    el.hidden = !l?.dragging;
    if (!l?.dragging) return;
    el.style.left = `${Math.min(l.x, px)}px`;
    el.style.top = `${Math.min(l.y, py)}px`;
    el.style.width = `${Math.abs(px - l.x)}px`;
    el.style.height = `${Math.abs(py - l.y)}px`;
  }

  present(): void {
    const { ctx, role, view } = this;
    view.apply(this.rig);
    this.marker.update(this.intent.pointer, role, Math.max(1, view.distance / 30));
    listenOverMap(ctx);
    ctx.hud.showCaptain(ctx, role, KEYS, ctx.now < this.refusal.until ? this.refusal.text : '');
  }

  used(call: Call): void {
    captainUsed(this.ctx, call);
  }

  refused(reason: string): void {
    this.refusal = { text: reason, until: this.ctx.now + REFUSAL_MS };
    this.ctx.sfx.play('nope');
  }

  ordered(x: number, y: number, kind: OrderKind): void {
    this.marker.ping(x, y, kind);
  }
}

/**
 * The captain hears only what their guards report: the listener sits high over the castle, out of earshot of everything
 * in it, so only the bell, the gong and the map's own sounds reach it.
 */
export function listenOverMap(ctx: ShinobiContext): void {
  ctx.sfx.setListener({ x: 48, y: 48, z: 400 }, { x: 0, y: 1, z: 0 });
}

export function captainUsed(ctx: ShinobiContext, call: Call): void {
  ctx.sfx.play(call === Call.Bell ? 'arm' : 'order');
  ctx.hud.message(
    call === Call.Braziers ? 'Braziers are lit.' : call === Call.Bell ? 'You ring the alarm bell.' : call === Call.Reinforce ? 'Two more guards turn out of the barracks.' : 'The lord is moved.',
  );
}

/**
 * What's under the captain's pointer: a ring on the ground, the size of the braziers' light when they're armed, and a
 * fading ping where guards were sent.
 */
export class CaptainMarker {
  private readonly ring = groundRing(0.75, 1, 0xffffff);
  private readonly pings: { mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; age: number }[] = [];

  constructor(
    private readonly ctx: ShinobiContext,
    private readonly scene: THREE.Scene,
  ) {
    scene.add(this.ring);
  }

  update(pointer: { x: number; y: number } | null, role: CaptainRole, scale = 1): void {
    this.ring.visible = !!pointer;
    if (pointer) {
      const armed = role.armed;
      const cooling = armed !== null && role.cooling(armed) > 0;
      const color = armed === null ? (role.selected.size ? 0x6ad0ff : 0xd8e0f0) : cooling ? 0xff4a3a : armed === Call.Braziers ? 0xffa040 : 0xffd35a;
      const size = armed === Call.Braziers ? BRAZIER_REACH : scale;
      this.ring.material.color.setHex(color);
      this.ring.position.set(pointer.x, 0.09, pointer.y);
      this.ring.scale.setScalar(size);
      this.ring.material.opacity = armed === Call.Braziers ? 0.4 : 0.85;
    }
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      p.age += 1 / 60;
      p.mesh.scale.setScalar((1 + p.age * 2) * scale);
      p.mesh.material.opacity = Math.max(0, 0.9 - p.age * 1.2);
      if (p.age > 0.8) {
        p.mesh.removeFromParent();
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this.pings.splice(i, 1);
      }
    }
  }

  ping(x: number, y: number, kind: OrderKind): void {
    const mesh = groundRing(0.5, 0.7, kind === OrderKind.Post ? 0xffd35a : kind === OrderKind.Return ? 0xa0a8b8 : 0x6ad0ff);
    mesh.position.set(x, 0.1, y);
    this.scene.add(mesh);
    this.pings.push({ mesh, age: 0 });
    this.ctx.sfx.play('order');
  }

  dispose(): void {
    this.ring.removeFromParent();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    for (const p of this.pings) p.mesh.removeFromParent();
    this.pings.length = 0;
  }
}
