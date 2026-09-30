import * as THREE from 'three';
import { GRIP_IN_HAND } from '../crossplay/holsters';
import { Side, handIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { SOLID } from '../crossplay/models';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XRHand, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import { SnapTurn, deadzone, readHead } from '../crossplay/vrControls';
import { direction, type HiContext, type Vec3 } from './context';
import { idlePalIntent, type PalIntent } from './intent';
import { fistGeometry, palmGeometry, skinTone } from './models';
import type { PalFrontend, PalRole } from './pal';
import { Wrist } from './wrist';

const SQUEEZE = 0.5;

const HELP = 'Hold a hand up to offer · swing into theirs · grip for a fist · Y settings';

/** Your hands as you see them in a headset: an open palm, or a fist while the grip's squeezed. */
interface OwnHand {
  palm: THREE.Mesh;
  fist: THREE.Mesh;
}

/**
 * A headset: your hands are your hands. Hold one still over your head and it's an offer (both for a double); hold one
 * out low for down low, or a fist (squeeze the grip) out at your chest for a fist bump. Swing a hand into someone
 * else's and it's a five, graded by how fast you swung; pull your offer away fast and anyone swinging at it is too slow.
 * Slap a backside from behind, and crouch for real to creep up on it. The left stick walks, the right snap-turns, and
 * Y opens the settings.
 */
export class VrPal implements PalFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly intent = idlePalIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private readonly own: [OwnHand, OwnHand];
  private readonly turn = new SnapTurn();
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: HiContext,
    private readonly sim: PalRole,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
  ) {
    rig.setMode(source.mode);
    this.wrist = new Wrist(rig, ctx.hud);
    this.menu = new VrSettings(ctx.settings, rig);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    const skin = skinTone(ctx.me?.state.skin ?? 0);
    this.own = [ownHand(rig.right, skin, false), ownHand(rig.left, skin, true)];
    ctx.hud.message('Hold a hand up high and keep it still: that offers a five. Swing into someone else’s to give one');
    ctx.hud.message('Squeeze the grip for a fist bump. Crouch for real to sneak up on a backside');
  }

  dispose(): void {
    this.wrist.dispose();
    this.menu.dispose();
    for (const h of this.own) {
      h.palm.removeFromParent();
      h.fist.removeFromParent();
    }
  }

  read(dt: number): PalIntent {
    const { rig, intent } = this;
    this.source.read(rig, dt);
    const { left, right } = rig;
    Object.assign(intent, { strafe: 0, forward: 0 });
    if (left.pressed(Btn.B)) this.menu.toggle();
    this.menu.update(this.ctx.now);
    this.turn.update(rig, right.stickX);
    readHead(rig, this.head);
    intent.strafe = deadzone(left.stickX);
    intent.forward = -deadzone(left.stickY);
    readEmptyHand(rig, right, this.hands[Side.Right]);
    readEmptyHand(rig, left, this.hands[Side.Left]);
    return intent;
  }

  present(): void {
    const { ctx, rig, sim } = this;
    const me = sim.me;
    if (!me) return;
    for (const [i, hand] of [rig.right, rig.left].entries()) {
      const fist = hand.squeeze > SQUEEZE;
      this.own[i].palm.visible = hand.connected && !fist;
      this.own[i].fist.visible = hand.connected && fist;
    }
    ctx.sfx.setListener(rig.head(this.tmp), direction(rig.headHeading(), rig.headPitch(), this.dir));
    ctx.hud.showPal(ctx, sim, null, HELP);
    this.wrist.update(ctx.now, me.id);
  }

  moved(dx: number, dy: number): void {
    this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.rig.placeHeadAt(x, y);
  }

  hurt(): void {}

  used(): void {}

  died(): void {}

  smacked(side: Side | null, strength: number): void {
    const ms = 40 + strength * 80;
    if (side === null || side === Side.Right) this.rig.right.pulse(strength, ms);
    if (side === null || side === Side.Left) this.rig.left.pulse(strength, ms);
  }
}

/** An empty tracked hand into its intent: where the palm is, which way it points, and whether it's a fist. */
function readEmptyHand(rig: Rig, hand: XRHand, out: HandIntent): void {
  out.tracked = hand.connected;
  out.tool = null;
  out.trigger = hand.trigger > 0.5;
  out.grab = hand.squeeze > SQUEEZE;
  if (!hand.connected) return;
  rig.handPose(hand, GRIP_IN_HAND, out.grip, out.pointing);
  Object.assign(out.tip, out.grip);
  Object.assign(out.aim, out.pointing);
}

/** A palm and a fist on a controller, round its grip. The open palm faces in (the way it does round a controller). */
function ownHand(hand: XRHand, skin: number, left: boolean): OwnHand {
  const palm = new THREE.Mesh(palmGeometry(skin), SOLID);
  palm.rotation.set(-Math.PI / 2, 0, left ? Math.PI / 2 : -Math.PI / 2, 'ZXY');
  const fist = new THREE.Mesh(fistGeometry(skin), SOLID);
  for (const m of [palm, fist]) {
    m.position.copy(GRIP_IN_HAND);
    if (left) m.scale.x = -1;
    m.visible = false;
    hand.object.add(m);
  }
  return { palm, fist };
}
