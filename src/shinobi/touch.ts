import { DesktopTool } from '../crossplay/desktopTool';
import type { Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { TouchChips } from '../crossplay/shell';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FIRE, TOUCH_TUNING } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import type { ShinobiContext, ShinobiEntity, Vec3 } from './context';
import { GuardKind, Shinobi, ShinobiMode } from './defs';
import { Spectator, downedNews, escapedNews, firstPerson, hurtFlash, landedNews, takenNews, tookDownNews, watchGuards } from './desktop';
import type { ShinobiKeys } from './hud';
import { idleShinobiIntent, stillShinobi, type ShinobiIntent } from './intent';
import { TANTO, TOOLS, type NinjaTool } from './kit';
import { HELP_REACH, type ShinobiFrontend, type ShinobiRole } from './shinobi';

const LOOK = 0.0045;

const BUTTONS: TouchButtonSpec[] = [
  { id: FIRE, label: 'STRIKE', big: true },
  { id: 'climb', label: 'JUMP' },
  { id: 'creep', label: 'CREEP' },
  { id: 'help', label: 'HELP UP', hidden: true },
  { id: 'watch', label: 'NEXT', hidden: true },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
];

const KEYS: ShinobiKeys = { climb: 'Hold CLIMB', use: 'Tap STRIKE', help: 'Hold HELP UP', bar: '' };

/**
 * A phone or tablet. The left thumb walks (push to the edge to run) and the right drags the view. The big button strikes
 * with the tanto or throws what's in hand, picked from the strip; CLIMB, held facing a wall, climbs it, and jumps
 * otherwise. CREEP toggles creeping, and HELP UP shows by someone who's down. Buzzes when you're struck or spotted.
 */
export class TouchShinobi implements ShinobiFrontend {
  readonly platform = Platform.Touch;
  private readonly intent = idleShinobiIntent();
  private readonly controls: TouchControls;
  private readonly held: DesktopTool;
  private readonly spectator: Spectator;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly watch = { hunted: 0 };
  private creeping = false;

  constructor(
    private readonly ctx: ShinobiContext,
    private readonly sim: ShinobiRole,
    private readonly rig: Rig,
    private readonly chips: TouchChips,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.spectator = new Spectator(ctx, rig);
    this.controls = new TouchControls({ buttons: BUTTONS, onChip: (id) => this.chip(id), tuning: { ...TOUCH_TUNING, tapToFire: false } });
    ctx.hud.message('Left thumb walks, right thumb looks. Hold CLIMB facing a wall to climb it.');
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

  read(): ShinobiIntent {
    const { controls, intent, sim } = this;
    const t = controls.input;
    stillShinobi(intent);
    if (this.ctx.settings.open) {
      t.endFrame();
      return intent;
    }
    const [dx, dy] = t.consumeLook();
    if (sim.mode === ShinobiMode.Dead || sim.mode === ShinobiMode.Escaped) {
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
    intent.climb = t.down('climb');
    intent.jump = t.pressed('climb') && !sim.wallAhead;
    intent.trigger = t.down(FIRE) || t.pressed(FIRE);
    intent.interact = t.down('help');
    TOOLS.all.forEach((tool, i) => {
      if (t.pressed(`slot${i}`)) intent.selectTool = tool;
    });
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    t.endFrame();
    return intent;
  }

  present(dt: number): void {
    const { ctx, sim, rig, controls } = this;
    const me = ctx.me;
    if (!me) return;
    const out = sim.mode === ShinobiMode.Dead || sim.mode === ShinobiMode.Escaped;
    this.spectator.watching = out;
    if (out) this.spectator.update(dt);
    else firstPerson(ctx, sim, rig);
    this.held.setTool(out ? null : sim.inventory.current);
    this.held.update(dt, !out && sim.mode !== ShinobiMode.Downed && !sim.climbing);
    ctx.hud.showShinobi(ctx, sim, KEYS);
    watchGuards(ctx, this.watch, rig, () => navigator.vibrate?.([60, 40, 60]));

    controls.setActive(!ctx.settings.open);
    const alive = sim.mode === ShinobiMode.Alive;
    const current = sim.inventory.current;
    controls.setVisible(FIRE, alive);
    controls.setLabel(FIRE, current === TANTO || !current ? 'STRIKE' : 'THROW');
    controls.setVisible('climb', alive);
    controls.setLabel('climb', sim.climbing ? 'UP' : sim.wallAhead ? 'CLIMB' : 'JUMP');
    controls.setVisible('creep', alive);
    controls.setLabel('creep', this.creeping ? 'CREEP ✓' : 'CREEP');
    controls.setVisible('help', alive && !!downedNear(ctx));
    controls.setVisible('watch', out);
    controls.setSlots(alive ? TOOLS.all.filter((tool) => sim.inventory.has(tool)).map((tool) => ({ name: tool.name, charges: sim.inventory.charges(tool), current: tool === current })) : []);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {
    hurtFlash(this.ctx, this.rig);
    navigator.vibrate?.(90);
  }

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    if (effect.hit && effect.hit !== 'miss') navigator.vibrate?.(25);
  }

  died(): void {
    this.rig.setTint(0, 0);
    takenNews(this.ctx);
    navigator.vibrate?.([200, 100, 300]);
  }

  climbed(over: boolean): void {
    this.ctx.sfx.play('grip', undefined, over ? 0.6 : 1);
    navigator.vibrate?.(12);
  }

  gripped(): void {}

  landed(hard: boolean): void {
    landedNews(this.ctx, this.rig, hard);
    if (hard) navigator.vibrate?.(40);
  }

  tookDown(kind: GuardKind): void {
    tookDownNews(this.ctx, kind);
    navigator.vibrate?.(30);
  }

  picked(tool: NinjaTool): void {
    this.ctx.hud.message(`Picked up a ${tool.name.toLowerCase()}`);
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

  restarted(): void {
    this.rig.setTint(0, 0);
    this.creeping = false;
  }
}

/** A downed shinobi within reach to help up. */
export function downedNear(ctx: ShinobiContext): ShinobiEntity | null {
  const s = ctx.me?.state;
  if (!s) return null;
  for (const sv of ctx.world.query(s.x, s.y, HELP_REACH, Shinobi) as ShinobiEntity[]) if (sv !== ctx.me && sv.render.mode === ShinobiMode.Downed) return sv;
  return null;
}
