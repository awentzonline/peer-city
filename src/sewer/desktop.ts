import * as THREE from 'three';
import { DesktopTool } from '../crossplay/desktopTool';
import { MOUSE_SENSITIVITY, readWalking } from '../crossplay/desktopControls';
import type { DesktopInput } from '../crossplay/input';
import type { Side } from '../crossplay/intent';
import { direction } from '../crossplay/math';
import { SOLID, box, merge } from '../crossplay/models';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import { waterLevel, type LordEntity, type SewerContext, type Vec3 } from './context';
import { Lord, LordMode, type LootKind } from './defs';
import type { LordKeys } from './hud';
import { idleLordIntent, stillLord, type LordIntent } from './intent';
import { DETECTOR, HOSE } from './kit';
import { LOOT } from './loot';
import type { LordFrontend, LordRole } from './lord';

const KEYS: LordKeys = {
  interact: 'Hold E',
  pump: 'Tap R',
  grab: 'E',
  hold: 'Click to throw it · hold right-click to tear it in half · E to drop it',
  bar: '<b>WASD</b> wade · <b>Shift</b> run · <b>Click</b> punch (hold to wind up) · <b>E</b> grab / hold to use · <b>1 2 3</b> fists, detector, hose · <b>R</b> pump · <b>Esc</b> settings · <b>V</b> mic',
};
const DEAD_KEYS: LordKeys = { ...KEYS, bar: '<b>Click</b> watch someone else · <b>Esc</b> settings · <b>V</b> mic' };

/**
 * Keyboard and mouse, first person, up to your knees in it. Fists by default: click to punch, hold to wind up a
 * haymaker. E grabs the goblin in front of you (then click throws it, holding the right button tears it in half), and
 * held, does what's at hand: hauls someone up, climbs the ladder, opens a valve, digs. 2 is the detector, 3 the hose:
 * tap R to pump it and hold the button to spray. Once you're out or done for, the camera follows the others.
 */
export class DesktopLord implements LordFrontend {
  readonly platform = Platform.Desktop;
  private readonly intent = idleLordIntent();
  private readonly held: DesktopTool;
  private readonly fists: Fists;
  private readonly spectator: Spectator;
  private readonly beeper = new Beeper();
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private nextStep = 0;

  constructor(
    private readonly ctx: SewerContext,
    private readonly lord: LordRole,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.fists = new Fists(rig);
    this.spectator = new Spectator(ctx, rig);
  }

  get showSelf(): boolean {
    return this.spectator.watching;
  }

  /** Where the hose's nozzle is on screen, for the jet. */
  nozzle(out: Vec3): Vec3 | null {
    return this.held.tool === HOSE ? this.held.tipWorld(out) : null;
  }

  dispose(): void {
    this.held.dispose();
    this.fists.dispose();
  }

  read(): LordIntent {
    const { input: k, intent, lord } = this;
    const [dx, dy] = k.consumeMouse();
    stillLord(intent);
    if (this.ctx.settings.open) return intent;
    if (watching(lord)) {
      if (k.pressed('Mouse0')) this.spectator.next();
      this.spectator.look(dx * MOUSE_SENSITIVITY, -dy * MOUSE_SENSITIVITY);
      return intent;
    }
    intent.turn = dx * MOUSE_SENSITIVITY;
    intent.lookUp = -dy * MOUSE_SENSITIVITY;
    readWalking(k, intent);
    intent.crouch = k.down('ControlLeft') || k.down('KeyC');
    intent.interact = k.down('KeyE');
    intent.grab = k.pressed('KeyE');
    intent.trigger = k.locked && k.mouse(0);
    intent.tear = k.locked && k.mouse(2);
    intent.pump = k.down('KeyR') ? 0 : 1;
    if (k.pressed('Digit1')) intent.fists = true;
    if (k.pressed('Digit2')) intent.selectTool = DETECTOR;
    if (k.pressed('Digit3')) intent.selectTool = HOSE;
    intent.cycleTool = Math.sign(k.wheel());
    this.held.setTool(lord.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    return intent;
  }

  present(dt: number): void {
    const { ctx, lord, rig } = this;
    if (!ctx.me) return;
    const away = watching(lord);
    this.spectator.watching = away;
    if (away) this.spectator.update(dt);
    else firstPerson(ctx, lord, rig);
    const active = lord.mode === LordMode.Active;
    const tool = active ? lord.inventory.current : null;
    this.held.setTool(tool);
    this.held.update(dt, active && !!tool);
    posePump(this.held.model, lord);
    this.fists.update(dt, active && !tool && !ctx.me.state.holding, lord.windup);
    ctx.hud.showLord(ctx, lord, away ? DEAD_KEYS : KEYS);
    this.beeper.update(ctx, lord);
    underwater(ctx, lord, rig);
    this.nextStep = wadingSound(ctx, lord, this.nextStep);
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

  punched(force: number, landed: boolean): void {
    this.fists.punch();
    this.ctx.sfx.play(landed ? 'thump' : 'whoosh', undefined, landed ? 0.4 : 0.8);
    if (landed) this.rig.shake(0.05 + force * 0.08);
  }

  grabbed(what: 'goblin' | 'loot' | 'valve'): void {
    if (what === 'goblin') this.ctx.hud.showBanner('GOT ONE', '#c8e05a', 900);
  }

  tore(): void {
    toreNews(this.ctx);
    this.rig.shake(0.25);
  }

  pumped(charge: number): void {
    pumpSound(this.ctx, charge);
  }

  sputtered(): void {
    sputterNews(this.ctx);
  }

  dug(kind: LootKind): void {
    dugNews(this.ctx, kind);
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
    downedNews(this.ctx, this.rig);
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
    this.ctx.hud.message('A new dive. Down the ladder you go.');
  }
}

/** Whether there's nothing left to do but watch: done for, or up the ladder. */
export function watching(lord: LordRole): boolean {
  return lord.mode === LordMode.Dead || lord.mode === LordMode.Surfaced;
}

/** A screen's first-person view from the Lord's eyes, and the ears with it. */
export function firstPerson(ctx: SewerContext, lord: LordRole, rig: Rig): void {
  const eye = lord.eyePosition(eyeTmp);
  rig.setDesktopView(eye.x, eye.y, eye.z, lord.heading, lord.pitch);
  ctx.sfx.setListener(eye, direction(lord.heading, lord.pitch, dirTmp));
}

const eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
const dirTmp: Vec3 = { x: 0, y: 0, z: 0 };

/** Head under the sewage: everything goes brown. */
export function underwater(ctx: SewerContext, lord: LordRole, rig: Rig): void {
  const me = ctx.me;
  if (!me || watching(lord)) return;
  const eye = rig.head(eyeTmp);
  const under = eye.z < waterLevel(ctx);
  if (under) rig.setTint(0x2a2410, 0.9);
  else if (lord.mode === LordMode.Downed) rig.setTint(0x3a0000, 0.25);
  else rig.setTint(0, 0);
}

/** Squelching along. */
export function wadingSound(ctx: SewerContext, lord: LordRole, next: number): number {
  const me = ctx.me;
  if (!me || lord.mode !== LordMode.Active || ctx.now < next) return next;
  const moving = Math.hypot(me.state.x - lastPos.x, me.state.y - lastPos.y);
  lastPos.x = me.state.x;
  lastPos.y = me.state.y;
  if (moving < 0.04) return ctx.now + 100;
  const deep = waterLevel(ctx) > ctx.map.groundAt(me.state.x, me.state.y) + 0.05;
  ctx.sfx.play(deep ? 'squelch' : 'drip', undefined, deep ? 0.35 : 0.15);
  return ctx.now + 420;
}

const lastPos = { x: 0, y: 0 };

/** The metal detector beeps, faster and higher the nearer it is. */
export class Beeper {
  private next = 0;
  /** Beeped just now, for a headset to buzz along with it. */
  beeped = false;

  update(ctx: SewerContext, lord: LordRole): void {
    this.beeped = false;
    if (!lord.sweeping || lord.mode !== LordMode.Active) return;
    const s = lord.signal;
    if (ctx.now < this.next) return;
    this.next = ctx.now + (s > 0.02 ? 1000 - s * 920 : 1600);
    if (s <= 0.02) return;
    ctx.sfx.beep(s);
    this.beeped = true;
  }
}

/** The pump slide on a crosshair's hose moves back while R's held. */
function posePump(model: THREE.Group, lord: LordRole): void {
  model.position.z += lord.pumpAt === 0 ? 0.05 : 0;
}

/** Bare fists in front of the camera: the right one winds back and punches. */
class Fists {
  private readonly left: THREE.Mesh;
  private readonly right: THREE.Mesh;
  private jab = 0;

  constructor(rig: Rig) {
    // a rubber work glove, knuckles forward, and the hi-vis cuff
    const geo = merge([box(0.075, 0.065, 0.1, 0, 0, 0, 0x3a4a2a), box(0.07, 0.03, 0.03, 0, 0.035, -0.035, 0x2e3a22), box(0.07, 0.06, 0.05, 0, -0.005, 0.07, 0xe8661a)]);
    this.left = new THREE.Mesh(geo, SOLID);
    this.right = new THREE.Mesh(geo, SOLID);
    rig.camera.add(this.left, this.right);
  }

  punch(): void {
    this.jab = 1;
  }

  update(dt: number, visible: boolean, windup: number): void {
    this.left.visible = this.right.visible = visible;
    this.jab = Math.max(0, this.jab - dt * 5);
    const thrust = Math.sin(this.jab * Math.PI);
    const shake = windup > 0.95 ? (Math.random() - 0.5) * 0.01 : 0;
    this.right.position.set(0.17 - thrust * 0.1 + shake, -0.2 - windup * 0.05 + thrust * 0.08, -0.5 + windup * 0.14 - thrust * 0.3);
    this.right.rotation.set(0.1 - windup * 0.4, 0.15, 0.2);
    this.left.position.set(-0.19, -0.22 + Math.sin(performance.now() / 400) * 0.005, -0.52);
    this.left.rotation.set(0.1, -0.15, -0.2);
  }

  dispose(): void {
    this.left.removeFromParent();
    this.right.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Making a fuss, the same on every platform with a screen
// ---------------------------------------------------------------------------

export function hurtFlash(ctx: SewerContext, rig: Rig): void {
  rig.flash(0x8a0000, 0.5);
  rig.shake(0.2);
  ctx.hud.hurt();
  ctx.sfx.play('hurt');
}

export function diedNews(ctx: SewerContext): void {
  ctx.hud.showBanner('THE SEWER HAS YOU', '#b04a4a', 3500);
  ctx.sfx.play('lost', undefined, 0.8);
}

export function toreNews(ctx: SewerContext): void {
  ctx.hud.showBanner('RIIIIP', '#c8e05a', 1200);
}

export function pumpSound(ctx: SewerContext, charge: number): void {
  ctx.sfx.play('pump', undefined, 0.8);
  if (charge >= 100) ctx.hud.setHint('Full pressure! Hold the trigger to spray');
}

export function sputterNews(ctx: SewerContext): void {
  ctx.sfx.play('sputter');
  ctx.hud.message('No pressure. Pump the hose first!');
}

export function dugNews(ctx: SewerContext, kind: LootKind): void {
  ctx.hud.showBanner(LOOT[kind].name.toUpperCase(), '#ffd35a', 1600);
}

export function bankedNews(ctx: SewerContext, worth: number, count: number): void {
  ctx.hud.showBanner(`BANKED £${worth}`, '#ffd35a', 2000);
  ctx.hud.message(`You sent ${count === 1 ? 'it' : `all ${count}`} up the ladder. Keep looking, or hold E there to climb out.`);
}

export function sackFullNews(ctx: SewerContext): void {
  ctx.sfx.play('full');
  ctx.hud.message('Your sack’s full: take it back to the ladder');
}

export function chokeNews(ctx: SewerContext, rig: Rig): void {
  ctx.sfx.play('choke');
  rig.flash(0x3a2a00, 0.6);
}

export function downedNews(ctx: SewerContext, rig: Rig): void {
  rig.flash(0x5a0000, 0.8);
  ctx.hud.showBanner("YOU'RE DOWN", '#ff5a4a', 2500);
}

export function surfacedNews(ctx: SewerContext, rig: Rig): void {
  rig.setTint(0, 0);
  ctx.hud.showBanner('YOU MADE IT OUT', '#9fe0a8', 3500);
  ctx.sfx.play('rich', undefined, 0.7);
}

/**
 * Watching the others once you're out or done for: the camera follows behind someone still down there, and moves on
 * to the next one when asked, or when they're out too.
 */
export class Spectator {
  watching = false;
  private target: LordEntity | null = null;
  private orbit = 0;
  private pitch = 0.35;
  private readonly from: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private ready = false;

  constructor(
    private readonly ctx: SewerContext,
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
    const ground = ctx.map.groundAt(who.x, who.y);
    const back = s.yaw + Math.PI + this.orbit;
    const dist = 3;
    const tx = who.x + Math.cos(back) * Math.cos(this.pitch) * dist;
    const ty = who.y + Math.sin(back) * Math.cos(this.pitch) * dist;
    const tz = Math.min(ctx.map.ceilingAt(who.x, who.y) - 0.3, ground + 1.3 + Math.sin(this.pitch) * dist);
    const p = { x: who.x, y: who.y };
    ctx.map.move(p, tx - who.x, ty - who.y, 0.2);
    const k = this.ready ? Math.min(1, dt * 6) : 1;
    this.ready = true;
    this.from.x += (p.x - this.from.x) * k;
    this.from.y += (p.y - this.from.y) * k;
    this.from.z += (tz - this.from.z) * k;
    this.at.x = who.x;
    this.at.y = who.y;
    this.at.z = ground + 1.1;
    this.rig.setDesktopChase(this.from, this.at);
    ctx.sfx.setListener(this.at, { x: Math.cos(back + Math.PI), y: Math.sin(back + Math.PI), z: 0 });
  }

  private candidates(): LordEntity[] {
    const out: LordEntity[] = [];
    for (const l of this.ctx.world.all(Lord) as ReadonlySet<LordEntity>) {
      const m = l.render.mode;
      if (l !== this.ctx.me && (m === LordMode.Active || m === LordMode.Downed)) out.push(l);
    }
    return out;
  }
}
