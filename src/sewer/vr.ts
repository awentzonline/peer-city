import { Holsters } from '../crossplay/holsters';
import { Side, handIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { direction } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FollowGround, SnapTurn, deadzone, readHand, readHead } from '../crossplay/vrControls';
import type { SewerContext, Vec3 } from './context';
import { LordMode, type LootKind } from './defs';
import { Beeper, bankedNews, chokeNews, diedNews, dugNews, pumpSound, sackFullNews, sputterNews, surfacedNews, toreNews, underwater, wadingSound, watching } from './desktop';
import { idleLordIntent, type LordIntent } from './intent';
import { DETECTOR } from './kit';
import type { LordFrontend, LordRole } from './lord';
import { Wrist } from './wrist';

const TRIGGER = 0.6;

/**
 * A headset. Walk round your room or push the left stick; the right stick snap-turns. Your hands are your fists: swing
 * them into a goblin to send it flying. Squeeze a grip on one to pick it up by the scruff, take hold with your other
 * hand too and pull them apart to tear it in half, or let go mid-swing to throw it. The detector hangs at your left hip
 * and the hose at your right: squeeze a grip by them to take them. Grip the hose's slide with your other hand and pump
 * it back and forth, then pull the trigger to spray. Grab a valve's wheel and crank it round; reach down into the muck
 * and grip to dig something up. Hold A to haul someone up or climb the ladder. Y opens the settings.
 */
export class VrLord implements LordFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  private readonly holsters: Holsters;
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly intent = idleLordIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private readonly turn = new SnapTurn();
  private readonly follow = new FollowGround();
  private readonly beeper = new Beeper();
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private nextStep = 0;

  constructor(
    private readonly ctx: SewerContext,
    private readonly lord: LordRole,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.wrist = new Wrist(rig, ctx.hud);
    this.menu = new VrSettings(ctx.settings, rig);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    ctx.hud.message('Swing your fists at the goblins. Detector on your left hip, hose on your right.');
  }

  nozzle(): Vec3 | null {
    return null;
  }

  dispose(): void {
    this.holsters.dispose();
    this.wrist.dispose();
    this.menu.dispose();
  }

  read(dt: number): LordIntent {
    const { rig, lord, intent } = this;
    this.source.read(rig, dt);
    const { left, right } = rig;
    intent.strafe = intent.forward = 0;
    intent.interact = right.down(Btn.A) || left.down(Btn.A);
    if (left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);

    this.turn.update(rig, right.stickX);
    readHead(rig, this.head);
    if (!watching(lord)) {
      intent.strafe = deadzone(left.stickX);
      intent.forward = -deadzone(left.stickY);
    }
    this.holsters.update(lord.inventory);
    readHand(rig, this.holsters, right, this.hands[Side.Right], TRIGGER);
    readHand(rig, this.holsters, left, this.hands[Side.Left], TRIGGER);
    if (onMenu) {
      intent.interact = false;
      for (const hand of this.hands) hand.trigger = hand.grab = false;
    }
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, lord } = this;
    const me = ctx.me;
    if (!me) return;
    const active = lord.mode === LordMode.Active;
    this.holsters.animate(dt, active);
    this.follow.update(rig, ctx.map.groundAt(me.state.x, me.state.y), dt);
    ctx.sfx.setListener(rig.head(this.tmp), direction(rig.headHeading(), rig.headPitch(), this.dir));
    ctx.hud.showLord(ctx, lord, { interact: 'Hold A', pump: 'Grip the slide and pump', grab: 'Grip', hold: 'Grab it with your other hand and pull to tear it · let go to throw', bar: '' });
    this.wrist.update(ctx);
    this.beeper.update(ctx, lord);
    if (this.beeper.beeped) {
      const hand = this.hands[Side.Left].tool === DETECTOR ? rig.left : rig.right;
      hand.pulse(0.15 + lord.signal * 0.6, 25);
    }
    underwater(ctx, lord, rig);
    this.nextStep = wadingSound(ctx, lord, this.nextStep);
  }

  moved(dx: number, dy: number): void {
    this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.rig.placeHeadAt(x, y);
    this.follow.reset();
  }

  hurt(): void {
    this.rig.flash(0x8a0000, 0.5);
    this.rig.left.pulse(0.9, 140);
    this.rig.right.pulse(0.9, 140);
    this.ctx.sfx.play('hurt');
  }

  used(side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    if (side === null) return;
    (side === Side.Left ? this.rig.left : this.rig.right).pulse(Math.min(1, 0.2 + effect.kick * 0.5), 30);
  }

  died(): void {
    this.rig.setTint(0x202010, 0.55);
    diedNews(this.ctx);
  }

  punched(force: number, landed: boolean, side: Side | null): void {
    const hand = side === Side.Left ? this.rig.left : this.rig.right;
    hand.pulse(landed ? Math.min(1, 0.5 + force * 0.4) : 0.2, landed ? 90 : 30);
    this.ctx.sfx.play(landed ? 'thump' : 'whoosh', undefined, landed ? 0.4 : 0.6);
  }

  grabbed(_what: 'goblin' | 'loot' | 'valve', side: Side | null): void {
    const hand = side === Side.Left ? this.rig.left : this.rig.right;
    hand.pulse(0.5, 50);
  }

  tore(): void {
    toreNews(this.ctx);
    this.rig.left.pulse(1, 200);
    this.rig.right.pulse(1, 200);
  }

  pumped(charge: number): void {
    pumpSound(this.ctx, charge);
    this.rig.left.pulse(0.4, 30);
    this.rig.right.pulse(0.4, 30);
  }

  sputtered(): void {
    sputterNews(this.ctx);
  }

  dug(kind: LootKind): void {
    dugNews(this.ctx, kind);
    this.rig.left.pulse(0.5, 60);
    this.rig.right.pulse(0.5, 60);
  }

  banked(worth: number, count: number): void {
    bankedNews(this.ctx, worth, count);
  }

  sackFull(): void {
    sackFullNews(this.ctx);
  }

  choking(): void {
    chokeNews(this.ctx, this.rig);
  }

  downed(): void {
    this.rig.flash(0x5a0000, 0.8);
    this.ctx.hud.showBanner("YOU'RE DOWN", '#ff5a4a', 2500);
  }

  helpedUp(): void {
    this.rig.setTint(0, 0);
    this.ctx.hud.showBanner('BACK ON YOUR FEET', '#9fe0a8', 2000);
  }

  surfaced(): void {
    surfacedNews(this.ctx, this.rig);
  }

  restarted(): void {
    this.rig.setTint(0, 0);
  }
}
