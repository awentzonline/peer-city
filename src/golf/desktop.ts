import { DesktopTool } from '../crossplay/desktopTool';
import { MOUSE_SENSITIVITY, readWalking } from '../crossplay/desktopControls';
import type { DesktopInput } from '../crossplay/input';
import { stillIntent, type Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import { GolfCamera } from './camera';
import type { GolfContext, Vec3 } from './context';
import type { Golfer, GolferFrontend } from './golfer';
import type { GolfKeys } from './hud';
import { idleGolfIntent, stillGolf, type GolfIntent } from './intent';
import { TOOLS } from './kit';
import { scoreName } from './match';

const WALK_HELP =
  '<b>WASD</b> walk · <b>Shift</b> run · <b>Mouse</b> look · <b>Click</b> swing at someone · <b>1-4</b> clubs · <b>F</b> play your ball · <b>E</b> cart · <b>Tab</b> scorecard · <b>Esc</b> settings · <b>V</b> mic';
const ADDRESS_HELP = '<b>Mouse</b> or <b>A D</b> aim · <b>Hold click</b> to draw back, <b>let go</b> to swing · <b>1-4</b> clubs · <b>W S</b> or <b>F</b> step away · <b>Tab</b> scorecard';
const DRIVE_HELP = '<b>W S</b> drive · <b>A D</b> steer · <b>Space</b> brake · <b>E</b> get out · <b>C</b> camera · <b>Mouse</b> look around · <b>Tab</b> scorecard';

const KEYS: Omit<GolfKeys, 'help'> = {
  swing: 'Hold click to draw the club back, and let go to swing: the meter falls back if you hold on too long',
  address: 'press F',
  cart: 'E',
};

/** How fast A and D turn your aim over the ball, radians a second. */
const AIM_KEYS = 0.9;

/**
 * Keyboard and mouse. On foot it's first person with a club in hand: click swings it at whoever's in front. Walk
 * up to your ball (or press F near it) and the camera goes behind the ball: aim with the mouse or A and D, hold
 * the button to draw the club back, and let go to swing. Driving, W and S go, A and D steer, Space brakes.
 */
export class DesktopGolfer implements GolferFrontend {
  readonly platform = Platform.Desktop;
  private readonly intent = idleGolfIntent();
  private readonly held: DesktopTool;
  private readonly camera: GolfCamera;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private nextMotor = 0;

  constructor(
    private readonly ctx: GolfContext,
    private readonly sim: Golfer,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.camera = new GolfCamera(ctx, sim, rig);
  }

  get showSelf(): boolean {
    return this.camera.showSelf;
  }

  get showDriver(): boolean {
    return this.camera.showDriver;
  }

  dispose(): void {
    this.held.dispose();
  }

  read(dt: number): GolfIntent {
    const { input: k, intent, sim } = this;
    const key = (code: string) => (k.down(code) ? 1 : 0);
    const [dx, dy] = k.consumeMouse();
    stillGolf(stillIntent(intent));
    if (this.ctx.settings.open) return intent;

    if (sim.seated) {
      intent.throttle = key('KeyW') + key('ArrowUp') - key('KeyS') - key('ArrowDown');
      intent.steer = key('KeyA') + key('ArrowLeft') - key('KeyD') - key('ArrowRight');
      intent.brake = k.down('Space');
      intent.interact = k.pressed('KeyE');
      if (k.pressed('KeyC')) this.camera.cartEyes = !this.camera.cartEyes;
      this.camera.look(dx * MOUSE_SENSITIVITY, -dy * MOUSE_SENSITIVITY);
      return intent;
    }
    if (sim.down) {
      this.camera.look(dx * MOUSE_SENSITIVITY, -dy * MOUSE_SENSITIVITY);
      return intent;
    }

    intent.turn = dx * MOUSE_SENSITIVITY;
    intent.lookUp = -dy * MOUSE_SENSITIVITY;
    readWalking(k, intent);
    if (sim.addressing) {
      // over the ball, A and D aim instead of stepping away
      intent.turn += (key('KeyD') + key('ArrowRight') - key('KeyA') - key('ArrowLeft')) * AIM_KEYS * dt;
      intent.strafe = 0;
      intent.jump = false;
    }
    if (intent.forward || intent.strafe) this.camera.stopFollowing();
    intent.address = k.pressed('KeyF');
    intent.interact = k.pressed('KeyE');
    intent.trigger = k.locked && k.mouse(0);
    for (let i = 0; i < TOOLS.all.length; i++) if (k.pressed(`Digit${i + 1}`)) intent.selectTool = TOOLS.all[i];
    intent.cycleTool = Math.sign(k.wheel());
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    return intent;
  }

  present(dt: number): void {
    const { ctx, sim } = this;
    if (!sim.me) return;
    this.camera.update(dt);
    this.held.setTool(sim.inventory.current);
    this.held.update(dt, this.camera.mode === 'eyes');
    const help = sim.seated ? DRIVE_HELP : sim.addressing ? ADDRESS_HELP : WALK_HELP;
    ctx.hud.showGolfer(ctx, sim, { ...KEYS, help }, this.input.down('Tab'));
    this.nextMotor = cartSounds(ctx, sim, this.nextMotor);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    if (effect.hit === 'body') this.ctx.hud.hitMarker();
  }

  died(): void {}

  seated(on: boolean): void {
    this.ctx.hud.setLocked(this.input.locked, Platform.Desktop);
    if (on) this.ctx.hud.message('W and S drive, A and D steer, Space brakes, E gets out');
  }

  knocked(): void {
    knockedFlash(this.ctx, this.rig);
  }

  struck(power: number): void {
    this.camera.followBall();
    struckEffects(this.ctx, this.sim, power);
  }

  holed(strokes: number, par: number): void {
    holedBanner(this.ctx, strokes, par);
  }
}

/** Knocked flat, the same on every screen. */
export function knockedFlash(ctx: GolfContext, rig: Rig): void {
  rig.flash(0xffffff, 0.5);
  rig.shake(0.25);
  const s = ctx.me?.state;
  if (s) ctx.fx.stars(s.x, s.y, ctx.course.heightAt(s.x, s.y) + 0.5);
}

/** Turf off the club face where you struck it. */
export function struckEffects(ctx: GolfContext, sim: Golfer, power: number): void {
  const b = sim.sim;
  ctx.fx.strike(b.x, b.y, b.z, sim.lie, Math.atan2(b.vy, b.vx), power);
}

/** Your ball dropped: a banner saying what you scored, and a bit of a fuss. */
export function holedBanner(ctx: GolfContext, strokes: number, par: number): void {
  const d = strokes - par;
  const color = strokes === 1 || d <= -2 ? '#ffd32a' : d === -1 ? '#55efc4' : d === 0 ? '#ffffff' : '#fab1a0';
  ctx.hud.showBanner(scoreName(strokes, par).toUpperCase(), color, 3200);
  ctx.sfx.play('cup', undefined, 0.8);
  if (d <= 0) ctx.sfx.play('fanfare', undefined, d < 0 ? 1 : 0.6);
  const pin = ctx.course.holes[ctx.ball?.state.hole ?? 0].pin;
  ctx.fx.confetti(pin.x, pin.y, pin.z);
}

/** The whine of the cart you're driving, higher the faster. Returns when to play it next. */
export function cartSounds(ctx: GolfContext, sim: Golfer, next: number): number {
  const cart = sim.cart;
  if (!cart || ctx.now < next) return next;
  const speed = Math.abs(cart.state.speed);
  if (speed > 0.3) ctx.sfx.play('motor', undefined, Math.min(1, speed / 11));
  return ctx.now + 120;
}
