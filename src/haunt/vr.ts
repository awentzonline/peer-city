import { Holsters } from '../crossplay/holsters';
import { Side, handIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { direction } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import type { Tool, UseEffect } from '../crossplay/tool';
import { SnapTurn, deadzone, readHand, readHead } from '../crossplay/vrControls';
import type { HauntContext, Vec3 } from './context';
import { SurvivorMode } from './defs';
import { diedNews, escapedNews, heartbeat, lightSound, snuffedNews } from './desktop';
import { idleSurvivorIntent, type SurvivorIntent } from './intent';
import type { SurvivorFrontend, SurvivorRole } from './survivor';
import { Wrist } from './wrist';

const TRIGGER = 0.6;

/**
 * A headset. Walk round your room or push the left stick; the right stick snap-turns. The flashlight is clipped to your
 * chest: squeeze a grip by it to take it, point it with your hand, and pull the trigger to switch it on. Hold A (either
 * hand) over someone who's down to help them up. Y opens the settings. Struck, the view flashes red and both hands buzz.
 */
export class VrSurvivor implements SurvivorFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  private readonly holsters: Holsters;
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly intent = idleSurvivorIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private readonly turn = new SnapTurn();
  private readonly heart = { next: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: HauntContext,
    private readonly sim: SurvivorRole,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.wrist = new Wrist(rig, ctx.hud, 'survivor');
    this.menu = new VrSettings(ctx.settings, rig);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    ctx.hud.message('Your flashlight is clipped to your chest: squeeze a grip by it to take it');
  }

  dispose(): void {
    this.holsters.dispose();
    this.wrist.dispose();
    this.menu.dispose();
  }

  read(dt: number): SurvivorIntent {
    const { rig, sim, intent } = this;
    this.source.read(rig, dt);
    const { left, right } = rig;
    intent.strafe = intent.forward = 0;
    intent.interact = right.down(Btn.A) || left.down(Btn.A);
    if (left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);

    this.turn.update(rig, right.stickX);
    readHead(rig, this.head);
    if (sim.mode !== SurvivorMode.Dead) {
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

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    if (!ctx.me) return;
    const active = sim.mode === SurvivorMode.Alive || sim.mode === SurvivorMode.Downed;
    this.holsters.animate(dt, active);
    ctx.sfx.setListener(rig.head(this.tmp), direction(rig.headHeading(), rig.headPitch(), this.dir));
    ctx.hud.showSurvivor(ctx, sim, { light: '', help: 'Hold A', bar: '' });
    this.wrist.update(ctx);
    heartbeat(ctx, this.heart);
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
    (side === Side.Left ? this.rig.left : this.rig.right).pulse(Math.min(1, 0.2 + effect.kick * 0.5), 30);
  }

  died(): void {
    this.rig.setTint(0x202020, 0.55);
    diedNews(this.ctx);
  }

  lit(on: boolean, flat: boolean): void {
    lightSound(this.ctx, flat);
    for (const hand of [this.rig.left, this.rig.right]) hand.pulse(on ? 0.3 : 0.15, 25);
  }

  snuffed(): void {
    snuffedNews(this.ctx);
    for (const hand of [this.rig.left, this.rig.right]) hand.pulse(0.4, 60);
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

  gotKey(): void {
    this.ctx.hud.showBanner('A KEY', '#ffd35a', 1800);
    this.rig.left.pulse(0.5, 60);
  }

  placedKey(): void {}

  restarted(): void {
    this.rig.setTint(0, 0);
  }
}
