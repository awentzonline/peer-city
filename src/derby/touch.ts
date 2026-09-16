import * as THREE from 'three';
import { DesktopTool } from '../crossplay/desktopTool';
import type { Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import { Tilt } from '../crossplay/tilt';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FIRE, TOUCH_TUNING } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import type { Builder, BuilderFrontend } from './builder';
import { ChaseCamera } from './chase';
import { clamp, direction, type DerbyContext, type Vec3 } from './context';
import { RacerMode } from './defs';
import { GiveUp, countdownBanner, finishBanner, raceSounds } from './desktop';
import { idleDerbyIntent, type DerbyIntent } from './intent';
import { PART_GUN, WRENCH } from './kit';
import { PARTS, PLACEABLE } from './parts';

/** Radians of view per pixel dragged; a touch drag covers much less screen than a mouse can. */
const LOOK = 0.0042;

const BUTTONS: TouchButtonSpec[] = [
  // building
  { id: FIRE, label: 'STICK', big: true },
  { id: 'ready', label: 'READY' },
  { id: 'jump', label: 'JUMP' },
  // racing
  { id: 'boost', label: 'ROCKETS', big: true, hidden: true },
  { id: 'brake', label: 'BRAKE', hidden: true },
  { id: 'push', label: 'PUSH', hidden: true },
  { id: 'reset', label: 'RESET', hint: 'checkpoint', hidden: true },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
  { id: 'cam', label: 'CAM', kind: 'chip', hidden: true },
  { id: 'tilt', label: 'TILT', kind: 'chip', hidden: true },
  { id: 'quit', label: 'QUIT', kind: 'chip', hidden: true },
];

const tapNdc = new THREE.Vector3();
const tapFrom = new THREE.Vector3();

/**
 * A phone or tablet. In the garage it's first person like the desktop, but you build by touching the racer:
 * tap a face of any part and the loaded part sticks on there (or the wrench takes that part off), so aiming is
 * pointing at the screen rather than steering a crosshair onto it. The left thumb walks, the right drags the
 * view, and STICK uses the tool through the crosshair for when a fingertip is too blunt. The strip of parts
 * up the right edge is the number keys.
 *
 * Racing, it's a chase camera and a thumb on the left steers: slide it left and right from wherever it lands.
 * Or turn TILT on and steer by turning the phone like a wheel. ROCKETS, BRAKE and PUSH are held by the right
 * thumb, and dragging the view looks round the racer.
 */
export class TouchBuilder implements BuilderFrontend {
  readonly platform = Platform.Touch;
  private readonly intent = idleDerbyIntent();
  private readonly controls: TouchControls;
  private readonly held: DesktopTool;
  private readonly chase: ChaseCamera;
  private readonly tilt = new Tilt();
  private readonly giveUp = new GiveUp();
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly aim: Vec3 = { x: 1, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  /** Chip taps, which come as clicks between frames, for the next `read`. */
  private wantsQuit = false;
  private nextRumble = 0;

  constructor(
    private readonly ctx: DerbyContext,
    private readonly sim: Builder,
    private readonly rig: Rig,
    private readonly chips: { menu: () => void; mic: () => void },
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.chase = new ChaseCamera(ctx, sim, rig);
    this.controls = new TouchControls({ buttons: BUTTONS, onChip: (id) => this.chip(id), tuning: { ...TOUCH_TUNING, stickTaps: true } });
    ctx.hud.message('Tap a racer to stick the part on where you tapped. Left thumb walks, right thumb looks.');
  }

  get showSelf(): boolean {
    return false;
  }

  get showDriver(): boolean {
    return !this.chase.firstPerson;
  }

  dispose(): void {
    this.controls.dispose();
    this.held.dispose();
    this.tilt.disable();
  }

  private chip(id: string): void {
    const { ctx } = this;
    if (id === 'menu') this.chips.menu();
    else if (id === 'mic') this.chips.mic();
    else if (id === 'cam') this.chase.firstPerson = !this.chase.firstPerson;
    else if (id === 'quit') this.wantsQuit = true;
    else if (id === 'tilt') {
      if (this.tilt.on) {
        this.tilt.disable();
        ctx.hud.message('Tilt off: steer with your left thumb');
        return;
      }
      // enable() asks for permission on iOS, which only works straight from the tap
      void this.tilt.enable().then((ok) => ctx.hud.message(ok ? 'Tilt on: turn your phone like a wheel to steer' : "Couldn't read this device's tilt"));
    }
  }

  /** Every press is read here, in one place, because `read` ends the input's frame. */
  read(): DerbyIntent {
    const { controls, intent, sim } = this;
    const t = controls.input;
    Object.assign(intent, { turn: 0, lookUp: 0, strafe: 0, forward: 0, run: false, crouch: false, jump: false, trigger: false, aim: null, steer: 0, brake: false, push: false, boost: false, reset: false, quit: false, ready: false });
    intent.part = null;
    intent.cyclePart = 0;
    intent.selectTool = null;
    intent.cycleTool = 0;
    const quit = this.wantsQuit;
    this.wantsQuit = false;
    if (this.ctx.settings.open) {
      t.endFrame();
      return intent;
    }
    const [dx, dy] = t.consumeLook();

    if (sim.seated) {
      intent.steer = clamp(-t.stick.x + this.tilt.steer(), -1, 1);
      intent.boost = t.down('boost');
      intent.brake = t.down('brake');
      intent.push = t.down('push');
      intent.reset = t.pressed('reset');
      intent.quit = quit && this.giveUp.press(this.ctx, 'QUIT');
      this.chase.look(dx * LOOK, -dy * LOOK);
      t.endFrame();
      return intent;
    }

    intent.turn = dx * LOOK;
    intent.lookUp = -dy * LOOK;
    intent.strafe = t.stick.x;
    intent.forward = t.stick.y;
    intent.run = t.run;
    intent.jump = t.pressed('jump');
    intent.ready = t.pressed('ready');
    // A tap builds where it touched; STICK, held, uses the crosshair.
    if (t.tapAt) intent.aim = this.tapAim(t.tapAt.x, t.tapAt.y);
    intent.trigger = t.down(FIRE) || t.pressed(FIRE);
    for (let i = 0; i < PLACEABLE.length; i++) {
      if (!t.pressed(`slot${i}`)) continue;
      intent.part = PLACEABLE[i];
      intent.selectTool = PART_GUN;
    }
    if (t.pressed(`slot${PLACEABLE.length}`)) intent.selectTool = WRENCH;
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    t.endFrame();
    return intent;
  }

  /** The way into the scene through a point on the screen, from the camera the last frame was drawn with. */
  private tapAim(x: number, y: number): Vec3 {
    const cam = this.rig.camera;
    cam.updateWorldMatrix(true, false);
    tapNdc.set((x / window.innerWidth) * 2 - 1, 1 - (y / window.innerHeight) * 2, 0.5).unproject(cam);
    cam.getWorldPosition(tapFrom);
    tapNdc.sub(tapFrom).normalize();
    // the scene's y is the world's z
    return Object.assign(this.aim, { x: tapNdc.x, y: tapNdc.z, z: tapNdc.y });
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    const s = sim.me?.state;
    if (!s) return;
    if (sim.seated && ctx.racer) {
      this.chase.update(dt);
      this.held.update(dt, false);
    } else {
      this.chase.reset();
      const e = sim.eyePosition(this.tmp);
      rig.setDesktopView(e.x, e.y, e.z, sim.heading, sim.pitch);
      this.held.setTool(sim.inventory.current);
      this.held.update(dt, true);
      ctx.sfx.setListener(rig.head(this.tmp), direction(sim.heading, sim.pitch, this.dir));
    }
    ctx.hud.showBuilder(ctx, sim, { ready: ctx.racer?.state.ready ? 'Tap NOT READY' : 'Tap READY', parts: '', help: '' });
    this.showControls();
    if (ctx.racer?.state.mode === RacerMode.Racing && ctx.now >= this.nextRumble) {
      this.nextRumble = ctx.now + 110;
      raceSounds(ctx);
    }
  }

  /** The buttons are the ones that do something now: building ones in the garage, driving ones in the seat. */
  private showControls(): void {
    const { controls, ctx, sim } = this;
    controls.setActive(!ctx.settings.open);
    const seated = sim.seated;
    const racer = ctx.racer?.state;
    const racing = racer?.mode === RacerMode.Racing;
    for (const id of [FIRE, 'ready', 'jump']) controls.setVisible(id, !seated);
    for (const id of ['brake', 'push', 'reset', 'cam', 'tilt']) controls.setVisible(id, seated);
    controls.setVisible('boost', seated && sim.stats().rockets > 0);
    controls.setVisible('quit', racing);
    controls.setLabel('tilt', this.tilt.on ? 'TILT ✓' : 'TILT');
    if (seated) {
      controls.setSlots([]);
      return;
    }
    const wrench = sim.tool === WRENCH;
    controls.setLabel(FIRE, wrench ? 'REMOVE' : 'STICK');
    controls.setLabel('ready', racer?.ready ? 'NOT READY' : 'READY');
    const slots = PLACEABLE.map((kind) => ({ name: PARTS[kind].name, charges: Infinity, current: !wrench && sim.part === kind }));
    slots.push({ name: 'Wrench', charges: Infinity, current: wrench });
    controls.setSlots(slots);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    navigator.vibrate?.(12);
  }

  died(): void {}

  seated(on: boolean): void {
    this.chase.reset();
    this.ctx.hud.setLocked(true, Platform.Touch);
    if (on) this.ctx.hud.message('Seated! Slide your left thumb to steer (or turn TILT on), and hold ROCKETS, BRAKE or PUSH');
  }

  countdown(n: number): void {
    countdownBanner(this.ctx, n);
    navigator.vibrate?.(n > 0 ? 40 : 160);
  }

  crashed(parts: number): void {
    this.rig.shake(Math.min(0.25, 0.06 * parts));
    navigator.vibrate?.(Math.min(200, 40 * parts));
  }

  finished(): void {
    finishBanner(this.ctx);
    navigator.vibrate?.([80, 60, 80, 60, 200]);
  }
}
