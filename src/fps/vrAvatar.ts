import { weaponSpec, type Weapon } from './arsenal';
import type { AvatarFrontend, AvatarSim, ShotResult } from './avatar';
import { direction, type GameContext, type Vec3 } from './context';
import { GUN_IN_HAND, Holsters } from './holsters';
import { Side, handIntent, idleIntent, type AvatarIntent, type HandIntent, type TrackedHead } from './intent';
import type { MinimapFeed } from './minimap';
import { Platform } from './platform';
import { Btn, type Rig, type XRHand, type XrPoseSource } from './rig';
import { VrHud } from './vrhud';

const SNAP_TURN = Math.PI / 6;
const TRIGGER = 0.6;

const deadzone = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);

/**
 * A headset. Walk round your room or use the left stick; the right stick snap-turns. Guns live in holsters
 * on your body and each hand fires the one it grabbed. Sitting in a car calibrates your head to the
 * driver's seat. Nothing moves the camera against your will: damage tints the view and buzzes the
 * controllers instead of shaking. The HUD is on your left wrist.
 *
 * Poses come from `source`: a WebXR session, or a desktop stand-in (`?xrsim`).
 */
export class VrAvatar implements AvatarFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  readonly holsters: Holsters;
  private readonly wrist: VrHud;
  private readonly intent = idleIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private turnArmed = true;
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: GameContext,
    private readonly sim: AvatarSim,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
    private readonly minimap: MinimapFeed,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.wrist = new VrHud(rig, ctx.hud);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    if (source.mode === 'vr') ctx.hud.message('VR: grip grabs the pistol on your right hip, trigger shoots, A enters cars');
  }

  dispose(): void {
    this.holsters.dispose();
    this.wrist.dispose();
  }

  read(dt: number): AvatarIntent {
    const { rig, sim, intent } = this;
    this.source.read(rig, dt);
    const { left, right } = rig;
    if (sim.onFoot) this.snapTurn(right.stickX);
    if (sim.driving && left.pressed(Btn.B)) {
      rig.recenter();
      this.ctx.hud.message('Seat recentered');
    }

    rig.head(this.head);
    this.head.heading = rig.headHeading();
    this.head.pitch = rig.headPitch();
    intent.strafe = deadzone(left.stickX);
    intent.forward = -deadzone(left.stickY);
    intent.brake = right.down(Btn.Stick); // the grips are for grabbing guns
    intent.horn = right.pressed(Btn.B);
    intent.interact = right.pressed(Btn.A) || left.pressed(Btn.A);

    // Holsters turn grips into which gun each hand holds; the rules only see what's in the hand.
    this.holsters.update(sim.inventory);
    this.readHand(right, this.hands[Side.Right]);
    this.readHand(left, this.hands[Side.Left]);
    return intent;
  }

  /** Spin the play space about the head. The rules never turn a headset; they just see it face a new way. */
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
    out.weapon = this.holsters.held(hand);
    out.trigger = hand.trigger >= TRIGGER;
    if (!hand.connected) return;
    this.rig.handPose(hand, GUN_IN_HAND, out.grip, out.aim);
    this.rig.handPose(hand, this.holsters.muzzle(hand), out.muzzle, out.aim);
  }

  present(dt: number): void {
    const { ctx, rig, sim, minimap } = this;
    const s = sim.me?.state;
    if (!s) return;
    const alive = s.hp > 0;
    const car = s.car ? sim.currentCar : undefined;
    if (car && alive) {
      const e = sim.eyePosition(this.tmp);
      rig.seatIn(e.x, e.y, e.z, car.state.angle);
    }
    rig.setTint(sim.arrested ? 0x0a1a55 : 0x550000, !alive ? 0.6 : sim.arrested ? 0.3 : 0);
    this.holsters.animate(dt, alive);
    const heading = rig.headHeading();
    ctx.sfx.setListener(rig.head(this.tmp), direction(heading, rig.headPitch(), this.dir));
    ctx.hud.showAvatar(sim, 'A');
    if (minimap.fresh) ctx.hud.updateMinimap(s.x, s.y, heading, minimap.dots);
    this.wrist.update(ctx.now, true, { x: s.x, y: s.y, heading, dots: minimap.dots });
  }

  moved(dx: number, dy: number): void {
    this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.rig.leaveSeat();
    this.rig.placeHeadAt(x, y);
  }

  seated(): void {
    this.rig.recenter();
  }

  hurt(amount: number): void {
    const { rig } = this;
    rig.flash(0xff0000, Math.min(0.5, 0.15 + amount / 120));
    rig.left.pulse(0.5, 90);
    rig.right.pulse(0.5, 90);
  }

  fired(side: Side | null, weapon: Weapon, result: ShotResult): void {
    if (side === null) return;
    const hand = side === Side.Left ? this.rig.left : this.rig.right;
    this.holsters.recoil(hand);
    hand.pulse(Math.min(1, 0.4 + weaponSpec(weapon).kick * 0.2), 35);
    if (result !== 'miss') hand.pulse(1, 60);
  }

  died(): void {}
}
