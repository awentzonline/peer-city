import { DesktopTool } from '../crossplay/desktopTool';
import type { Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { TouchChips } from '../crossplay/shell';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FIRE, TOUCH_TUNING } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import type { SewerContext, Vec3 } from './context';
import { LordMode, type LootKind } from './defs';
import {
  Beeper,
  Spectator,
  bankedNews,
  chokeNews,
  diedNews,
  downedNews,
  dugNews,
  firstPerson,
  hurtFlash,
  pumpSound,
  sackFullNews,
  sputterNews,
  surfacedNews,
  toreNews,
  underwater,
  wadingSound,
  watching,
} from './desktop';
import type { LordKeys } from './hud';
import { idleLordIntent, stillLord, type LordIntent } from './intent';
import { HOSE } from './kit';
import type { LordFrontend, LordRole } from './lord';

/** Radians of view per pixel dragged. */
const LOOK = 0.0045;

const BUTTONS: TouchButtonSpec[] = [
  { id: FIRE, label: 'PUNCH', big: true },
  { id: 'grab', label: 'GRAB', hint: 'hold to use' },
  { id: 'pump', label: 'PUMP', hidden: true },
  { id: 'tear', label: 'TEAR', hidden: true },
  { id: 'tool', label: 'TOOL' },
  { id: 'watch', label: 'NEXT', hidden: true },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
];

const KEYS: LordKeys = { interact: 'Hold GRAB', pump: 'Tap PUMP', grab: 'GRAB', hold: 'PUNCH throws it · hold TEAR to rip it in half · GRAB drops it', bar: '' };

/**
 * A phone or tablet. The left thumb wades (push to the edge to run) and the right drags the view. PUNCH punches (hold
 * to wind up), or uses the tool in hand; GRAB grabs a goblin, and held, does what's at hand; TOOL goes round fists,
 * detector and hose; PUMP builds the hose's pressure. With a goblin in hand, PUNCH throws it and TEAR rips it apart.
 */
export class TouchLord implements LordFrontend {
  readonly platform = Platform.Touch;
  private readonly intent = idleLordIntent();
  private readonly controls: TouchControls;
  private readonly held: DesktopTool;
  private readonly spectator: Spectator;
  private readonly beeper = new Beeper();
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private nextStep = 0;

  constructor(
    private readonly ctx: SewerContext,
    private readonly lord: LordRole,
    private readonly rig: Rig,
    private readonly chips: TouchChips,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.spectator = new Spectator(ctx, rig);
    this.controls = new TouchControls({ buttons: BUTTONS, onChip: (id) => this.chip(id), tuning: { ...TOUCH_TUNING, tapToFire: false } });
    ctx.hud.message('Left thumb wades, right thumb looks. PUNCH the goblins, TOOL for the detector and hose.');
  }

  get showSelf(): boolean {
    return this.spectator.watching;
  }

  nozzle(out: Vec3): Vec3 | null {
    return this.held.tool === HOSE ? this.held.tipWorld(out) : null;
  }

  dispose(): void {
    this.controls.dispose();
    this.held.dispose();
  }

  private chip(id: string): void {
    if (id === 'menu') this.chips.menu();
    else if (id === 'mic') this.chips.mic();
  }

  /** Every press is read here, in one place, because `read` ends the input's frame. */
  read(): LordIntent {
    const { controls, intent, lord } = this;
    const t = controls.input;
    stillLord(intent);
    if (this.ctx.settings.open) {
      t.endFrame();
      return intent;
    }
    const [dx, dy] = t.consumeLook();
    if (watching(lord)) {
      if (t.pressed('watch')) this.spectator.next();
      this.spectator.look(dx * LOOK, -dy * LOOK);
      t.endFrame();
      return intent;
    }
    intent.turn = dx * LOOK;
    intent.lookUp = -dy * LOOK;
    intent.strafe = t.stick.x;
    intent.forward = t.stick.y;
    intent.run = t.run;
    intent.trigger = t.down(FIRE) || t.pressed(FIRE);
    intent.grab = t.pressed('grab');
    intent.interact = t.down('grab');
    intent.tear = t.down('tear');
    intent.pump = t.down('pump') || t.pressed('pump') ? 0 : 1;
    if (t.pressed('tool')) intent.cycleTool = 1;
    this.held.setTool(lord.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    t.endFrame();
    return intent;
  }

  present(dt: number): void {
    const { ctx, lord, rig, controls } = this;
    const me = ctx.me;
    if (!me) return;
    const away = watching(lord);
    this.spectator.watching = away;
    if (away) this.spectator.update(dt);
    else firstPerson(ctx, lord, rig);
    const active = lord.mode === LordMode.Active;
    const tool = active ? lord.inventory.current : null;
    this.held.setTool(tool);
    this.held.update(dt, active && !!tool);
    ctx.hud.showLord(ctx, lord, KEYS);
    this.beeper.update(ctx, lord);
    underwater(ctx, lord, rig);
    this.nextStep = wadingSound(ctx, lord, this.nextStep);

    controls.setActive(!ctx.settings.open);
    const holding = !!me.state.holding;
    controls.setVisible(FIRE, active);
    controls.setLabel(FIRE, holding ? 'THROW' : tool === HOSE ? 'SPRAY' : tool ? 'USE' : 'PUNCH');
    controls.setVisible('grab', active);
    controls.setLabel('grab', holding ? 'DROP' : 'GRAB', holding ? '' : 'hold to use');
    controls.setVisible('pump', active && tool === HOSE);
    controls.setLabel('pump', `PUMP ${Math.round(lord.charge)}%`);
    controls.setVisible('tear', active && holding);
    controls.setVisible('tool', active && !holding);
    controls.setLabel('tool', tool === HOSE ? 'HOSE' : tool ? 'DETECTOR' : 'FISTS');
    controls.setVisible('watch', away);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {
    hurtFlash(this.ctx, this.rig);
    navigator.vibrate?.(80);
  }

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
  }

  died(): void {
    this.rig.setTint(0, 0);
    diedNews(this.ctx);
    navigator.vibrate?.([200, 100, 300]);
  }

  punched(force: number, landed: boolean): void {
    this.ctx.sfx.play(landed ? 'thump' : 'whoosh', undefined, landed ? 0.4 : 0.8);
    if (landed) navigator.vibrate?.(20 + force * 30);
  }

  grabbed(what: 'goblin' | 'loot' | 'valve'): void {
    if (what === 'goblin') navigator.vibrate?.(30);
  }

  tore(): void {
    toreNews(this.ctx);
    navigator.vibrate?.([60, 30, 120]);
  }

  pumped(charge: number): void {
    pumpSound(this.ctx, charge);
    navigator.vibrate?.(10);
  }

  sputtered(): void {
    sputterNews(this.ctx);
  }

  dug(kind: LootKind): void {
    dugNews(this.ctx, kind);
    navigator.vibrate?.(30);
  }

  banked(worth: number, count: number): void {
    bankedNews(this.ctx, worth, count);
  }

  sackFull(): void {
    sackFullNews(this.ctx);
  }

  choking(): void {
    chokeNews(this.ctx, this.rig);
    navigator.vibrate?.(60);
  }

  downed(): void {
    downedNews(this.ctx, this.rig);
    navigator.vibrate?.([120, 60, 120]);
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
