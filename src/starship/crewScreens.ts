import { DesktopTool } from '../crossplay/desktopTool';
import { MOUSE_SENSITIVITY, readWalking } from '../crossplay/desktopControls';
import type { DesktopInput } from '../crossplay/input';
import type { Side } from '../crossplay/intent';
import { direction } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { TouchChips } from '../crossplay/shell';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FIRE, TOUCH_TUNING } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import type { StarshipContext, Vec3 } from './context';
import type { CrewFrontend, CrewRole } from './crew';
import { Carry, CrewMode, FaultKind, Station } from './defs';
import type { CrewKeys } from './hud';
import { idleCrewIntent, stillCrew, type ConsoleAct, type CrewIntent } from './intent';
import { EXTINGUISHER, PHASER, SPANNER, TOOLS } from './kit';
import { StationPanel } from './stations';
import type { Drawn, Draws } from './view';

const DESKTOP_KEYS: CrewKeys = {
  use: 'E',
  fire: 'Click',
  tools: '1 2 3',
  bar: '<b>WASD</b> move · <b>Shift</b> run · <b>Space</b> jump · <b>Ctrl</b> crouch · <b>Click</b> use the tool · <b>1 2 3</b> phaser, spanner, extinguisher · <b>E</b> take, load, pick up, sit · <b>Esc</b> settings · <b>V</b> mic',
};

const eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
const dirTmp: Vec3 = { x: 0, y: 0, z: 0 };
const tipTmp: Vec3 = { x: 0, y: 0, z: 0 };

/** A crew member's view from their eyes, and their ears with it. */
export function crewEyes(ctx: StarshipContext, crew: CrewRole, rig: Rig): Vec3 {
  const eye = crew.eyePosition(eyeTmp);
  if (ctx.me?.state.mode === CrewMode.Down) eye.z = 0.5;
  rig.setDesktopView(eye.x, eye.y, eye.z, crew.heading, crew.pitch);
  ctx.sfx.setListener(eye, direction(crew.heading, crew.pitch, dirTmp));
  return eye;
}

/** The bridge console someone's sitting at, as an overlay: the same station panel a phone has, without the tabs. */
class Seat {
  private panel: StationPanel | null = null;
  readonly queue: ConsoleAct[] = [];

  constructor(
    private readonly ctx: StarshipContext,
    private readonly chips: { menu(): void; mic(): void } | undefined,
    private readonly stand: () => void,
  ) {}

  update(station: Station | null): void {
    if (station === null) {
      this.close();
      return;
    }
    if (this.panel?.current !== station) {
      this.close();
      this.panel = new StationPanel(this.ctx, { station, send: (a) => this.queue.push(a), leave: this.stand, chips: this.chips });
      this.panel.root.classList.add('seated');
    }
    this.panel.update(this.ctx.now);
  }

  get open(): boolean {
    return !!this.panel;
  }

  drain(out: ConsoleAct[]): void {
    out.push(...this.queue);
    this.queue.length = 0;
  }

  close(): void {
    this.panel?.dispose();
    this.panel = null;
  }
}

/**
 * Crew on keyboard and mouse, first person. WASD walks, the mouse looks, click uses the tool in hand (1-3 or the wheel
 * to switch), E takes and loads torpedoes, picks up the relic, and sits down at a bridge console, which frees the mouse
 * for that station's panel.
 */
export class DesktopCrew implements CrewFrontend, Draws {
  readonly platform = Platform.Desktop;
  readonly showSelf = false;
  private readonly intent = idleCrewIntent();
  private readonly held: DesktopTool;
  private readonly seat: Seat;
  private standing = false;

  constructor(
    private readonly ctx: StarshipContext,
    private readonly crew: CrewRole,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.seat = new Seat(ctx, undefined, () => (this.standing = true));
  }

  drawn(): Drawn {
    return { place: 'deck', camera: this.rig.camera, x: this.ctx.me?.state.x ?? 0 };
  }

  dispose(): void {
    this.held.dispose();
    this.seat.close();
  }

  read(): CrewIntent {
    const { input: k, intent, crew } = this;
    const [dx, dy] = k.consumeMouse();
    stillCrew(intent);
    if (this.standing) {
      intent.sit = true;
      this.standing = false;
    }
    this.seat.drain(intent.acts);
    if (this.ctx.settings.open) return intent;
    if (crew.seat !== null) {
      if (k.pressed('KeyE')) intent.sit = true;
      return intent;
    }
    intent.turn = dx * MOUSE_SENSITIVITY;
    intent.lookUp = -dy * MOUSE_SENSITIVITY;
    readWalking(k, intent);
    intent.crouch = k.down('ControlLeft') || k.down('KeyC');
    intent.trigger = k.locked && k.mouse(0);
    const e = k.pressed('KeyE');
    intent.use = e;
    intent.sit = e && crew.nearby?.kind === 'console';
    [PHASER, SPANNER, EXTINGUISHER].forEach((tool, i) => {
      if (k.pressed(`Digit${i + 1}`)) intent.selectTool = tool;
    });
    const wheel = k.wheel();
    if (wheel) intent.cycleTool = wheel > 0 ? 1 : -1;
    this.held.setTool(crew.inventory.current);
    intent.tip = this.held.tipWorld(tipTmp);
    return intent;
  }

  present(dt: number): void {
    const { ctx, crew, rig, input } = this;
    if (!ctx.me) return;
    crewEyes(ctx, crew, rig);
    const seated = crew.seat;
    this.seat.update(seated);
    // a console wants the mouse free; walking wants it back
    if ((seated !== null) === input.capturing) {
      input.setCapture(seated === null);
      if (seated === null) input.requestLock();
    }
    const up = ctx.me.state.mode === CrewMode.Up && seated === null && ctx.me.state.carry === Carry.Nothing;
    this.held.setTool(up ? crew.inventory.current : null);
    this.held.update(dt, up);
    ctx.hud.crew(ctx, crew, DESKTOP_KEYS);
  }

  jolt(amount: number, shielded: boolean): void {
    this.rig.shake(shielded ? 0.05 : Math.min(0.5, 0.1 + amount * 0.02));
    if (!shielded) this.rig.flash(0xff6a2a, Math.min(0.35, amount * 0.02));
  }

  moved(): void {}
  placed(): void {}

  hurt(): void {
    this.rig.flash(0x8a0000, 0.5);
    this.rig.shake(0.2);
    this.ctx.hud.hurt();
    this.ctx.sfx.play('hurt');
  }

  used(_side: Side | null, tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    usedSound(this.ctx, tool, effect);
    if (effect.hit && effect.hit !== 'miss') this.ctx.hud.hitMarker();
  }

  died(): void {}

  downed(): void {
    downedNews(this.ctx);
    this.rig.setTint(0x3a0000, 0.4);
  }

  revived(): void {
    this.rig.setTint(0, 0);
    this.ctx.hud.showBanner('BACK ON YOUR FEET', '#9fe0a8', 2000);
  }

  beamed(aboard: boolean): void {
    beamedNews(this.ctx, aboard);
    this.rig.flash(0x9ad8ff, 0.8);
  }

  seated(station: Station | null): void {
    if (station === null) this.seat.close();
  }

  fixed(kind: FaultKind): void {
    fixedNews(this.ctx, kind);
  }

  carrying(carry: Carry): void {
    if (carry === Carry.Relic) this.ctx.hud.showBanner('YOU HAVE THE RELIC', '#ffd35a', 2000);
  }

  restarted(): void {
    this.rig.setTint(0, 0);
    this.seat.close();
  }
}

export function usedSound(ctx: StarshipContext, tool: Tool<any>, effect: UseEffect): void {
  if (tool === PHASER) ctx.sfx.play('handPhaser');
  else if (tool === EXTINGUISHER && Math.random() < 0.4) ctx.sfx.play('spray', undefined, 0.6);
  else if (tool === SPANNER && effect.kick > 0) ctx.sfx.play('repair', undefined, 0.5);
}

export function downedNews(ctx: StarshipContext): void {
  ctx.hud.showBanner("YOU'RE HURT", '#ff5a4a', 2500);
  ctx.sfx.play('hurt');
}

export function beamedNews(ctx: StarshipContext, aboard: boolean): void {
  ctx.sfx.play('beam');
  const me = ctx.me;
  if (aboard || !me) ctx.hud.showBanner('ABOARD', '#9ad8ff', 1500);
  else ctx.hud.showBanner(ctx.sector.planets[ctx.deck.siteAt(me.state.x)].name.toUpperCase(), '#9ad8ff', 2500);
}

export function fixedNews(ctx: StarshipContext, kind: FaultKind): void {
  ctx.hud.message(kind === FaultKind.Fire ? 'Fire out' : 'Conduit fixed');
}

const TOUCH_KEYS: CrewKeys = { use: 'Tap ACT', fire: 'USE', tools: 'PHASER SPANNER EXTINGUISHER', bar: '' };

const BUTTONS: TouchButtonSpec[] = [
  { id: FIRE, label: 'USE', big: true },
  { id: 'act', label: 'ACT', hidden: true },
  { id: 'jump', label: 'JUMP' },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
];

/**
 * Crew on a phone. The left thumb walks, the right looks; USE works the tool in hand, picked from the strip; ACT shows
 * when there's something to take, load, pick up or sit at. At a console the station's panel takes the screen.
 */
export class TouchCrew implements CrewFrontend, Draws {
  readonly platform = Platform.Touch;
  readonly showSelf = false;
  private readonly intent = idleCrewIntent();
  private readonly controls: TouchControls;
  private readonly held: DesktopTool;
  private readonly seat: Seat;
  private standing = false;
  private suggest: Tool<any> | null = null;
  private suggested: Tool<any> | null = null;

  constructor(
    private readonly ctx: StarshipContext,
    private readonly crew: CrewRole,
    private readonly rig: Rig,
    chips: TouchChips,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.controls = new TouchControls({ buttons: BUTTONS, onChip: (id) => (id === 'menu' ? chips.menu() : chips.mic()), tuning: { ...TOUCH_TUNING, tapToFire: false } });
    this.seat = new Seat(ctx, chips, () => (this.standing = true));
    ctx.hud.message('Left thumb walks, right thumb looks. Pick a tool from the strip and hold USE.');
  }

  drawn(): Drawn {
    return { place: 'deck', camera: this.rig.camera, x: this.ctx.me?.state.x ?? 0 };
  }

  dispose(): void {
    this.controls.dispose();
    this.held.dispose();
    this.seat.close();
  }

  read(): CrewIntent {
    const { controls, intent, crew } = this;
    const t = controls.input;
    stillCrew(intent);
    if (this.standing) {
      intent.sit = true;
      this.standing = false;
    }
    this.seat.drain(intent.acts);
    if (this.ctx.settings.open || crew.seat !== null) {
      t.endFrame();
      return intent;
    }
    const [dx, dy] = t.consumeLook();
    intent.turn = dx * 0.0045;
    intent.lookUp = -dy * 0.0045;
    intent.strafe = t.stick.x;
    intent.forward = t.stick.y;
    intent.run = t.run;
    intent.jump = t.pressed('jump');
    intent.trigger = t.down(FIRE) || t.pressed(FIRE);
    intent.use = t.pressed('act');
    intent.sit = intent.use && crew.nearby?.kind === 'console';
    intent.selectTool = this.suggest;
    this.suggest = null;
    TOOLS.all.forEach((tool, i) => {
      if (t.pressed(`slot${i}`)) intent.selectTool = tool;
    });
    this.held.setTool(crew.inventory.current);
    intent.tip = this.held.tipWorld(tipTmp);
    t.endFrame();
    return intent;
  }

  present(dt: number): void {
    const { ctx, crew, rig, controls } = this;
    const me = ctx.me;
    if (!me) return;
    crewEyes(ctx, crew, rig);
    const seated = crew.seat;
    this.seat.update(seated);
    const up = me.state.mode === CrewMode.Up && seated === null;
    const hands = up && me.state.carry === Carry.Nothing;
    this.held.setTool(hands ? crew.inventory.current : null);
    this.held.update(dt, hands);
    ctx.hud.crew(ctx, crew, TOUCH_KEYS);
    controls.setActive(!ctx.settings.open && seated === null);
    controls.setVisible(FIRE, hands);
    controls.setLabel(FIRE, crew.inventory.current === PHASER ? 'FIRE' : crew.inventory.current === EXTINGUISHER ? 'SPRAY' : 'FIX');
    const n = crew.nearby;
    const carrying = me.state.carry !== Carry.Nothing;
    controls.setVisible('act', up && (!!n || carrying));
    controls.setLabel('act', n?.kind === 'console' ? 'SIT' : n?.kind === 'tube' ? 'LOAD' : n?.kind === 'rack' ? (carrying ? 'PUT BACK' : 'TAKE') : n?.kind === 'relic' ? 'TAKE' : 'DROP');
    controls.setSlots(hands ? TOOLS.all.map((tool) => ({ name: tool.name, charges: Infinity, current: tool === crew.inventory.current })) : []);
    // the tool that'd help most comes out on its own as you get somewhere it's needed, since the strip is small
    const suggested = hands ? crew.suggestedTool() : null;
    if (suggested !== this.suggested) {
      this.suggested = suggested;
      if (suggested && suggested !== crew.inventory.current && !controls.input.down(FIRE)) this.suggest = suggested;
    }
  }

  jolt(amount: number, shielded: boolean): void {
    this.rig.shake(shielded ? 0.05 : Math.min(0.5, 0.1 + amount * 0.02));
    navigator.vibrate?.(shielded ? 20 : 80);
  }

  moved(): void {}
  placed(): void {}

  hurt(): void {
    this.rig.flash(0x8a0000, 0.5);
    this.ctx.hud.hurt();
    this.ctx.sfx.play('hurt');
    navigator.vibrate?.(90);
  }

  used(_side: Side | null, tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    usedSound(this.ctx, tool, effect);
  }

  died(): void {}

  downed(): void {
    downedNews(this.ctx);
    this.rig.setTint(0x3a0000, 0.4);
    navigator.vibrate?.([120, 60, 120]);
  }

  revived(): void {
    this.rig.setTint(0, 0);
  }

  beamed(aboard: boolean): void {
    beamedNews(this.ctx, aboard);
    this.rig.flash(0x9ad8ff, 0.8);
  }

  seated(station: Station | null): void {
    if (station === null) this.seat.close();
  }

  fixed(kind: FaultKind): void {
    fixedNews(this.ctx, kind);
    navigator.vibrate?.(30);
  }

  carrying(carry: Carry): void {
    if (carry === Carry.Relic) this.ctx.hud.showBanner('YOU HAVE THE RELIC', '#ffd35a', 2000);
  }

  restarted(): void {
    this.rig.setTint(0, 0);
    this.seat.close();
  }
}
