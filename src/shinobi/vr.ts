import { Holsters } from '../crossplay/holsters';
import { Side, handIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { direction } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import type { Tool, UseEffect } from '../crossplay/tool';
import { SnapTurn, deadzone, readHand, readHead } from '../crossplay/vrControls';
import type { ShinobiContext, Vec3 } from './context';
import { GuardKind, ShinobiMode } from './defs';
import { escapedNews, takenNews, tookDownNews, watchGuards } from './desktop';
import { idleShinobiIntent, type ShinobiIntent } from './intent';
import type { NinjaTool } from './kit';
import type { ShinobiFrontend, ShinobiRole } from './shinobi';
import { Wrist } from './wrist';

const TRIGGER = 0.6;

/**
 * A headset. Walk your room or push the left stick; the right stick snap-turns. The tanto hangs at your left hip, kunai
 * on the right of your chest and shuriken on the left: squeeze a grip by one to take it. Swing the tanto through a guard
 * to cut; hold the trigger on a kunai or shuriken, swing, and let go of the trigger to throw it. Squeeze an empty hand on
 * any wall, roof edge or tower and pull to climb. Hold A over someone who's down to help them up; Y opens the settings.
 */
export class VrShinobi implements ShinobiFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  private readonly holsters: Holsters;
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly intent = idleShinobiIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private readonly turn = new SnapTurn();
  private readonly watch = { hunted: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: ShinobiContext,
    private readonly sim: ShinobiRole,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.wrist = new Wrist(rig, ctx.hud, 'shinobi');
    this.menu = new VrSettings(ctx.settings, rig);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    ctx.hud.message('Squeeze an empty hand on a wall and pull to climb. Your tanto is at your left hip.');
  }

  dispose(): void {
    this.holsters.dispose();
    this.wrist.dispose();
    this.menu.dispose();
  }

  read(dt: number): ShinobiIntent {
    const { rig, sim, intent } = this;
    this.lift();
    this.source.read(rig, dt);
    const { left, right } = rig;
    intent.strafe = intent.forward = 0;
    intent.interact = right.down(Btn.A) || left.down(Btn.A);
    if (left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);

    this.turn.update(rig, right.stickX);
    readHead(rig, this.head);
    if (sim.mode !== ShinobiMode.Dead && sim.mode !== ShinobiMode.Escaped) {
      intent.strafe = deadzone(left.stickX);
      intent.forward = -deadzone(left.stickY);
    }
    this.holsters.update(sim.inventory);
    readHand(rig, this.holsters, right, this.hands[Side.Right], TRIGGER);
    readHand(rig, this.holsters, left, this.hands[Side.Left], TRIGGER);
    if (onMenu) {
      intent.interact = false;
      for (const hand of this.hands) hand.trigger = hand.grab = false;
    }
    return intent;
  }

  /** Your real floor under the avatar's feet: on the ground, up a wall, on a roof. */
  private lift(): void {
    const feet = this.ctx.me?.state.z ?? 0;
    this.rig.root.position.y = this.rig.floorY + feet;
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    if (!ctx.me) return;
    this.lift();
    const active = sim.mode === ShinobiMode.Alive || sim.mode === ShinobiMode.Downed;
    this.holsters.animate(dt, active);
    ctx.sfx.setListener(rig.head(this.tmp), direction(rig.headHeading(), rig.headPitch(), this.dir));
    ctx.hud.showShinobi(ctx, sim, { climb: 'Grip and pull', use: 'Swing', help: 'Hold A', bar: '' });
    this.wrist.update(ctx);
    watchGuards(ctx, this.watch, rig, () => {
      rig.left.pulse(0.6, 80);
      rig.right.pulse(0.6, 80);
    });
  }

  moved(dx: number, dy: number): void {
    this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.rig.placeHeadAt(x, y);
  }

  hurt(): void {
    this.rig.flash(0x8a0000, 0.55);
    this.rig.left.pulse(0.9, 160);
    this.rig.right.pulse(0.9, 160);
    this.ctx.sfx.play('hurt');
  }

  used(side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    if (side === null) return;
    (side === Side.Left ? this.rig.left : this.rig.right).pulse(Math.min(1, 0.2 + effect.kick * 0.6), 40);
  }

  died(): void {
    this.rig.setTint(0x202020, 0.55);
    takenNews(this.ctx);
  }

  climbed(over: boolean): void {
    if (over) this.ctx.sfx.play('grip', undefined, 0.6);
  }

  gripped(side: Side): void {
    (side === Side.Left ? this.rig.left : this.rig.right).pulse(0.5, 30);
    this.ctx.sfx.play('grip');
  }

  landed(hard: boolean): void {
    if (!hard) return;
    this.rig.left.pulse(0.7, 90);
    this.rig.right.pulse(0.7, 90);
  }

  tookDown(kind: GuardKind): void {
    tookDownNews(this.ctx, kind);
  }

  picked(tool: NinjaTool): void {
    this.ctx.hud.message(`Picked up a ${tool.name.toLowerCase()}`);
    this.rig.left.pulse(0.3, 30);
  }

  downed(): void {
    this.rig.flash(0x5a0000, 0.8);
    this.rig.setTint(0x3a0000, 0.3);
    this.ctx.hud.showBanner("YOU'RE DOWN", '#ff5a4a', 2500);
  }

  helpedUp(): void {
    this.rig.setTint(0, 0);
    this.ctx.hud.showBanner('BACK ON YOUR FEET', '#9fe0a8', 2000);
  }

  escaped(): void {
    escapedNews(this.ctx);
  }

  restarted(): void {
    this.rig.setTint(0, 0);
  }
}
