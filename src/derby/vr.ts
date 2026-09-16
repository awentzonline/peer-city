import { GRIP_IN_HAND, Holsters } from '../crossplay/holsters';
import { Side, handIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XRHand, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import type { Tool, UseEffect } from '../crossplay/tool';
import type { Builder, BuilderFrontend } from './builder';
import { direction, type DerbyContext, type Vec3 } from './context';
import { RacerMode } from './defs';
import { countdownBanner, finishBanner, raceSounds } from './desktop';
import { idleDerbyIntent, type DerbyIntent } from './intent';
import { PART_GUN } from './kit';
import { headingOf } from './physics';
import { quatOf } from './racer';
import { Wrist } from './wrist';

const SNAP_TURN = Math.PI / 6;
const TRIGGER = 0.6;
const deadzone = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);

/**
 * A headset. In the garage, walk round your room or use the left stick, and snap-turn with the right. The part
 * gun hangs on your right hip and the wrench on your left: grab one, point it at a racer and pull the trigger.
 * With the part gun in your right hand, A loads the next part; a click of the stick on the hand holding it goes
 * back one. X (the left hand's A) says you're ready to race, and Y opens the settings.
 *
 * Racing, you sit in the seat facing wherever the racer does (turning, not tipping, with it: that's kinder to
 * stomachs). Left stick steers, right trigger fires rockets, left trigger brakes, A pushes off, B puts you back
 * at the last checkpoint, and Y recentres the seat on your head.
 */
export class VrBuilder implements BuilderFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  readonly showDriver = false;
  readonly holsters: Holsters;
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly intent = idleDerbyIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private turnArmed = true;
  private nextRumble = 0;
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: DerbyContext,
    private readonly sim: Builder,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.wrist = new Wrist(rig, ctx.hud);
    this.menu = new VrSettings(ctx.settings, rig);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    ctx.hud.message('The part gun is on your right hip and the wrench on your left: squeeze a grip there to take one');
    ctx.hud.message('Point the part gun at a racer and pull the trigger to build. A on its hand loads the next part');
  }

  dispose(): void {
    this.holsters.dispose();
    this.wrist.dispose();
    this.menu.dispose();
  }

  read(dt: number): DerbyIntent {
    const { rig, sim, intent } = this;
    this.source.read(rig, dt);
    const { left, right } = rig;
    Object.assign(intent, { strafe: 0, forward: 0, steer: 0, brake: false, push: false, boost: false, reset: false, ready: false, cyclePart: 0 });
    intent.part = null;

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
      rig.head(this.head);
      this.head.heading = rig.headHeading();
      this.head.pitch = rig.headPitch();
      intent.steer = -deadzone(left.stickX);
      intent.brake = left.trigger >= TRIGGER;
      intent.boost = right.trigger >= TRIGGER;
      intent.push = right.down(Btn.A);
      intent.reset = right.pressed(Btn.B);
      for (const hand of this.hands) {
        hand.tracked = false;
        hand.trigger = false;
        hand.tool = null;
      }
      return intent;
    }

    this.followGround(dt);
    this.snapTurn(right.stickX);
    rig.head(this.head);
    this.head.heading = rig.headHeading();
    this.head.pitch = rig.headPitch();
    intent.strafe = deadzone(left.stickX);
    intent.forward = -deadzone(left.stickY);
    intent.ready = left.pressed(Btn.A);

    this.holsters.update(sim.inventory);
    this.readHand(right, this.hands[Side.Right]);
    this.readHand(left, this.hands[Side.Left]);
    // the button on the hand holding the part gun loads the next part; its stick click the one before
    for (const [hand, other] of [
      [right, this.hands[Side.Right]],
      [left, this.hands[Side.Left]],
    ] as const) {
      if (other.tool !== PART_GUN) continue;
      if (hand === right && hand.pressed(Btn.A)) intent.cyclePart = 1;
      if (hand.pressed(Btn.Stick)) intent.cyclePart = -1;
    }
    if (onMenu) for (const hand of this.hands) hand.trigger = false;
    return intent;
  }

  /** Keep your real floor on the ground under you, easing over bumps so it doesn't jitter. */
  private followGround(dt: number): void {
    const s = this.sim.me?.state;
    if (!s) return;
    const target = this.rig.floorY + this.ctx.course.heightAt(s.x, s.y);
    const root = this.rig.root.position;
    if (Math.abs(target - root.y) > 2) root.y = target;
    else root.y += (target - root.y) * Math.min(1, dt * 10);
  }

  /** Put your head where the driver's eyes are, facing where the racer faces. */
  private seat(): void {
    const racer = this.ctx.racer;
    if (!racer) return;
    const eye = this.sim.seatEye(this.tmp);
    this.rig.seatIn(eye.x, eye.y, eye.z, headingOf(quatOf(racer.state)));
  }

  private snapTurn(stick: number): void {
    if (this.turnArmed && Math.abs(stick) > 0.7) {
      this.rig.rotateAroundHead(stick > 0 ? -SNAP_TURN : SNAP_TURN);
      this.turnArmed = false;
    } else if (Math.abs(stick) < 0.3) {
      this.turnArmed = true;
    }
  }

  private readHand(hand: XRHand, out: HandIntent): void {
    out.tracked = hand.connected;
    out.tool = this.holsters.held(hand);
    out.trigger = hand.trigger >= TRIGGER;
    out.grab = this.holsters.grabbing(hand);
    if (!hand.connected) return;
    this.rig.handPose(hand, GRIP_IN_HAND, out.grip, out.pointing);
    this.rig.handPose(hand, this.holsters.tip(hand), out.tip, out.aim, this.holsters.forward(hand));
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    const s = sim.me?.state;
    if (!s) return;
    if (sim.seated) this.seat();
    this.holsters.animate(dt, !sim.seated);
    const heading = rig.headHeading();
    ctx.sfx.setListener(rig.head(this.tmp), direction(heading, rig.headPitch(), this.dir));
    ctx.hud.showBuilder(ctx, sim, {
      ready: 'X (left hand)',
      parts: 'A',
      help: sim.seated ? 'Left stick steer · A push · triggers brake / rockets · B checkpoint' : 'Grips take tools · trigger builds · A next part · X ready',
    });
    this.wrist.update(ctx.now, sim);
    if (ctx.racer?.state.mode === RacerMode.Racing && ctx.now >= this.nextRumble) {
      this.nextRumble = ctx.now + 110;
      raceSounds(ctx);
    }
  }

  moved(dx: number, dy: number): void {
    if (!this.sim.seated) this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.rig.leaveSeat();
    this.rig.placeHeadAt(x, y);
  }

  hurt(): void {}

  used(side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    if (side === null) return;
    const hand = side === Side.Left ? this.rig.left : this.rig.right;
    this.holsters.recoil(hand, effect.kick * 0.5);
    hand.pulse(0.4, 30);
  }

  died(): void {}

  seated(on: boolean): void {
    if (on) {
      this.rig.recenter();
      this.ctx.hud.message('Seated! Left stick steers, A pushes off, left trigger brakes, right trigger fires rockets');
    } else {
      this.rig.leaveSeat();
    }
  }

  countdown(n: number): void {
    countdownBanner(this.ctx, n);
    this.rig.left.pulse(n ? 0.3 : 0.8, n ? 60 : 200);
    this.rig.right.pulse(n ? 0.3 : 0.8, n ? 60 : 200);
  }

  crashed(parts: number): void {
    const k = Math.min(1, 0.3 + parts * 0.15);
    this.rig.left.pulse(k, 120);
    this.rig.right.pulse(k, 120);
  }

  finished(): void {
    finishBanner(this.ctx);
  }
}
