import * as THREE from 'three';
import type { DesktopInput } from '../crossplay/input';
import { OverheadView, pageViewport, type OverheadLimits, type Viewport } from '../crossplay/overhead';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { HauntContext } from './context';
import { MonsterKind } from './defs';
import { POWERS, WHISPER_RADIUS, type HauntFrontend, type HauntRole } from './haunt';
import type { HauntKeys } from './hud';
import { Power, idleHauntIntent, stillHaunt, type HauntIntent } from './intent';
import { FENCE_MAX, FENCE_MIN, START } from './manor';
import { MONSTERS, summonRefusal } from './monsters';
import { groundRing } from './models';

const KEYS: HauntKeys = {
  place: 'Click where it should come through, right-click to put it away',
  pick: 'Click or drag round your monsters to pick them out',
  send: 'Right-click',
  bar: '<b>1-4</b> powers · <b>Click</b> summon / pick out · <b>Drag</b> pick out many · <b>Right-click</b> send · <b>Space</b> all · <b>G</b> gather · <b>WASD</b> or <b>right-drag</b> move · <b>Wheel</b> zoom · <b>Q E</b> turn · <b>Esc</b> settings',
};

/** Where an overhead Haunt can look, and how close. */
export const HAUNT_VIEW: OverheadLimits = { minX: FENCE_MIN, minY: FENCE_MIN, maxX: FENCE_MAX, maxY: FENCE_MAX, near: 10, far: 95, tiltNear: 0.55, tiltFar: 0.3 };

/** How far a drag goes, in pixels, before it's a drag rather than a click. */
const CLICK_SLOP = 6;
/** How long a refusal stays in the hint, ms. */
const REFUSAL_MS = 1800;

/**
 * The Haunt on keyboard and mouse: a free pointer over the house seen from above, the way strategy games play. Pick a
 * power with 1-4 or a card and click to use it; click your monsters (or drag a box round them) to pick them out, and
 * right-click to send them. WASD or a right-drag moves the view, the wheel zooms and Q and E turn it.
 */
export class DesktopHaunt implements HauntFrontend {
  readonly platform = Platform.Desktop;
  readonly cursor = true;
  readonly view = new OverheadView(HAUNT_VIEW, { x: START.x, y: START.y + 26, distance: 60, heading: Math.PI / 2 });
  private readonly intent = idleHauntIntent();
  private readonly marker: HauntMarker;
  private readonly box = document.getElementById('select-box') as HTMLElement | null;
  private left: { x: number; y: number; dragging: boolean } | null = null;
  private right: { x: number; y: number; moved: number } | null = null;
  private arm: Power | 'none' | null = null;
  private refusal = { text: '', until: 0 };

  constructor(
    private readonly ctx: HauntContext,
    private readonly role: HauntRole,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
    scene: THREE.Scene,
  ) {
    rig.setMode('desktop');
    this.marker = new HauntMarker(ctx, scene);
    ctx.hud.onPower = (p) => (this.arm = p);
  }

  dispose(): void {
    this.marker.dispose();
    this.ctx.hud.onPower = null;
    if (this.box) this.box.hidden = true;
  }

  read(dt: number): HauntIntent {
    const { input: k, intent, view } = this;
    const vp = pageViewport(this.rig.camera.fov);
    stillHaunt(intent);
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

    // moving the view
    const key = (code: string) => (k.down(code) ? 1 : 0);
    const speed = view.distance * 0.9 * dt * (k.down('ShiftLeft') ? 2 : 1);
    view.pan((key('KeyD') + key('ArrowRight') - key('KeyA') - key('ArrowLeft')) * speed, (key('KeyW') + key('ArrowUp') - key('KeyS') - key('ArrowDown')) * speed);
    const turn = key('KeyE') - key('KeyQ');
    if (turn) view.turn(turn * 1.4 * dt, vp.width / 2, vp.height / 2, vp);
    const wheel = k.wheel();
    if (wheel) view.zoom(1.15 ** wheel, px, py, vp);

    // the right button drags the ground, or clicks to send
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

    // the left button clicks, or drags a box round monsters to pick them out
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

    for (let i = 0; i < 4; i++) if (k.pressed(`Digit${i + 1}`)) intent.arm = i as Power;
    intent.selectAll = k.pressed('Space');
    intent.gather = k.pressed('KeyG');
    return intent;
  }

  /** Your monsters inside a box dragged on the screen. */
  private boxed(x0: number, y0: number, x1: number, y1: number, vp: Viewport): number[] {
    const ids: number[] = [];
    const lx = Math.min(x0, x1);
    const hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1);
    const hy = Math.max(y0, y1);
    for (const m of this.role.mine()) {
      const p = this.view.toScreen({ x: m.x, y: m.y, z: 0.8 }, vp);
      if (p && p.x >= lx && p.x <= hx && p.y >= ly && p.y <= hy) ids.push(m.id);
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
    listenAt(ctx, view.x, view.y, view.heading);
    ctx.hud.showHaunt(ctx, role, KEYS, ctx.now < this.refusal.until ? this.refusal.text : '');
  }

  used(power: Power): void {
    hauntUsed(this.ctx, power);
  }

  refused(reason: string): void {
    this.refusal = { text: reason, until: this.ctx.now + REFUSAL_MS };
    this.ctx.sfx.play('nope');
  }

  ordered(x: number, y: number, attack: boolean): void {
    this.marker.ping(x, y, attack);
  }

  glared(by: string): void {
    hauntGlared(this.ctx, this.rig, by);
  }
}

/** The Haunt hears what's going on where it's looking. */
export function listenAt(ctx: HauntContext, x: number, y: number, heading: number): void {
  ctx.sfx.setListener({ x, y, z: 1.7 }, { x: Math.cos(heading), y: Math.sin(heading), z: 0 });
}

export function hauntUsed(ctx: HauntContext, power: Power): void {
  if (power === Power.Whisper) ctx.hud.message('You whisper, and your monsters come.');
}

export function hauntGlared(ctx: HauntContext, rig: Rig, by: string): void {
  rig.flash(0xffffff, 0.85);
  rig.shake(0.4);
  ctx.hud.showBanner('THE LIGHT!', '#fff4c0', 1800);
  ctx.hud.message(`${by} drove you back with their light`);
  ctx.sfx.play('glare');
}

/**
 * What the Haunt sees under its pointer: a ring on the ground, purple where a power can be used, red where it can't
 * (and why is in the hint), and pale with nothing armed. Orders leave a fading ping where they were sent.
 */
export class HauntMarker {
  private readonly ring = groundRing(0.75, 1, 0xffffff);
  private readonly pings: { mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; age: number }[] = [];
  private nextCheck = 0;
  private ok = true;

  constructor(
    private readonly ctx: HauntContext,
    private readonly scene: THREE.Scene,
  ) {
    scene.add(this.ring);
  }

  /** `scale`: how much bigger to draw the ring, so it reads from far off. */
  update(pointer: { x: number; y: number } | null, role: HauntRole, scale = 1): void {
    const { ctx } = this;
    this.ring.visible = !!pointer;
    if (pointer) {
      const armed = role.armed;
      if (armed !== null && armed !== Power.Whisper && ctx.now >= this.nextCheck) {
        this.nextCheck = ctx.now + 100;
        this.ok = !summonRefusal(ctx, pointer.x, pointer.y, MONSTERS[armed as number as MonsterKind].radius);
      }
      const short = armed !== null && POWERS[armed].cost > role.dread;
      const color = armed === null ? 0xd8d0f0 : armed === Power.Whisper ? 0x8fb0ff : this.ok && !short ? 0xb46bff : 0xff4a3a;
      const size = armed === Power.Whisper ? WHISPER_RADIUS : (armed === null ? 0.8 : 1) * scale;
      this.ring.material.color.setHex(color);
      this.ring.position.set(pointer.x, 0.08, pointer.y);
      this.ring.scale.setScalar(size);
      this.ring.material.opacity = armed === Power.Whisper ? 0.35 : 0.85;
    }
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      p.age += 1 / 60;
      p.mesh.scale.setScalar(1 + p.age * 2);
      p.mesh.material.opacity = Math.max(0, 0.9 - p.age * 1.2);
      if (p.age > 0.8) {
        p.mesh.removeFromParent();
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this.pings.splice(i, 1);
      }
    }
  }

  ping(x: number, y: number, attack: boolean): void {
    const mesh = groundRing(0.5, 0.7, attack ? 0xff4a3a : 0xb46bff);
    mesh.position.set(x, 0.09, y);
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
