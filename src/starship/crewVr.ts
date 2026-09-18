import { HeadsetHud } from '../crossplay/headsetHud';
import { Holsters } from '../crossplay/holsters';
import { Side, handIntent, type HandIntent, type TrackedHead } from '../crossplay/intent';
import { direction } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import type { Tool, UseEffect } from '../crossplay/tool';
import { SnapTurn, deadzone, readHand, readHead } from '../crossplay/vrControls';
import { ConsoleHands } from './consoles';
import type { StarshipContext, Vec3 } from './context';
import type { CrewFrontend, CrewRole } from './crew';
import type { DeckView } from './decks';
import { Carry, CrewMode, FaultKind, type Station } from './defs';
import { beamedNews, downedNews, fixedNews, usedSound } from './crewScreens';
import type { Hud } from './hud';
import { idleCrewIntent, type CrewIntent } from './intent';
import type { Drawn, Draws } from './view';

const TRIGGER = 0.6;
const TICK_MS = 500;
/** How long you count as at a console after pointing at it. */
const WORKED_MS = 5000;

/**
 * Crew in a headset. Walk your room or push the left stick; the right stick snap-turns. The phaser is on your right hip,
 * the spanner on your left, and the extinguisher on your chest: squeeze a grip by one to take it, and hold the trigger to
 * use it (put the spanner's end on the sparks, point the extinguisher at the fire). A takes and loads torpedoes, picks
 * up the relic. The bridge consoles are worked standing: point an empty hand at a console's keys or screen (or touch
 * them) and pull the trigger (see consoles.ts) — nothing stops you, and nothing needs putting down. Y opens the
 * settings. Your watch shows how you and the ship are doing.
 */
export class VrCrew implements CrewFrontend, Draws {
  readonly platform = Platform.Vr;
  readonly showSelf = false;
  private readonly holsters: Holsters;
  private readonly panels: HeadsetHud;
  private readonly menu: VrSettings;
  private readonly intent = idleCrewIntent();
  private readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly hands: [HandIntent, HandIntent] = [handIntent(), handIntent()];
  private readonly turn = new SnapTurn();
  private readonly consoles: ConsoleHands;
  /** The console last pointed at, and when: you're still at it for a moment after you lower your hand. */
  private worked: Station | null = null;
  private workedAt = -Infinity;
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private drawn_ = -1;
  private next = 0;

  constructor(
    private readonly ctx: StarshipContext,
    private readonly crew: CrewRole,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
    decks: DeckView,
  ) {
    rig.setMode(source.mode);
    this.holsters = new Holsters(rig);
    this.panels = new HeadsetHud(rig, ctx.hud, 0.22);
    this.menu = new VrSettings(ctx.settings, rig);
    this.consoles = new ConsoleHands(rig, decks.consoles);
    this.intent.head = this.head;
    this.intent.hands = this.hands;
    ctx.hud.message('Phaser on your right hip, spanner on your left, extinguisher on your chest. A takes and loads things.');
  }

  drawn(): Drawn {
    return { place: 'deck', camera: this.rig.camera, x: this.ctx.me?.state.x ?? 0 };
  }

  dispose(): void {
    this.holsters.dispose();
    this.panels.dispose();
    this.menu.dispose();
    this.consoles.dispose();
  }

  read(dt: number): CrewIntent {
    const { rig, crew, intent } = this;
    this.source.read(rig, dt);
    const { left, right } = rig;
    intent.strafe = intent.forward = 0;
    intent.use = right.pressed(Btn.A) || left.pressed(Btn.A);
    intent.sit = false;
    intent.acts.length = 0;
    if (left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);
    this.turn.update(rig, right.stickX);
    readHead(rig, this.head);
    if (crew.me?.state.mode === CrewMode.Up) {
      intent.strafe = deadzone(left.stickX);
      intent.forward = -deadzone(left.stickY);
    }
    this.holsters.update(crew.inventory);
    readHand(rig, this.holsters, right, this.hands[Side.Right], TRIGGER);
    readHand(rig, this.holsters, left, this.hands[Side.Left], TRIGGER);
    const up = crew.me?.state.mode === CrewMode.Up;
    if (onMenu || !up) {
      this.consoles.rest(intent.acts);
      if (onMenu) intent.use = false;
      for (const hand of this.hands) hand.trigger = hand.grab = false;
    } else {
      // an empty hand points at the consoles; one holding a tool is still using it
      const free = [right, left].filter((h) => !this.holsters.held(h) && !this.holsters.grabbing(h));
      const on = this.consoles.update(this.ctx.now, dt, free, intent.acts);
      if (on !== null) {
        this.worked = on;
        this.workedAt = this.ctx.now;
        for (const hand of this.hands) if (hand.tool === null) hand.trigger = false;
      }
    }
    // at a console while you're pointing at it (and a moment after), or standing right at it
    const near = crew.nearby?.kind === 'console' ? crew.nearby.console.station : null;
    intent.working = this.ctx.now - this.workedAt < WORKED_MS ? this.worked : near;
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, crew } = this;
    if (!ctx.me) return;
    this.holsters.animate(dt, ctx.me.state.mode === CrewMode.Up && ctx.me.state.carry === Carry.Nothing);
    ctx.sfx.setListener(rig.head(this.tmp), direction(rig.headHeading(), rig.headPitch(), this.dir));
    ctx.hud.crew(ctx, crew, { use: 'A', fire: 'the trigger', tools: 'right-hip left-hip chest', bar: '', sit: false });
    this.watch(ctx.hud);
  }

  private watch(hud: Hud): void {
    if (!this.panels.update(this.ctx.now)) return;
    if (hud.version === this.drawn_ && this.ctx.now < this.next) return;
    this.drawn_ = hud.version;
    this.next = this.ctx.now + TICK_MS;
    const c = this.panels.face('rgba(10,16,28,0.92)');
    c.fillStyle = '#9ad8ff';
    c.font = 'bold 22px Trebuchet MS, sans-serif';
    c.fillText(hud.phase, 22, 46, 470);
    const bar = (y: number, label: string, f: number, color: string) => {
      c.fillStyle = '#2a3242';
      c.fillRect(22, y, 468, 30);
      c.fillStyle = color;
      c.fillRect(24, y + 2, 464 * Math.max(0, Math.min(1, f)), 26);
      c.fillStyle = '#fff';
      c.font = 'bold 20px Trebuchet MS, sans-serif';
      c.fillText(label, 30, y + 22);
    };
    bar(70, `YOU ${Math.max(0, hud.hp)}%`, hud.hp / 100, '#7ae08a');
    bar(110, `HULL ${Math.max(0, hud.hull)}%`, hud.hull / 100, hud.hull < 40 ? '#ff5a4a' : '#9aa8c0');
    bar(150, `SHIELDS ${Math.max(0, hud.shields)}%`, hud.shields / 100, '#6ab8ff');
    c.font = '26px Trebuchet MS, sans-serif';
    c.fillStyle = hud.alert ? '#ff5a4a' : '#e8ecf4';
    c.fillText(hud.alert ? 'RED ALERT' : hud.place, 22, 220, 470);
    c.fillStyle = '#ffd35a';
    c.fillText(hud.carry === Carry.Torpedo ? 'Carrying a torpedo' : hud.carry === Carry.Relic ? 'Carrying the relic' : '', 22, 256, 470);
    hud.roster.slice(0, 6).forEach((l, i) => {
      c.fillStyle = l.color;
      c.fillRect(22, 280 + i * 34, 14, 22);
      c.fillStyle = '#e8ecf4';
      c.font = '22px Trebuchet MS, sans-serif';
      c.fillText(`${l.name} · ${l.where}`, 46, 300 + i * 34, 440);
    });
    this.panels.watch.tex.needsUpdate = true;
  }

  jolt(amount: number, shielded: boolean): void {
    const k = shielded ? 0.2 : Math.min(1, 0.3 + amount * 0.04);
    this.rig.left.pulse(k, 120);
    this.rig.right.pulse(k, 120);
    if (!shielded) this.rig.flash(0xff6a2a, Math.min(0.3, amount * 0.02));
  }

  moved(dx: number, dy: number): void {
    this.rig.shift(dx, dy);
  }

  placed(x: number, y: number): void {
    this.rig.placeHeadAt(x, y);
  }

  hurt(): void {
    this.rig.flash(0x8a0000, 0.5);
    this.rig.left.pulse(0.8, 140);
    this.rig.right.pulse(0.8, 140);
    this.ctx.sfx.play('hurt');
  }

  used(side: Side | null, tool: Tool<any>, effect: UseEffect): void {
    if (side !== null) (side === Side.Left ? this.rig.left : this.rig.right).pulse(Math.min(1, 0.15 + effect.kick * 0.6), 30);
    usedSound(this.ctx, tool, effect);
  }

  died(): void {}

  downed(): void {
    downedNews(this.ctx);
    this.rig.setTint(0x3a0000, 0.45);
  }

  revived(): void {
    this.rig.setTint(0, 0);
  }

  beamed(aboard: boolean): void {
    beamedNews(this.ctx, aboard);
    this.rig.flash(0x9ad8ff, 0.8);
  }

  seated(): void {}

  fixed(kind: FaultKind): void {
    fixedNews(this.ctx, kind);
    this.rig.right.pulse(0.5, 60);
  }

  carrying(carry: Carry): void {
    if (carry !== Carry.Nothing) this.rig.left.pulse(0.4, 50);
  }

  restarted(): void {
    this.rig.setTint(0, 0);
  }
}
