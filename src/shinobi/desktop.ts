import { DesktopTool } from '../crossplay/desktopTool';
import { MOUSE_SENSITIVITY, readWalking } from '../crossplay/desktopControls';
import type { DesktopInput } from '../crossplay/input';
import type { Side } from '../crossplay/intent';
import { direction } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import type { ShinobiContext, ShinobiEntity, Vec3 } from './context';
import { Alert, Guard, GuardKind, GuardMode, Shinobi, ShinobiMode } from './defs';
import type { ShinobiKeys } from './hud';
import { idleShinobiIntent, stillShinobi, type ShinobiIntent } from './intent';
import { KUNAI, SHURIKEN, TANTO, type NinjaTool } from './kit';
import type { ShinobiFrontend, ShinobiRole } from './shinobi';

const KEYS: ShinobiKeys = {
  climb: 'Hold Space',
  use: 'Click',
  help: 'Hold E',
  bar: '<b>WASD</b> move · <b>Shift</b> run · <b>Ctrl</b> creep · <b>Space</b> jump, hold to climb · <b>Click</b> strike / throw · <b>1 2 3</b> tanto, kunai, shuriken · <b>Hold E</b> help up · <b>Esc</b> settings · <b>V</b> mic',
};
const DEAD_KEYS: ShinobiKeys = { ...KEYS, bar: '<b>Click</b> watch someone else · <b>Esc</b> settings · <b>V</b> mic' };

const SLOTS: NinjaTool[] = [TANTO, KUNAI, SHURIKEN];

/**
 * Keyboard and mouse, first person. WASD moves, Shift runs and Ctrl creeps; Space jumps, and held facing a wall climbs
 * it. Click strikes with the tanto or throws a kunai or shuriken, picked with 1-3 or the wheel. Once the watch has you,
 * the camera follows whoever's left.
 */
export class DesktopShinobi implements ShinobiFrontend {
  readonly platform = Platform.Desktop;
  private readonly intent = idleShinobiIntent();
  private readonly held: DesktopTool;
  private readonly spectator: Spectator;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly watch = { hunted: 0 };

  constructor(
    private readonly ctx: ShinobiContext,
    private readonly sim: ShinobiRole,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.spectator = new Spectator(ctx, rig);
  }

  get showSelf(): boolean {
    return this.spectator.watching;
  }

  dispose(): void {
    this.held.dispose();
  }

  read(): ShinobiIntent {
    const { input: k, intent, sim } = this;
    const [dx, dy] = k.consumeMouse();
    stillShinobi(intent);
    if (this.ctx.settings.open) return intent;
    if (sim.mode === ShinobiMode.Dead || sim.mode === ShinobiMode.Escaped) {
      if (k.pressed('Mouse0')) this.spectator.next();
      this.spectator.look(dx * MOUSE_SENSITIVITY, -dy * MOUSE_SENSITIVITY);
      return intent;
    }
    intent.turn = dx * MOUSE_SENSITIVITY;
    intent.lookUp = -dy * MOUSE_SENSITIVITY;
    readWalking(k, intent);
    intent.climb = k.down('Space');
    intent.crouch = k.down('ControlLeft') || k.down('KeyC');
    intent.interact = k.down('KeyE');
    intent.trigger = k.locked && k.mouse(0);
    SLOTS.forEach((tool, i) => {
      if (k.pressed(`Digit${i + 1}`)) intent.selectTool = tool;
    });
    const wheel = k.wheel();
    if (wheel) intent.cycleTool = wheel > 0 ? 1 : -1;
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    return intent;
  }

  present(dt: number): void {
    const { ctx, sim, rig } = this;
    if (!ctx.me) return;
    const out = sim.mode === ShinobiMode.Dead || sim.mode === ShinobiMode.Escaped;
    this.spectator.watching = out;
    if (out) this.spectator.update(dt);
    else firstPerson(ctx, sim, rig);
    this.held.setTool(out ? null : sim.inventory.current);
    this.held.update(dt, !out && sim.mode !== ShinobiMode.Downed && !sim.climbing);
    ctx.hud.showShinobi(ctx, sim, sim.mode === ShinobiMode.Dead ? DEAD_KEYS : KEYS);
    watchGuards(ctx, this.watch, rig);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {
    hurtFlash(this.ctx, this.rig);
  }

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    if (effect.hit && effect.hit !== 'miss') this.ctx.hud.hitMarker();
  }

  died(): void {
    this.rig.setTint(0, 0);
    takenNews(this.ctx);
  }

  climbed(over: boolean): void {
    this.ctx.sfx.play('grip', undefined, over ? 0.6 : 1);
  }

  gripped(): void {}

  landed(hard: boolean): void {
    landedNews(this.ctx, this.rig, hard);
  }

  tookDown(kind: GuardKind): void {
    tookDownNews(this.ctx, kind);
  }

  picked(tool: NinjaTool): void {
    this.ctx.hud.message(`Picked up a ${tool.name.toLowerCase()}`);
  }

  downed(): void {
    downedNews(this.ctx, this.rig);
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
    this.ctx.hud.message('A new night falls. Your kit is full again.');
  }
}

/** A screen's first-person view from the shinobi's eyes, and the ears with it. */
export function firstPerson(ctx: ShinobiContext, sim: ShinobiRole, rig: Rig): void {
  const eye = sim.eyePosition(eyeTmp);
  rig.setDesktopView(eye.x, eye.y, eye.z, sim.heading, sim.pitch);
  ctx.sfx.setListener(eye, direction(sim.heading, sim.pitch, dirTmp));
}

const eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
const dirTmp: Vec3 = { x: 0, y: 0, z: 0 };

/** A sting and a banner when a guard raises the alarm on you, and your heart pounding while they hunt you. */
export function watchGuards(ctx: ShinobiContext, state: { hunted: number }, rig: Rig | null, buzz?: () => void): void {
  const me = ctx.me;
  if (!me || me.state.mode !== ShinobiMode.Alive) {
    state.hunted = 0;
    return;
  }
  let hunted = 0;
  for (const g of ctx.world.query(me.x, me.y, 40, Guard)) {
    const s = g.render;
    if (s.mode !== GuardMode.Dead && s.alert === Alert.Alarmed && s.target === me.id) hunted++;
  }
  if (hunted > state.hunted) {
    ctx.sfx.play('spotted');
    ctx.hud.showBanner('SPOTTED!', '#ff5a4a', 1200);
    rig?.flash(0x5a0000, 0.25);
    buzz?.();
  }
  state.hunted = hunted;
}

export function hurtFlash(ctx: ShinobiContext, rig: Rig): void {
  rig.flash(0x8a0000, 0.6);
  rig.shake(0.3);
  ctx.hud.hurt();
  ctx.sfx.play('hurt');
}

export function landedNews(ctx: ShinobiContext, rig: Rig, hard: boolean): void {
  if (!hard) return;
  rig.shake(0.2);
  ctx.hud.message('A heavy landing. Land crouching to make less noise.');
}

export function tookDownNews(ctx: ShinobiContext, kind: GuardKind): void {
  ctx.sfx.play('takedown');
  if (kind === GuardKind.Lord) ctx.hud.showBanner('THE LORD IS DEAD', '#ffd35a', 3000);
  else ctx.hud.message(kind === GuardKind.Samurai ? 'A samurai falls' : kind === GuardKind.Archer ? 'An archer falls' : 'A guard falls');
}

export function downedNews(ctx: ShinobiContext, rig: Rig): void {
  rig.flash(0x5a0000, 0.8);
  rig.setTint(0x3a0000, 0.25);
  ctx.hud.showBanner("YOU'RE DOWN", '#ff5a4a', 2500);
}

export function takenNews(ctx: ShinobiContext): void {
  ctx.hud.showBanner('TAKEN BY THE WATCH', '#b04a4a', 3500);
  ctx.sfx.play('defeat', undefined, 0.8);
}

export function escapedNews(ctx: ShinobiContext): void {
  ctx.hud.showBanner('AWAY OVER THE WALL', '#9fe0a8', 3500);
  ctx.sfx.play('escape');
}

/**
 * Watching the others once you're out of the night: the camera follows behind a shinobi still inside, and moves on to
 * the next one when asked, or when they're gone too.
 */
export class Spectator {
  watching = false;
  private target: ShinobiEntity | null = null;
  private orbit = 0;
  private pitch = 0.35;
  private readonly from: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private ready = false;

  constructor(
    private readonly ctx: ShinobiContext,
    private readonly rig: Rig,
  ) {}

  next(): void {
    const others = this.candidates();
    if (!others.length) return;
    const i = this.target ? others.indexOf(this.target) : -1;
    this.target = others[(i + 1) % others.length];
    this.ready = false;
  }

  look(right: number, up: number): void {
    this.orbit -= right;
    this.pitch = Math.min(1.2, Math.max(-0.2, this.pitch - up));
  }

  update(dt: number): void {
    const { ctx } = this;
    if (!this.target?.alive || !this.candidates().includes(this.target)) {
      this.target = null;
      this.next();
    }
    const who = this.target ?? ctx.me;
    if (!who) return;
    const s = who.render;
    const back = s.yaw + Math.PI + this.orbit;
    const dist = 3.4;
    const base = s.z + 1.2;
    const tx = who.x + Math.cos(back) * Math.cos(this.pitch) * dist;
    const ty = who.y + Math.sin(back) * Math.cos(this.pitch) * dist;
    const tz = base + Math.sin(this.pitch) * dist;
    const p = { x: who.x, y: who.y };
    ctx.castle.move(p, tx - who.x, ty - who.y, 0.2, s.z + 1);
    const k = this.ready ? Math.min(1, dt * 6) : 1;
    this.ready = true;
    this.from.x += (p.x - this.from.x) * k;
    this.from.y += (p.y - this.from.y) * k;
    this.from.z += (tz - this.from.z) * k;
    this.at.x = who.x;
    this.at.y = who.y;
    this.at.z = base;
    this.rig.setDesktopChase(this.from, this.at);
    ctx.sfx.setListener(this.at, { x: Math.cos(back + Math.PI), y: Math.sin(back + Math.PI), z: 0 });
  }

  private candidates(): ShinobiEntity[] {
    const out: ShinobiEntity[] = [];
    for (const sv of this.ctx.world.all(Shinobi) as ReadonlySet<ShinobiEntity>) {
      const m = sv.render.mode;
      if (sv !== this.ctx.me && (m === ShinobiMode.Alive || m === ShinobiMode.Downed)) out.push(sv);
    }
    return out;
  }
}
