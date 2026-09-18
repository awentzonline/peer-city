import { DesktopTool } from '../crossplay/desktopTool';
import { stillIntent, type Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { TouchChips } from '../crossplay/shell';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FIRE, TOUCH_TUNING } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import type { HauntContext, SurvivorEntity, Vec3 } from './context';
import { Survivor, SurvivorMode } from './defs';
import { Spectator, diedNews, downedNews, escapedNews, firstPerson, heartbeat, hurtFlash, lightSound, snuffedNews } from './desktop';
import type { SurvivorKeys } from './hud';
import { idleSurvivorIntent, type SurvivorIntent } from './intent';
import { HELP_REACH, type SurvivorFrontend, type SurvivorRole } from './survivor';

/** Radians of view per pixel dragged. */
const LOOK = 0.0045;

const BUTTONS: TouchButtonSpec[] = [
  { id: FIRE, label: 'LIGHT', big: true },
  { id: 'help', label: 'HELP UP', hidden: true },
  { id: 'creep', label: 'CREEP' },
  { id: 'watch', label: 'NEXT', hidden: true },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
];

const KEYS: SurvivorKeys = { light: 'Tap LIGHT', help: 'Hold HELP UP', bar: '' };

/**
 * A phone or tablet. The left thumb walks (push to the edge to run) and the right drags the view. LIGHT switches the
 * flashlight, and a tap on the screen doesn't, so looking round never switches it by accident. CREEP toggles
 * creeping, and HELP UP shows by someone who's down, to hold. Buzzes when you're struck.
 */
export class TouchSurvivor implements SurvivorFrontend {
  readonly platform = Platform.Touch;
  private readonly intent = idleSurvivorIntent();
  private readonly controls: TouchControls;
  private readonly held: DesktopTool;
  private readonly spectator: Spectator;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly heart = { next: 0 };
  private creeping = false;

  constructor(
    private readonly ctx: HauntContext,
    private readonly sim: SurvivorRole,
    private readonly rig: Rig,
    private readonly chips: TouchChips,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.spectator = new Spectator(ctx, rig);
    this.controls = new TouchControls({ buttons: BUTTONS, onChip: (id) => this.chip(id), tuning: { ...TOUCH_TUNING, tapToFire: false } });
    ctx.hud.message('Left thumb walks, right thumb looks. LIGHT switches your flashlight.');
  }

  get showSelf(): boolean {
    return this.spectator.watching;
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
  read(): SurvivorIntent {
    const { controls, intent, sim } = this;
    const t = controls.input;
    stillIntent(intent);
    if (this.ctx.settings.open) {
      t.endFrame();
      return intent;
    }
    const [dx, dy] = t.consumeLook();
    if (sim.mode === SurvivorMode.Dead) {
      if (t.pressed('watch')) this.spectator.next();
      this.spectator.look(dx * LOOK, -dy * LOOK);
      t.endFrame();
      return intent;
    }
    intent.turn = dx * LOOK;
    intent.lookUp = -dy * LOOK;
    intent.strafe = t.stick.x;
    intent.forward = t.stick.y;
    intent.run = t.run && !this.creeping;
    if (t.pressed('creep')) this.creeping = !this.creeping;
    intent.crouch = this.creeping;
    // a quick tap can come and go between frames: the press still counts
    intent.trigger = t.down(FIRE) || t.pressed(FIRE);
    intent.interact = t.down('help');
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    t.endFrame();
    return intent;
  }

  present(dt: number): void {
    const { ctx, sim, rig, controls } = this;
    const me = ctx.me;
    if (!me) return;
    const dead = sim.mode === SurvivorMode.Dead;
    this.spectator.watching = dead;
    if (dead) this.spectator.update(dt);
    else firstPerson(ctx, sim, rig);
    this.held.setTool(dead || sim.mode === SurvivorMode.Escaped ? null : sim.inventory.current);
    this.held.update(dt, !dead && sim.mode !== SurvivorMode.Downed);
    ctx.hud.showSurvivor(ctx, sim, KEYS);
    heartbeat(ctx, this.heart);

    controls.setActive(!ctx.settings.open);
    const alive = sim.mode === SurvivorMode.Alive;
    controls.setVisible(FIRE, alive || sim.mode === SurvivorMode.Downed);
    controls.setLabel(FIRE, me.state.light ? 'LIGHT ✓' : 'LIGHT');
    controls.setVisible('creep', alive);
    controls.setLabel('creep', this.creeping ? 'CREEP ✓' : 'CREEP');
    controls.setVisible('help', alive && !!downedNear(ctx));
    controls.setVisible('watch', dead);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {
    hurtFlash(this.ctx, this.rig);
    navigator.vibrate?.(90);
  }

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
  }

  died(): void {
    this.rig.setTint(0, 0);
    diedNews(this.ctx);
    navigator.vibrate?.([200, 100, 300]);
  }

  lit(_on: boolean, flat: boolean): void {
    lightSound(this.ctx, flat);
    navigator.vibrate?.(8);
  }

  snuffed(): void {
    snuffedNews(this.ctx);
    navigator.vibrate?.([40, 40, 40]);
  }

  downed(): void {
    downedNews(this.ctx, this.rig);
    navigator.vibrate?.([120, 60, 120]);
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
    navigator.vibrate?.(30);
  }

  placedKey(): void {
    navigator.vibrate?.([30, 40, 30]);
  }

  restarted(): void {
    this.rig.setTint(0, 0);
    this.creeping = false;
  }
}

/** A downed survivor within reach to help up. */
export function downedNear(ctx: HauntContext): SurvivorEntity | null {
  const s = ctx.me?.state;
  if (!s) return null;
  for (const sv of ctx.world.query(s.x, s.y, HELP_REACH, Survivor) as SurvivorEntity[]) if (sv !== ctx.me && sv.render.mode === SurvivorMode.Downed) return sv;
  return null;
}
