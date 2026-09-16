import { DesktopTool } from '../crossplay/desktopTool';
import { MOUSE_SENSITIVITY, readWalking } from '../crossplay/desktopControls';
import type { DesktopInput } from '../crossplay/input';
import { stillIntent, type Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import type { Builder, BuilderFrontend } from './builder';
import { direction, type DerbyContext, type Vec3 } from './context';
import { ChaseCamera } from './chase';
import { RacerMode } from './defs';
import { idleDerbyIntent, type DerbyIntent } from './intent';
import { PART_GUN, WRENCH } from './kit';
import { PLACEABLE } from './parts';

const BUILD_HELP =
  '<b>WASD</b> move · <b>Mouse</b> look · <b>Click</b> place / remove · <b>1-9</b> parts · <b>Wheel</b> next part · <b>X</b> wrench · <b>F</b> ready · <b>Esc</b> settings · <b>V</b> mic';
const DRIVE_HELP = '<b>A D</b> steer · <b>W</b> push off · <b>S</b> brake · <b>Space</b> rockets · <b>R</b> back to checkpoint · <b>Q</b> give up · <b>C</b> camera · <b>Mouse</b> look around';

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
  private readonly chase: ChaseCamera;
  private nextRumble = 0;
  private readonly giveUp = new GiveUp();

  constructor(
    private readonly ctx: DerbyContext,
    private readonly sim: Builder,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.chase = new ChaseCamera(ctx, sim, rig);
  }

  get showSelf(): boolean {
    return false;
  }

  get showDriver(): boolean {
    return !this.chase.firstPerson;
  }

  dispose(): void {
    this.held.dispose();
  }

  read(): DerbyIntent {
    const { input: k, intent, sim } = this;
    const key = (code: string) => (k.down(code) ? 1 : 0);
    const busy = this.ctx.settings.open;
    const [dx, dy] = k.consumeMouse();
    stillIntent(intent);
    Object.assign(intent, { steer: 0, brake: false, push: false, boost: false, reset: false, quit: false, ready: false, part: null, cyclePart: 0 });
    if (busy) return intent;

    if (sim.seated) {
      intent.steer = key('KeyA') + key('ArrowLeft') - key('KeyD') - key('ArrowRight');
      intent.push = k.down('KeyW') || k.down('ArrowUp');
      intent.brake = k.down('KeyS') || k.down('ArrowDown');
      intent.boost = k.down('Space') || k.down('ShiftLeft');
      intent.reset = k.pressed('KeyR');
      intent.quit = k.pressed('KeyQ') && this.giveUp.press(this.ctx, 'Q');
      if (k.pressed('KeyC')) this.chase.firstPerson = !this.chase.firstPerson;
      this.chase.look(dx * MOUSE_SENSITIVITY, -dy * MOUSE_SENSITIVITY);
      return intent;
    }

    intent.turn = dx * MOUSE_SENSITIVITY;
    intent.lookUp = -dy * MOUSE_SENSITIVITY;
    readWalking(k, intent);
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
    const racing = ctx.racer?.state.mode === RacerMode.Racing;
    ctx.hud.showBuilder(ctx, sim, { ready: 'F', parts: '1-9', help: sim.seated ? DRIVE_HELP : BUILD_HELP });
    if (racing && ctx.now >= this.nextRumble) {
      this.nextRumble = ctx.now + 110;
      raceSounds(ctx);
    }
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
  }

  died(): void {}

  seated(on: boolean): void {
    this.chase.reset();
    this.ctx.hud.setLocked(this.input.locked, Platform.Desktop);
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

/** Giving up takes a second press within a few seconds, so a slip of the finger doesn't throw a race away. */
export class GiveUp {
  private armedUntil = 0;

  /** The button was pressed: true if that confirms it. */
  press(ctx: DerbyContext, button: string): boolean {
    if (ctx.racer?.state.mode !== RacerMode.Racing) return false;
    if (ctx.now < this.armedUntil) {
      this.armedUntil = 0;
      return true;
    }
    this.armedUntil = ctx.now + 3000;
    ctx.hud.message(`Press ${button} again to give up and go back to the garage`);
    return false;
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
