import { Holsters } from '../crossplay/holsters';
import { Side, handIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import { SnapTurn, readHand, readHead, deadzone } from '../crossplay/vrControls';
import type { Tool, UseEffect } from '../crossplay/tool';
import { direction, type Vec3, type WallsContext } from './context';
import { idleWallsIntent, type WallsIntent } from './intent';
import type { Painter, PainterFrontend } from './painter';
import { Wrist } from './wrist';

const TRIGGER = 0.5;

const HELP = 'Grips take tools · trigger paints · A / B colour · X size · Y settings';

/**
 * A headset: paint with your hands. The spray can hangs on your right hip, the marker on your left, and the
 * roller over your left shoulder; squeeze a grip there to take one, and pull the trigger to paint where it
 * points. Spray from further off for a wider, fainter mist, and put the marker or roller right on the wall.
 * A and B step through the colours (or point at the rack and pull the trigger), X changes the size, and Y opens
 * the settings. Walk round your room or use the left stick; the right stick snap-turns.
 */
export class VrPainter implements PainterFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  readonly holsters: Holsters;
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly intent = idleWallsIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private readonly turn = new SnapTurn();
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: WallsContext,
    private readonly sim: Painter,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.wrist = new Wrist(rig, ctx.hud);
    this.menu = new VrSettings(ctx.settings, rig);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    ctx.hud.message('The spray can is on your right hip: squeeze the grip there to take it, and pull the trigger to paint');
    ctx.hud.message('The marker is on your left hip and the roller over your left shoulder. A and B change colour');
  }

  dispose(): void {
    this.holsters.dispose();
    this.wrist.dispose();
    this.menu.dispose();
  }

  read(dt: number): WallsIntent {
    const { rig, sim, intent } = this;
    this.source.read(rig, dt);
    const { left, right } = rig;
    Object.assign(intent, { strafe: 0, forward: 0, cycleColor: 0, cycleSize: 0 });
    intent.color = null;

    if (left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);

    this.turn.update(rig, right.stickX);
    readHead(rig, this.head);
    intent.strafe = deadzone(left.stickX);
    intent.forward = -deadzone(left.stickY);
    if (right.pressed(Btn.A)) intent.cycleColor = 1;
    if (right.pressed(Btn.B)) intent.cycleColor = -1;
    if (left.pressed(Btn.A)) intent.cycleSize = 1;

    this.holsters.update(sim.inventory);
    readHand(rig, this.holsters, right, this.hands[Side.Right], TRIGGER);
    readHand(rig, this.holsters, left, this.hands[Side.Left], TRIGGER);
    if (onMenu) for (const hand of this.hands) hand.trigger = false;
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    if (!sim.me) return;
    this.holsters.animate(dt, true);
    ctx.sfx.setListener(rig.head(this.tmp), direction(rig.headHeading(), rig.headPitch(), this.dir));
    ctx.hud.showPainter(ctx, sim, HELP);
    this.wrist.update(ctx.now, sim);
    // a light buzz in a hand that's painting, like the can's hiss in your palm
    sim.aims.forEach((aim, i) => {
      if (aim.painting) (i === Side.Left ? rig.left : rig.right).pulse(0.08, 20);
    });
  }

  moved(dx: number, dy: number): void {
    this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.rig.placeHeadAt(x, y);
  }

  hurt(): void {}

  used(side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    if (side === null) return;
    (side === Side.Left ? this.rig.left : this.rig.right).pulse(0.3, 25 + effect.kick * 20);
  }

  died(): void {}
}
