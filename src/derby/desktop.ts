import { DesktopTool } from '../crossplay/desktopTool';
import type { DesktopInput } from '../crossplay/input';
import type { Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import type { Builder, BuilderFrontend } from './builder';
import { clamp, direction, type DerbyContext, type Vec3 } from './context';
import { RacerMode } from './defs';
import { idleDerbyIntent, type DerbyIntent } from './intent';
import { PART_GUN, WRENCH } from './kit';
import { PLACEABLE } from './parts';
import { rotate } from './physics';
import { quatOf } from './racer';

const MOUSE_SENSITIVITY = 0.0022;
const CHASE_DISTANCE = 7;
const CHASE_HEIGHT = 2.6;

const BUILD_HELP =
  '<b>WASD</b> move · <b>Mouse</b> look · <b>Click</b> place / remove · <b>1-9</b> parts · <b>Wheel</b> next part · <b>X</b> wrench · <b>F</b> ready · <b>Esc</b> settings · <b>V</b> mic';
const DRIVE_HELP = '<b>A D</b> steer · <b>W</b> push off · <b>S</b> brake · <b>Space</b> rockets · <b>R</b> back to checkpoint · <b>C</b> camera · <b>Mouse</b> look around';

/**
 * Keyboard and mouse. In the garage, first person with a crosshair: point the part gun at a face of any
 * racer's part and click to stick the loaded part on, pick parts with the number keys or the wheel, X for the
 * wrench to take them off. Racing, a chase camera you can swing round with the mouse (C for the driver's
 * eyes); A and D steer, W pushes off, S brakes, Space fires rockets.
 */
export class DesktopBuilder implements BuilderFrontend {
  readonly platform = Platform.Desktop;
  private readonly intent = idleDerbyIntent();
  private readonly held: DesktopTool;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly cam = { x: 0, y: 0, z: 0, ready: false };
  /** Looking round the racer: yaw and pitch offsets from behind it, springing back when the mouse is still. */
  private orbit = 0;
  private orbitPitch = 0;
  private firstPerson = false;
  private nextRumble = 0;

  constructor(
    private readonly ctx: DerbyContext,
    private readonly sim: Builder,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
  }

  get showSelf(): boolean {
    return false;
  }

  get showDriver(): boolean {
    return !this.firstPerson;
  }

  dispose(): void {
    this.held.dispose();
  }

  read(): DerbyIntent {
    const { input: k, intent, sim } = this;
    const key = (code: string) => (k.down(code) ? 1 : 0);
    const busy = this.ctx.settings.open;
    const [dx, dy] = k.consumeMouse();
    Object.assign(intent, { turn: 0, lookUp: 0, strafe: 0, forward: 0, run: false, crouch: false, jump: false, trigger: false, steer: 0, brake: false, push: false, boost: false, reset: false, ready: false });
    intent.part = null;
    intent.cyclePart = 0;
    intent.selectTool = null;
    intent.cycleTool = 0;
    if (busy) return intent;

    if (sim.seated) {
      intent.steer = key('KeyA') + key('ArrowLeft') - key('KeyD') - key('ArrowRight');
      intent.push = k.down('KeyW') || k.down('ArrowUp');
      intent.brake = k.down('KeyS') || k.down('ArrowDown');
      intent.boost = k.down('Space') || k.down('ShiftLeft');
      intent.reset = k.pressed('KeyR');
      if (k.pressed('KeyC')) this.firstPerson = !this.firstPerson;
      this.orbit = clamp(this.orbit - dx * MOUSE_SENSITIVITY, -Math.PI, Math.PI);
      this.orbitPitch = clamp(this.orbitPitch - dy * MOUSE_SENSITIVITY, -0.5, 0.9);
      return intent;
    }

    intent.turn = dx * MOUSE_SENSITIVITY;
    intent.lookUp = -dy * MOUSE_SENSITIVITY;
    intent.strafe = key('KeyD') - key('KeyA');
    intent.forward = key('KeyW') - key('KeyS');
    intent.run = k.down('ShiftLeft') || k.down('ShiftRight');
    intent.jump = k.pressed('Space');
    intent.trigger = k.locked && k.mouse(0);
    intent.ready = k.pressed('KeyF');
    for (let i = 0; i < PLACEABLE.length && i < 9; i++) if (k.pressed(`Digit${i + 1}`)) intent.part = PLACEABLE[i];
    if (intent.part !== null) intent.selectTool = PART_GUN;
    if (k.pressed('KeyX') || k.pressed('Digit0')) intent.selectTool = sim.tool === WRENCH ? PART_GUN : WRENCH;
    const wheel = Math.sign(k.wheel());
    if (wheel) {
      if (sim.tool === WRENCH) intent.selectTool = PART_GUN;
      else intent.cyclePart = wheel;
    }
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    const s = sim.me?.state;
    if (!s) return;
    if (sim.seated && ctx.racer) {
      this.chase(dt);
      this.held.update(dt, false);
    } else {
      this.cam.ready = false;
      const e = sim.eyePosition(this.tmp);
      rig.setDesktopView(e.x, e.y, e.z, sim.heading, sim.pitch);
      this.held.setTool(sim.inventory.current);
      this.held.update(dt, true);
      ctx.sfx.setListener(rig.head(this.tmp), direction(sim.heading, sim.pitch, this.dir));
    }
    const racing = ctx.racer?.state.mode === RacerMode.Racing;
    ctx.hud.showBuilder(ctx, sim, { ready: 'F', parts: '1-9', help: sim.seated ? DRIVE_HELP : BUILD_HELP });
    if (racing && ctx.now >= this.nextRumble) {
      this.nextRumble = ctx.now + 110;
      raceSounds(ctx);
    }
  }

  /** Behind and above the racer, looking where it's going, eased so bumps don't shake the view to bits. */
  private chase(dt: number): void {
    const { ctx, rig, sim } = this;
    const r = ctx.racer!.state;
    const q = quatOf(r);
    if (this.firstPerson) {
      const eye = sim.seatEye(this.tmp);
      const f = rotate(q, { x: Math.cos(this.orbit), y: Math.sin(this.orbit), z: 0 });
      const heading = Math.atan2(f.y, f.x);
      const pitch = Math.asin(clamp(f.z, -1, 1)) + this.orbitPitch * 0.6;
      rig.setDesktopView(eye.x, eye.y, eye.z, heading, pitch);
      ctx.sfx.setListener(eye, direction(heading, pitch, this.dir));
      return;
    }
    const f = rotate(q, { x: 1, y: 0, z: 0 });
    const heading = Math.atan2(f.y, f.x) + this.orbit;
    const back = Math.cos(this.orbitPitch) * CHASE_DISTANCE;
    const want = { x: r.x - Math.cos(heading) * back, y: r.y - Math.sin(heading) * back, z: r.z + CHASE_HEIGHT + Math.sin(this.orbitPitch) * CHASE_DISTANCE };
    const ground = ctx.course.heightAt(want.x, want.y) + 0.8;
    want.z = Math.max(want.z, ground);
    const cam = this.cam;
    const k = cam.ready ? 1 - Math.exp(-dt * 8) : 1;
    cam.x += (want.x - cam.x) * k;
    cam.y += (want.y - cam.y) * k;
    cam.z += (want.z - cam.z) * k;
    cam.ready = true;
    rig.setDesktopChase(cam, { x: r.x + Math.cos(heading) * 3, y: r.y + Math.sin(heading) * 3, z: r.z + 0.8 });
    // the look swings back behind the racer when you let go of the mouse
    this.orbit *= Math.exp(-dt * 1.5);
    this.orbitPitch += (0.05 - this.orbitPitch) * (1 - Math.exp(-dt * 1.5));
    ctx.sfx.setListener(cam, direction(heading, 0, this.dir));
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
  }

  died(): void {}

  seated(on: boolean): void {
    this.orbit = 0;
    this.orbitPitch = 0.05;
    this.cam.ready = false;
    this.ctx.hud.setLocked(this.input.locked, false);
    if (on) this.ctx.hud.message('Seated! A/D steer, W to push off, S brakes, Space fires rockets, R if you get stuck');
  }

  countdown(n: number): void {
    countdownBanner(this.ctx, n);
  }

  crashed(parts: number): void {
    this.rig.shake(Math.min(0.25, 0.06 * parts));
  }

  finished(): void {
    finishBanner(this.ctx);
  }
}

/** The countdown, the same on every platform: the HUD shows it and the sound plays it. */
export function countdownBanner(ctx: DerbyContext, n: number): void {
  if (n > 0) {
    ctx.hud.showBanner(String(n), '#f5c542', 900);
    ctx.sfx.play('beep');
  } else {
    ctx.hud.showBanner('GO!', '#55efc4', 1200);
    ctx.sfx.play('go');
  }
}

export function finishBanner(ctx: DerbyContext): void {
  const s = ctx.racer?.state;
  ctx.hud.showBanner('FINISHED!', '#f5c542', 3500);
  ctx.sfx.play('finish');
  if (s) ctx.fx.confetti(s.x, s.y, s.z);
}

/** The rumble of your own wheels and the wind, louder the faster you go. Call every tenth of a second or so. */
export function raceSounds(ctx: DerbyContext): void {
  const s = ctx.racer?.state;
  if (!s) return;
  const speed = Math.abs(s.speed);
  const onGround = s.z - ctx.course.heightAt(s.x, s.y) < 1.2;
  if (onGround && speed > 1) ctx.sfx.play('rumble', undefined, Math.min(1, speed / 20));
  if (speed > 8) ctx.sfx.play('wind', undefined, Math.min(1, (speed - 8) / 25));
}
