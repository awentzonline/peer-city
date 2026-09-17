import { DesktopTool } from '../crossplay/desktopTool';
import { MOUSE_SENSITIVITY, readWalking } from '../crossplay/desktopControls';
import type { DesktopInput } from '../crossplay/input';
import { stillIntent, type Side } from '../crossplay/intent';
import { direction } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import type { HauntContext, SurvivorEntity, Vec3 } from './context';
import { Monster, MonsterMode, Survivor, SurvivorMode } from './defs';
import type { SurvivorKeys } from './hud';
import { idleSurvivorIntent, type SurvivorIntent } from './intent';
import type { SurvivorFrontend, SurvivorRole } from './survivor';

const KEYS: SurvivorKeys = {
  light: 'Click',
  help: 'Hold E',
  bar: '<b>WASD</b> walk · <b>Shift</b> run · <b>Ctrl</b> creep · <b>Click</b> or <b>F</b> flashlight · <b>Hold E</b> help someone up · <b>Esc</b> settings · <b>V</b> mic',
};
const DEAD_KEYS: SurvivorKeys = { ...KEYS, bar: '<b>Click</b> watch someone else · <b>Esc</b> settings · <b>V</b> mic' };

/**
 * Keyboard and mouse, first person in the dark with a flashlight in hand. Click (or F) switches it on and off, holding E
 * over someone who's down helps them up, and keys go in your pocket and into the pedestal as you walk over them. Once
 * the house has you, the camera follows whoever's left.
 */
export class DesktopSurvivor implements SurvivorFrontend {
  readonly platform = Platform.Desktop;
  private readonly intent = idleSurvivorIntent();
  private readonly held: DesktopTool;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly spectator: Spectator;
  private readonly heart = { next: 0 };

  constructor(
    private readonly ctx: HauntContext,
    private readonly sim: SurvivorRole,
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

  read(): SurvivorIntent {
    const { input: k, intent, sim } = this;
    const [dx, dy] = k.consumeMouse();
    stillIntent(intent);
    if (this.ctx.settings.open) return intent;
    if (sim.mode === SurvivorMode.Dead) {
      if (k.pressed('Mouse0')) this.spectator.next();
      this.spectator.look(dx * MOUSE_SENSITIVITY, -dy * MOUSE_SENSITIVITY);
      return intent;
    }
    intent.turn = dx * MOUSE_SENSITIVITY;
    intent.lookUp = -dy * MOUSE_SENSITIVITY;
    readWalking(k, intent);
    intent.crouch = k.down('ControlLeft') || k.down('KeyC');
    intent.interact = k.down('KeyE');
    intent.trigger = k.locked && (k.mouse(0) || k.down('KeyF'));
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    return intent;
  }

  present(dt: number): void {
    const { ctx, sim, rig } = this;
    const me = ctx.me;
    if (!me) return;
    const dead = sim.mode === SurvivorMode.Dead;
    this.spectator.watching = dead;
    if (dead) this.spectator.update(dt);
    else firstPerson(ctx, sim, rig);
    this.held.setTool(dead || sim.mode === SurvivorMode.Escaped ? null : sim.inventory.current);
    this.held.update(dt, !dead && sim.mode !== SurvivorMode.Downed);
    ctx.hud.showSurvivor(ctx, sim, dead ? DEAD_KEYS : KEYS);
    heartbeat(ctx, this.heart);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {
    hurtFlash(this.ctx, this.rig);
  }

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
  }

  died(): void {
    this.rig.setTint(0, 0);
    diedNews(this.ctx);
  }

  lit(_on: boolean, flat: boolean): void {
    lightSound(this.ctx, flat);
  }

  snuffed(): void {
    snuffedNews(this.ctx);
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

  gotKey(): void {
    this.ctx.hud.showBanner('A KEY', '#ffd35a', 1800);
  }

  placedKey(): void {}

  restarted(): void {
    this.rig.setTint(0, 0);
    this.ctx.hud.message('A new night. The gate has shut behind you.');
  }
}

/** A screen's first-person view from the survivor's eyes, and the ears with it. */
export function firstPerson(ctx: HauntContext, sim: SurvivorRole, rig: Rig): void {
  const eye = sim.eyePosition(eyeTmp);
  rig.setDesktopView(eye.x, eye.y, eye.z, sim.heading, sim.pitch);
  ctx.sfx.setListener(eye, direction(sim.heading, sim.pitch, dirTmp));
}

const eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
const dirTmp: Vec3 = { x: 0, y: 0, z: 0 };

/** Your heart pounds when something's close. */
export function heartbeat(ctx: HauntContext, state: { next: number }): void {
  const s = ctx.me?.state;
  if (!s || s.mode === SurvivorMode.Dead || s.mode === SurvivorMode.Escaped || ctx.now < state.next) return;
  let near = Infinity;
  for (const m of ctx.world.query(s.x, s.y, 11, Monster)) if (m.render.mode !== MonsterMode.Dead) near = Math.min(near, Math.hypot(m.x - s.x, m.y - s.y));
  if (near === Infinity) return;
  ctx.sfx.play('heartbeat', undefined, Math.min(1, 1.3 - near / 11));
  state.next = ctx.now + 380 + near * 70;
}

export function hurtFlash(ctx: HauntContext, rig: Rig): void {
  rig.flash(0x8a0000, 0.6);
  rig.shake(0.3);
  ctx.hud.hurt();
  ctx.sfx.play('hurt');
}

export function lightSound(ctx: HauntContext, flat: boolean): void {
  ctx.sfx.play(flat ? 'flat' : 'click');
  if (flat) ctx.hud.message('The flashlight is flat. Let the battery rest a moment.');
}

export function snuffedNews(ctx: HauntContext): void {
  ctx.sfx.play('flat');
  ctx.hud.message('Something whispers close by, and your light dies.');
}

export function downedNews(ctx: HauntContext, rig: Rig): void {
  rig.flash(0x5a0000, 0.8);
  rig.setTint(0x3a0000, 0.25);
  ctx.hud.showBanner("YOU'RE DOWN", '#ff5a4a', 2500);
}

export function diedNews(ctx: HauntContext): void {
  ctx.hud.showBanner('THE HOUSE HAS YOU', '#b04a4a', 3500);
  ctx.sfx.play('claimed', undefined, 0.8);
}

export function escapedNews(ctx: HauntContext): void {
  ctx.hud.showBanner('YOU ESCAPED', '#9fe0a8', 3500);
  ctx.sfx.play('escape');
}

/**
 * Watching the others once the house has you: the camera follows behind someone still inside, and moves on to the
 * next one when asked, or when they're gone too.
 */
export class Spectator {
  watching = false;
  private target: SurvivorEntity | null = null;
  private orbit = 0;
  private pitch = 0.35;
  private readonly from: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private ready = false;

  constructor(
    private readonly ctx: HauntContext,
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
    const back = (s.mode === SurvivorMode.Alive ? s.yaw : 0) + Math.PI + this.orbit;
    const dist = 3.2;
    const tx = who.x + Math.cos(back) * Math.cos(this.pitch) * dist;
    const ty = who.y + Math.sin(back) * Math.cos(this.pitch) * dist;
    const tz = 1.2 + Math.sin(this.pitch) * dist;
    // keep the camera this side of any wall
    const p = { x: who.x, y: who.y };
    ctx.manor.move(p, tx - who.x, ty - who.y, 0.2);
    const k = this.ready ? Math.min(1, dt * 6) : 1;
    this.ready = true;
    this.from.x += (p.x - this.from.x) * k;
    this.from.y += (p.y - this.from.y) * k;
    this.from.z += (tz - this.from.z) * k;
    this.at.x = who.x;
    this.at.y = who.y;
    this.at.z = 1.1;
    this.rig.setDesktopChase(this.from, this.at);
    ctx.sfx.setListener(this.at, { x: Math.cos(back + Math.PI), y: Math.sin(back + Math.PI), z: 0 });
  }

  private candidates(): SurvivorEntity[] {
    const out: SurvivorEntity[] = [];
    for (const sv of this.ctx.world.all(Survivor) as ReadonlySet<SurvivorEntity>) {
      const m = sv.render.mode;
      if (sv !== this.ctx.me && (m === SurvivorMode.Alive || m === SurvivorMode.Downed)) out.push(sv);
    }
    return out;
  }
}
