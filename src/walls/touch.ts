import * as THREE from 'three';
import { DesktopTool } from '../crossplay/desktopTool';
import { stillIntent, type Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FIRE, TOUCH_TUNING } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import { direction, type Vec3, type WallsContext } from './context';
import { lowerTool } from './desktop';
import { idleWallsIntent, type WallsIntent } from './intent';
import { TOOLS } from './kit';
import type { Painter, PainterFrontend } from './painter';

const BUTTONS: TouchButtonSpec[] = [
  { id: 'draw', label: 'DRAW', hint: 'with a finger', big: true },
  { id: FIRE, label: 'SPRAY', hint: 'at the dot' },
  { id: 'size', label: 'SIZE' },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
];

const tapNdc = new THREE.Vector3();
const tapFrom = new THREE.Vector3();

/**
 * A phone or tablet. The left thumb walks and the right drags the view, the same as the desktop's first person.
 * Painting is touching the wall: turn DRAW on and a finger on the screen paints wherever it is, so you draw on
 * the wall the way you'd draw on the phone. Turn it off to look around again. SPRAY paints through the dot in
 * the middle while it's held, for painting and turning at once. The colours are the strip along the bottom
 * and the tools are up the right.
 */
export class TouchPainter implements PainterFrontend {
  readonly platform = Platform.Touch;
  readonly showSelf = false;
  private readonly intent = idleWallsIntent();
  private readonly controls: TouchControls;
  private readonly held: DesktopTool;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly aim: Vec3 = { x: 1, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private drawing = false;
  /** A swatch tapped between frames, for the next `read`. */
  private picked: number | null = null;

  constructor(
    private readonly ctx: WallsContext,
    private readonly sim: Painter,
    private readonly rig: Rig,
    chips: { menu: () => void; mic: () => void },
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.controls = new TouchControls({
      buttons: BUTTONS,
      onChip: (id) => (id === 'menu' ? chips.menu() : chips.mic()),
      tuning: { ...TOUCH_TUNING, tapToFire: false },
    });
    ctx.hud.onPick = (i) => (this.picked = i);
    ctx.hud.message('Turn DRAW on and paint on the wall with your finger. Left thumb walks, right thumb looks.');
  }

  dispose(): void {
    this.controls.dispose();
    this.held.dispose();
    this.ctx.hud.onPick = null;
  }

  /** Every press is read here, in one place, because `read` ends the input's frame. */
  read(): WallsIntent {
    const { controls, intent, sim } = this;
    const t = controls.input;
    stillIntent(intent);
    Object.assign(intent, { cycleColor: 0, cycleSize: 0 });
    intent.color = this.picked;
    this.picked = null;
    if (this.ctx.settings.open) {
      t.endFrame();
      return intent;
    }
    if (t.pressed('draw')) {
      this.drawing = !this.drawing;
      this.ctx.sfx.play('click');
    }
    const [dx, dy] = t.consumeLook();
    const finger = t.lookFinger;
    if (this.drawing) {
      if (finger) {
        intent.aim = this.screenAim(finger.x, finger.y);
        intent.trigger = true;
      }
    } else {
      intent.turn = dx * TOUCH_TUNING.look;
      intent.lookUp = -dy * TOUCH_TUNING.look;
    }
    intent.strafe = t.stick.x;
    intent.forward = t.stick.y;
    intent.run = t.run;
    intent.trigger ||= t.down(FIRE);
    if (t.pressed('size')) intent.cycleSize = 1;
    TOOLS.all.forEach((tool, i) => {
      if (t.pressed(`slot${i}`)) intent.selectTool = tool;
    });
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    t.endFrame();
    return intent;
  }

  /** The way into the scene through a point on the screen, from the camera the last frame was drawn with. */
  private screenAim(x: number, y: number): Vec3 {
    const cam = this.rig.camera;
    cam.updateWorldMatrix(true, false);
    tapNdc.set((x / window.innerWidth) * 2 - 1, 1 - (y / window.innerHeight) * 2, 0.5).unproject(cam);
    cam.getWorldPosition(tapFrom);
    tapNdc.sub(tapFrom).normalize();
    // the scene's y is the world's z
    return Object.assign(this.aim, { x: tapNdc.x, y: tapNdc.z, z: tapNdc.y });
  }

  present(dt: number): void {
    const { ctx, rig, sim, controls } = this;
    if (!sim.me) return;
    const e = sim.eyePosition(this.tmp);
    rig.setDesktopView(e.x, e.y, e.z, sim.heading, sim.pitch);
    this.held.setTool(sim.inventory.current);
    this.held.update(dt, true);
    lowerTool(this.held);
    ctx.sfx.setListener(rig.head(this.tmp), direction(sim.heading, sim.pitch, this.dir));
    ctx.hud.showPainter(ctx, sim, '');

    controls.setActive(!ctx.settings.open);
    controls.setLabel('draw', this.drawing ? 'LOOK' : 'DRAW', this.drawing ? 'drag to look' : 'with a finger');
    controls.setLabel('size', sim.sizeName().split(' ')[0].toUpperCase());
    controls.setSlots(TOOLS.all.map((tool) => ({ name: tool.name, charges: Infinity, current: sim.tool === tool })));
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    navigator.vibrate?.(10);
  }

  died(): void {}
}
