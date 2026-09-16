import * as THREE from 'three';
import { Holsters } from '../crossplay/holsters';
import { Side, handIntent, idleIntent, type AvatarIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { toolMesh } from '../crossplay/models';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XRHand, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import { FollowGround, SnapTurn, readHand, readHead, deadzone } from '../crossplay/vrControls';
import type { Tool, UseEffect } from '../crossplay/tool';
import { direction, type Vec3, type WildsContext } from './context';
import type { MinimapDot } from '../crossplay/minimap';
import { Hud, mapDots } from './hud';
import { ARROWS, BOW, type WildTool } from './kit';
import { BowString } from './models';
import { VrPack } from './pack';
import type { Survivor, SurvivorFrontend } from './survivor';
import { Wrist } from './wrist';

const TRIGGER = 0.6;
const pull = new THREE.Vector3();

/**
 * A headset, where the tools are most hands-on. Walk round your room or use the left stick; the right stick
 * snap-turns. Everything you carry is on your body (crossplay/holsters.ts): squeeze a grip by it to take it.
 * Then do things the way you would: swing the axe, chop the hoe into the soil, draw the bow, eat, reach
 * down and pull crops with an empty hand. The play space rides up and down over the land under your feet.
 *
 * Poses come from `source`: a WebXR session, or a desktop stand-in (`?xrsim`).
 */
export class VrSurvivor implements SurvivorFrontend {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  readonly holsters: Holsters;
  private readonly pack: VrPack;
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly strings: [BowString, BowString];
  private readonly intent = idleIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private readonly taught = new Set<Tool<any>>();
  private readonly turn = new SnapTurn();
  private readonly ground = new FollowGround();
  private nextMap = 0;
  private dots: MinimapDot[] = [];
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: WildsContext,
    private readonly sim: Survivor,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
    scene: THREE.Scene,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.pack = new VrPack(rig, this.holsters, sim.inventory, ctx.hud);
    this.wrist = new Wrist(rig, ctx.hud);
    this.menu = new VrSettings(ctx.settings, rig);
    this.strings = [new BowString(scene), new BowString(scene)];
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    ctx.hud.message('Your tools are on your body: squeeze a grip by your shoulders, back or belt to take one');
    ctx.hud.message('The bow hangs behind your left hip, and your arrows stand over your right shoulder');
    ctx.hud.message('What you gather goes in the pack between your shoulder blades: squeeze there to open it, and again to close it');
  }

  dispose(): void {
    this.pack.dispose();
    this.holsters.dispose();
    this.wrist.dispose();
    this.menu.dispose();
    for (const s of this.strings) s.dispose();
  }

  read(dt: number): AvatarIntent {
    const { rig, sim, intent } = this;
    this.source.read(rig, dt);
    this.followGround(dt);
    const { left, right } = rig;
    if (sim.alive) this.turn.update(rig, right.stickX);

    readHead(rig, this.head);
    intent.strafe = deadzone(left.stickX);
    intent.forward = -deadzone(left.stickY);
    intent.interact = right.pressed(Btn.A) || left.pressed(Btn.A);

    if (left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);

    // Holsters turn grips into what each hand holds; the rules only see what's in the hand, or an empty one reaching out.
    this.holsters.update(sim.inventory);
    this.pack.update();
    this.readHand(right, this.hands[Side.Right]);
    this.readHand(left, this.hands[Side.Left]);
    // A trigger pulled at the settings panel is pressing a row, not swinging what's in that hand.
    if (onMenu) {
      intent.interact = false;
      for (const hand of this.hands) hand.trigger = false;
    }
    return intent;
  }

  /** Keep your real floor on the ground under the avatar, easing over bumps so it doesn't jitter. */
  private followGround(dt: number): void {
    const s = this.sim.me?.state;
    if (s) this.ground.update(this.rig, this.ctx.land.heightAt(s.x, s.y), dt);
  }

  private readHand(hand: XRHand, out: HandIntent): void {
    readHand(this.rig, this.holsters, hand, out, TRIGGER);
    // the first time a hand takes a kind of tool, say how it's used
    if (out.tool && !this.taught.has(out.tool)) {
      this.taught.add(out.tool);
      const how = Hud.vrHow(out.tool as WildTool);
      if (how) this.ctx.hud.message(how);
    }
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    const s = sim.me?.state;
    if (!s) return;
    const alive = s.hp > 0;
    rig.setTint(0x550000, alive ? 0 : 0.6);
    this.holsters.animate(dt, alive);
    this.drawStrings(alive ? s.draw : 0);

    const heading = rig.headHeading();
    ctx.sfx.setListener(rig.head(this.tmp), direction(heading, rig.headPitch(), this.dir));
    ctx.hud.showSurvivor(sim, ctx.day, true);
    if (ctx.now >= this.nextMap) {
      this.nextMap = ctx.now + 150;
      this.dots = mapDots(ctx);
      ctx.hud.updateMinimap(s.x, s.y, heading, this.dots); // for anyone watching the page
    }
    this.wrist.update(ctx.now, { x: s.x, y: s.y, heading, dots: this.dots });
  }

  /** A bow in either hand gets its string, pulled to the nock of an arrow drawn in the other. */
  private drawStrings(draw: number): void {
    const { rig, holsters } = this;
    rig.root.updateMatrixWorld(true);
    const hands = [rig.right, rig.left];
    hands.forEach((hand, i) => {
      const bow = holsters.held(hand) === BOW ? holsters.model(hand) : null;
      const other = hands[1 - i];
      const arrow = holsters.held(other) === ARROWS ? holsters.model(other) : null;
      const at = bow && arrow && draw > 0 ? toolMesh(arrow).localToWorld(pull.set(0, 0, 0.03)) : null;
      this.strings[i].update(bow, at, false);
    });
  }

  moved(dx: number, dy: number): void {
    this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.ground.reset();
    this.rig.placeHeadAt(x, y);
  }

  hurt(amount: number): void {
    const { rig } = this;
    rig.flash(0xff0000, Math.min(0.5, 0.15 + amount / 120));
    rig.left.pulse(0.5, 90);
    rig.right.pulse(0.5, 90);
  }

  used(side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    if (side === null) return;
    const hand = side === Side.Left ? this.rig.left : this.rig.right;
    this.holsters.recoil(hand, effect.kick * 0.5);
    if (effect.kick > 0) hand.pulse(Math.min(1, 0.3 + effect.kick * 0.4), 40);
    if (effect.hit && effect.hit !== 'miss') hand.pulse(1, 70);
  }

  died(): void {}
}
