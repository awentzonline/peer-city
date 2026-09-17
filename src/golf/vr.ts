import { Holsters } from '../crossplay/holsters';
import { Side, handIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FollowGround, SnapTurn, deadzone, readHand, readHead } from '../crossplay/vrControls';
import { cartHeading } from './carts';
import { direction, type GolfContext, type Vec3 } from './context';
import { cartSounds, holedBanner, struckEffects } from './desktop';
import type { Golfer, GolferFrontend } from './golfer';
import { idleGolfIntent, stillGolf, type GolfIntent } from './intent';
import { Wrist } from './wrist';

const TRIGGER = 0.6;

/**
 * A headset, where golf is played for real. Walk round your room or use the left stick; the right stick snap-turns.
 * Your four clubs hang at your hips: squeeze a grip by one to take it, then walk up to your ball and
 * swing through it, as hard as you like. Swing into someone to knock them flat. A (right hand) gets in and out of a
 * cart; seated, the right trigger goes, the left reverses, and the left stick steers. Y opens the settings, or
 * recentres the seat in a cart.
 */
export class VrGolfer implements GolferFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  readonly showDriver = false;
  readonly holsters: Holsters;
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly intent = idleGolfIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private readonly turn = new SnapTurn();
  private readonly ground = new FollowGround();
  private nextMotor = 0;
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: GolfContext,
    private readonly sim: Golfer,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.wrist = new Wrist(rig, ctx.hud);
    this.menu = new VrSettings(ctx.settings, rig);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    ctx.hud.message('Your clubs hang at your hips: squeeze a grip by one to take it');
    ctx.hud.message('Walk up to your ball and swing through it for real. Swing into someone to flatten them');
  }

  dispose(): void {
    this.holsters.dispose();
    this.wrist.dispose();
    this.menu.dispose();
  }

  read(dt: number): GolfIntent {
    const { rig, sim, intent } = this;
    this.source.read(rig, dt);
    const { left, right } = rig;
    stillGolf(intent);
    intent.strafe = intent.forward = 0;
    intent.interact = right.pressed(Btn.A);

    if (left.pressed(Btn.B)) {
      if (sim.seated) {
        rig.recenter();
        this.ctx.hud.message('Seat recentred');
      } else {
        this.menu.toggle();
      }
    }
    const onMenu = this.menu.update(this.ctx.now);

    if (sim.seated) {
      this.seat();
      readHead(rig, this.head);
      intent.throttle = right.trigger >= TRIGGER ? right.trigger : left.trigger >= TRIGGER ? -left.trigger : -deadzone(left.stickY);
      intent.steer = -deadzone(left.stickX);
      intent.brake = right.down(Btn.B);
      for (const hand of this.hands) {
        hand.tracked = false;
        hand.trigger = false;
        hand.tool = null;
      }
      return intent;
    }

    this.followGround(dt);
    this.turn.update(rig, right.stickX);
    readHead(rig, this.head);
    if (!sim.down) {
      intent.strafe = deadzone(left.stickX);
      intent.forward = -deadzone(left.stickY);
    }
    this.holsters.update(sim.inventory);
    readHand(rig, this.holsters, right, this.hands[Side.Right], TRIGGER);
    readHand(rig, this.holsters, left, this.hands[Side.Left], TRIGGER);
    if (onMenu) {
      intent.interact = false;
      for (const hand of this.hands) hand.trigger = false;
    }
    return intent;
  }

  /** Keep your real floor on the ground under you, easing over bumps so it doesn't jitter. */
  private followGround(dt: number): void {
    const s = this.sim.me?.state;
    if (s) this.ground.update(this.rig, this.ctx.course.heightAt(s.x, s.y), dt);
  }

  /** Put your head where the driver's eyes are, facing where the cart does. */
  private seat(): void {
    const cart = this.sim.cart;
    if (!cart) return;
    const eye = this.sim.eyePosition(this.tmp);
    this.rig.seatIn(eye.x, eye.y, eye.z, cartHeading(cart, true));
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    if (!sim.me) return;
    if (sim.seated) this.seat();
    rig.setTint(0xffffff, sim.down ? 0.35 : 0);
    this.holsters.animate(dt, !sim.seated && !sim.down);
    const heading = rig.headHeading();
    ctx.sfx.setListener(rig.head(this.tmp), direction(heading, rig.headPitch(), this.dir));
    ctx.hud.showGolfer(ctx, sim, { swing: '', address: '', cart: 'A (right hand)', help: '' });
    this.wrist.update(ctx, heading);
    this.nextMotor = cartSounds(ctx, sim, this.nextMotor);
  }

  moved(dx: number, dy: number): void {
    if (!this.sim.seated) this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.rig.leaveSeat();
    this.ground.reset();
    this.rig.placeHeadAt(x, y);
  }

  hurt(): void {}

  used(side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    if (side === null) return;
    const hand = side === Side.Left ? this.rig.left : this.rig.right;
    this.holsters.recoil(hand, effect.kick * 0.3);
    hand.pulse(Math.min(1, 0.3 + effect.kick * 0.5), effect.hit === 'body' ? 90 : 40);
  }

  died(): void {}

  seated(on: boolean): void {
    if (on) {
      this.rig.recenter();
      this.ctx.hud.message('Right trigger goes, left trigger reverses, left stick steers, B brakes, A gets out');
    } else {
      this.rig.leaveSeat();
    }
  }

  knocked(): void {
    this.rig.flash(0xffffff, 0.6);
    this.rig.left.pulse(0.8, 150);
    this.rig.right.pulse(0.8, 150);
  }

  struck(power: number): void {
    struckEffects(this.ctx, this.sim, power);
  }

  holed(strokes: number, par: number): void {
    holedBanner(this.ctx, strokes, par);
  }
}
