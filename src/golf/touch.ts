import { DesktopTool } from '../crossplay/desktopTool';
import { stillIntent, type Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FIRE, TOUCH_TUNING } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import { GolfCamera } from './camera';
import { clamp, type GolfContext, type Vec3 } from './context';
import { cartSounds, holedBanner, knockedFlash, struckEffects } from './desktop';
import type { Golfer, GolferFrontend } from './golfer';
import { idleGolfIntent, stillGolf, type GolfIntent } from './intent';
import { TOOLS } from './kit';

/** Radians of view per pixel dragged; a touch drag covers much less screen than a mouse can. */
const LOOK = 0.0042;
/** Over the ball, sideways drags aim more finely than they look. */
const AIM = 0.0018;
/** A pull this far down the screen, as a fraction of its height, is a full swing. */
const FULL_PULL = 0.32;

const BUTTONS: TouchButtonSpec[] = [
  { id: FIRE, label: 'SWING', big: true },
  { id: 'address', label: 'PLAY BALL' },
  { id: 'cart', label: 'CART' },
  { id: 'jump', label: 'JUMP' },
  { id: 'brake', label: 'BRAKE', big: true, hidden: true },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
  { id: 'card', label: 'CARD', kind: 'chip' },
  { id: 'cam', label: 'CAM', kind: 'chip', hidden: true },
];

/** A finger swinging the club over the ball: where it landed, and whether it's aiming instead. */
interface Pull {
  ox: number;
  oy: number;
  aiming: boolean;
  power: number;
}

/**
 * A phone or tablet. On foot, the left thumb walks and the right drags the view; SWING (or a tap) clubs whoever's
 * in front. Tap PLAY BALL by your ball, or walk up to it, and the camera goes behind the ball. Then a finger on
 * the right side of the screen is the club: pull it down to draw back (as far as you pull is how hard you hit)
 * and let go to swing; slide it sideways instead to aim. Driving, the left thumb is the pedals and the wheel.
 */
export class TouchGolfer implements GolferFrontend {
  readonly platform = Platform.Touch;
  private readonly intent = idleGolfIntent();
  private readonly controls: TouchControls;
  private readonly held: DesktopTool;
  private readonly camera: GolfCamera;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private pull: Pull | null = null;
  private cardOpen = false;
  private nextMotor = 0;

  constructor(
    private readonly ctx: GolfContext,
    private readonly sim: Golfer,
    private readonly rig: Rig,
    private readonly chips: { menu: () => void; mic: () => void },
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.camera = new GolfCamera(ctx, sim, rig);
    this.controls = new TouchControls({ buttons: BUTTONS, onChip: (id) => this.chip(id), tuning: TOUCH_TUNING });
    ctx.hud.message('Left thumb walks, right thumb looks. Walk up to your ball to play it.');
  }

  get showSelf(): boolean {
    return this.camera.showSelf;
  }

  get showDriver(): boolean {
    return this.camera.showDriver;
  }

  dispose(): void {
    this.controls.dispose();
    this.held.dispose();
  }

  private chip(id: string): void {
    if (id === 'menu') this.chips.menu();
    else if (id === 'mic') this.chips.mic();
    else if (id === 'card') this.cardOpen = !this.cardOpen;
    else if (id === 'cam') this.camera.cartEyes = !this.camera.cartEyes;
  }

  /** Every press is read here, in one place, because `read` ends the input's frame. */
  read(): GolfIntent {
    const { controls, intent, sim } = this;
    const t = controls.input;
    stillGolf(stillIntent(intent));
    if (this.ctx.settings.open) {
      this.pull = null;
      t.endFrame();
      return intent;
    }
    const [dx, dy] = t.consumeLook();

    if (sim.seated) {
      intent.throttle = t.stick.y;
      intent.steer = -t.stick.x;
      intent.brake = t.down('brake');
      intent.interact = t.pressed('cart');
      this.camera.look(dx * LOOK, -dy * LOOK);
    } else if (sim.down) {
      this.camera.look(dx * LOOK, -dy * LOOK);
    } else {
      intent.strafe = t.stick.x;
      intent.forward = t.stick.y;
      intent.run = t.run;
      intent.address = t.pressed('address');
      intent.interact = t.pressed('cart');
      for (let i = 0; i < TOOLS.all.length; i++) if (t.pressed(`slot${i}`)) intent.selectTool = TOOLS.all[i];
      if (intent.forward || intent.strafe) this.camera.stopFollowing();
      if (sim.addressing) {
        this.swing(dx);
      } else {
        this.pull = null;
        intent.turn = dx * LOOK;
        intent.lookUp = -dy * LOOK;
        intent.jump = t.pressed('jump');
        intent.trigger = t.down(FIRE) || t.pressed(FIRE);
      }
    }
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    t.endFrame();
    return intent;
  }

  /** Over the ball, the finger on the right is the club: pull down to draw back, let go to swing, or slide sideways to aim. */
  private swing(dx: number): void {
    const { intent } = this;
    const f = this.controls.input.lookFinger;
    let pull = this.pull;
    if (f && !pull) pull = this.pull = { ox: f.x, oy: f.y, aiming: false, power: 0 };
    if (!pull) return;
    if (!f) {
      // let go: swing with whatever it was pulled back to
      if (!pull.aiming) intent.power = pull.power;
      this.pull = null;
      return;
    }
    const down = f.y - pull.oy;
    const side = f.x - pull.ox;
    if (!pull.aiming && pull.power < 0.03 && Math.abs(side) > 22 && Math.abs(side) > down) pull.aiming = true;
    if (pull.aiming) {
      intent.turn = dx * AIM;
      return;
    }
    pull.power = clamp((down - 8) / (window.innerHeight * FULL_PULL), 0, 1);
    intent.trigger = true;
    intent.power = pull.power;
  }

  present(dt: number): void {
    const { ctx, sim, controls } = this;
    if (!sim.me) return;
    this.camera.update(dt);
    this.held.setTool(sim.inventory.current);
    this.held.update(dt, this.camera.mode === 'eyes');
    ctx.hud.showGolfer(
      ctx,
      sim,
      { swing: 'Pull a finger down the right of the screen to draw back, and let go to swing. Slide sideways to aim', address: 'Tap PLAY BALL', cart: 'Tap CART', help: '' },
      this.cardOpen,
    );
    this.nextMotor = cartSounds(ctx, sim, this.nextMotor);

    // the buttons that do something now
    controls.setActive(!ctx.settings.open);
    const seated = sim.seated;
    const walking = !seated && !sim.down;
    controls.setVisible(FIRE, walking && !sim.addressing);
    controls.setVisible('jump', walking && !sim.addressing);
    controls.setVisible('address', walking && (sim.addressing || (sim.playable && Math.hypot(sim.me.state.x - sim.sim.x, sim.me.state.y - sim.sim.y) < 6)));
    controls.setLabel('address', sim.addressing ? 'STEP AWAY' : 'PLAY BALL');
    controls.setVisible('cart', seated || (walking && !sim.addressing && !!sim.nearestFreeCart()));
    controls.setLabel('cart', seated ? 'GET OUT' : 'CART');
    controls.setVisible('brake', seated);
    controls.setVisible('cam', seated);
    controls.setLabel('card', this.cardOpen ? 'CARD ✓' : 'CARD');
    controls.setSlots(seated ? [] : TOOLS.all.map((tool) => ({ name: tool.name, charges: Infinity, current: tool === sim.inventory.current })));
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    navigator.vibrate?.(effect.hit === 'body' ? 40 : 12);
  }

  died(): void {}

  seated(on: boolean): void {
    this.ctx.hud.setLocked(true, Platform.Touch);
    if (on) this.ctx.hud.message('Your left thumb drives: push up to go, down to reverse, and sideways to steer');
  }

  knocked(): void {
    knockedFlash(this.ctx, this.rig);
    navigator.vibrate?.(120);
  }

  struck(power: number): void {
    this.camera.followBall();
    struckEffects(this.ctx, this.sim, power);
    navigator.vibrate?.(Math.round(15 + power * 30));
  }

  holed(strokes: number, par: number): void {
    holedBanner(this.ctx, strokes, par);
    navigator.vibrate?.([60, 50, 60]);
  }
}
