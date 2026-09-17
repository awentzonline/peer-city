import { Avatar, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import { NO_TOOL } from '../crossplay/tool';
import type { HauntContext, KeyEntity, SurvivorEntity } from './context';
import { Feed, Glare, Haunt, Key, Monster, MonsterMode, Noise, Phase, Revive, Sound, Survivor as SurvivorDef, SurvivorMode, Burn } from './defs';
import type { SurvivorIntent } from './intent';
import { BEAM_HALF_ANGLE, BEAM_RANGE, FLASHLIGHT, TOOLS, type Flashlight, type Use } from './kit';
import { FENCE_MIN, PEDESTAL, SOCKETS, START } from './manor';
import { MONSTERS } from './monsters';

/** How the survivor's rules reach back to the device playing it. */
export interface SurvivorBody extends AvatarBody {
  /** The flashlight went on or off (`flat`: it wouldn't, or went out, for want of battery). */
  lit(on: boolean, flat: boolean): void;
  /** A whisper put the flashlight out, or it won't come back on yet. */
  snuffed(): void;
  downed(): void;
  helpedUp(): void;
  escaped(): void;
  gotKey(): void;
  placedKey(): void;
  /** A new night: back at the gate. */
  restarted(): void;
}

export type SurvivorFrontend = AvatarFrontend<SurvivorIntent> & SurvivorBody;

const NO_BODY: SurvivorBody = {
  platform: Platform.Desktop,
  moved() {},
  placed() {},
  hurt() {},
  used() {},
  died() {},
  lit() {},
  snuffed() {},
  downed() {},
  helpedUp() {},
  escaped() {},
  gotKey() {},
  placedKey() {},
  restarted() {},
};

export const MAX_HP = 3;
/** Battery used a second while the light's on, and got back a second while it's off. */
export const DRAIN = 2.4;
export const RECHARGE = 1.5;
/** The light won't come on with less than this. */
export const LOW_BATTERY = 6;
/** How long a downed survivor has, s, and how long it takes to help one up. */
export const BLEED_SECONDS = 45;
export const REVIVE_SECONDS = 3;
/** How near you have to be to help someone up, pick up a key, or put one in the pedestal. */
export const HELP_REACH = 1.8;
export const KEY_REACH = 1.3;
export const PEDESTAL_REACH = 2.8;
/** After a hit, a moment when nothing else can hurt you, ms. */
/**
 * Survivors move at this share of the usual avatar speeds (crossplay/avatar.ts): a walk of 2.3 m/s, a run of 4 and a
 * creep of 1. A run just outpaces a shade (3.3) and a brute (2.7), and a crawler (5.6) still catches you.
 */
const PACE = 0.55;
const HURT_GRACE_MS = 700;
/** How often burning and glaring are sent, ms. */
const BURN_MS = 200;
const GLARE_MS = 1500;
/** How far a beam drives off the Haunt's presence, m. */
const GLARE_RANGE = 12;

/**
 * The player as a survivor: an avatar in the dark with a flashlight. Only sees an intent, and reaches the device
 * through `body`. Hurt by monsters (`hurt`), downed at no health, helped up by others (`helpedBy`), and out through the
 * gate once every key's in the pedestal.
 */
export class SurvivorRole extends Avatar<SurvivorIntent, SurvivorBody, Flashlight> implements Role<SurvivorIntent, SurvivorFrontend> {
  body: SurvivorBody = NO_BODY;
  /** Who you're helping up right now, for the HUD. */
  helping: SurvivorEntity | null = null;
  /** Battery, 0..100 (the entity keeps it rounded). */
  battery = 100;
  private bleed = 0;
  private hurtUntil = 0;
  /** A whisper put the light out: it won't come back on till then. */
  private darkUntil = 0;
  private helpedAt = -1e9;
  private helper = 0;
  private nextHelp = 0;
  private nextBurn = 0;
  private nextGlare = 0;
  private readonly exposure = new Map<number, number>();
  private lightHand: Use | null = null;
  private pickup: { key: KeyEntity; until: number } | null = null;

  constructor(readonly ctx: HauntContext) {
    super(TOOLS);
  }

  get me(): SurvivorEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  get mode(): SurvivorMode {
    return this.me?.state.mode ?? SurvivorMode.Alive;
  }

  /** The gate lets you out once it's open, and never back in. */
  private get throughGate(): boolean {
    return this.ctx.manor.gateOpen && this.mode === SurvivorMode.Alive;
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    this.ctx.manor.move(p, dx, dy, RADIUS, this.throughGate);
  }

  protected override collide(p: { x: number; y: number }): void {
    this.ctx.manor.pushOut(p, RADIUS, this.throughGate);
  }

  /** Into the yard by the gate. */
  spawn(): void {
    const { ctx } = this;
    const at = startSpot(ctx);
    ctx.me = ctx.world.spawn(SurvivorDef, { x: at.x, y: at.y, name: ctx.playerName, skin: Math.floor(Math.random() * 30), mode: SurvivorMode.Alive, hp: MAX_HP, battery: 100 });
    this.heading = Math.PI / 2;
    this.inventory.select(FLASHLIGHT);
    ctx.world.setFocus(at.x, at.y);
  }

  update(dt: number, intent: SurvivorIntent): void {
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    this.nightly();

    switch (s.mode) {
      case SurvivorMode.Dead:
        this.putAway();
        if (intent.head) this.walkTracked(dt, intent.head, intent, false);
        break;
      case SurvivorMode.Escaped:
        this.putAway();
        this.stroll(dt, intent, 1);
        break;
      case SurvivorMode.Downed:
        this.crawl(dt, intent);
        this.useTools(dt, intent);
        break;
      default:
        this.stroll(dt, intent, PACE);
        this.useTools(dt, intent);
        this.keys();
        this.help(intent);
        this.escape();
    }
    this.charge(dt);
    this.flushBeam();
    s.battery = Math.round(this.battery);
    this.ctx.world.setFocus(s.x, s.y);
  }

  // -------------------------------------------------------------------------
  // Moving
  // -------------------------------------------------------------------------

  private stroll(dt: number, intent: SurvivorIntent, speed: number): void {
    if (speed !== 1) {
      intent.strafe *= speed;
      intent.forward *= speed;
    }
    if (intent.head) this.walkTracked(dt, intent.head, intent, true);
    else this.walk(dt, intent);
  }

  /** Down: drag yourself along the floor, bleeding, unless someone's helping you up. */
  private crawl(dt: number, intent: SurvivorIntent): void {
    const s = this.me!.state;
    const helped = this.now - this.helpedAt < 450;
    intent.run = intent.jump = false;
    if (helped) intent.strafe = intent.forward = 0;
    if (intent.head) {
      this.stroll(dt, intent, 0.15 * PACE);
    } else {
      intent.crouch = true;
      this.stroll(dt, intent, 0.5 * PACE);
      s.head = 0.55;
    }
    if (helped) {
      s.revive = Math.min(1, s.revive + dt / REVIVE_SECONDS);
      if (s.revive >= 1) this.getUp();
      return;
    }
    s.revive = Math.max(0, s.revive - dt * 0.5);
    this.bleed -= dt;
    s.bleed = Math.max(0, Math.ceil(this.bleed));
    if (this.bleed <= 0) this.die();
  }

  /** Walked out of the open gate. */
  private escape(): void {
    const s = this.me!.state;
    if (!this.ctx.manor.gateOpen || s.y > FENCE_MIN - 0.1) return;
    this.dropKey();
    this.lightOff(false);
    s.mode = SurvivorMode.Escaped;
    this.ctx.world.send(Feed, { text: `${s.name} escaped!` }, { to: 'all' });
    this.body.escaped();
  }

  /** A new night started without you: back to the gate, whole. */
  private nightly(): void {
    const round = this.ctx.round()?.state;
    const s = this.me!.state;
    if (!round || s.round === round.round || round.phase === Phase.Over) return;
    const first = s.round === 0;
    s.round = round.round;
    s.mode = SurvivorMode.Alive;
    s.hp = MAX_HP;
    s.revive = 0;
    s.bleed = 0;
    this.battery = 100;
    this.dropKey();
    this.lightOff(false);
    if (first) return;
    const at = startSpot(this.ctx);
    this.heading = Math.PI / 2;
    this.pitch = 0;
    s.head = 1.65;
    this.teleport(at.x, at.y);
    this.body.restarted();
  }

  // -------------------------------------------------------------------------
  // The flashlight
  // -------------------------------------------------------------------------

  private useTools(dt: number, intent: SurvivorIntent): void {
    if (intent.hands) this.useHands(intent.hands, dt);
    else this.useCrosshair(intent, dt);
    const s = this.me!.state;
    if (s.light && s.tool !== FLASHLIGHT.id && s.ltool !== FLASHLIGHT.id) this.lightOff(false);
  }

  /** Nothing in hand: dead or out. */
  private putAway(): void {
    const s = this.me!.state;
    this.hands[0].hold(null);
    this.hands[1].hold(null);
    s.tool = s.ltool = NO_TOOL;
    this.lightOff(false);
  }

  /** The trigger on the flashlight in a hand. */
  switchLight(use: Use): void {
    const s = this.me!.state;
    if (s.light) {
      this.lightOff(false);
      return;
    }
    if (this.now < this.darkUntil) {
      this.body.snuffed();
      return;
    }
    if (this.battery < LOW_BATTERY) {
      this.body.lit(false, true);
      return;
    }
    s.light = true;
    this.lightHand = use;
    this.body.lit(true, false);
  }

  /** A whisper nearby: the light goes out and won't come back on for `ms`. */
  snuff(ms: number): void {
    this.darkUntil = this.now + ms;
    const s = this.me?.state;
    if (s?.light) this.lightOff(false);
    this.body.snuffed();
  }

  /** The flashlight left a hand. */
  putAwayLight(use: Use): void {
    if (this.lightHand === use) this.lightOff(false);
  }

  private lightOff(flat: boolean): void {
    const s = this.me?.state;
    this.lightHand = null;
    if (!s?.light) return;
    s.light = false;
    this.body.lit(false, flat);
  }

  private charge(dt: number): void {
    const s = this.me!.state;
    if (s.light) {
      this.battery = Math.max(0, this.battery - DRAIN * dt);
      if (this.battery <= 0) this.lightOff(true);
    } else {
      this.battery = Math.min(100, this.battery + RECHARGE * dt);
    }
  }

  /** Every frame the flashlight's in a hand: while it's on, what's in the beam soaks up light. */
  shine(use: Use, dt: number): void {
    const s = this.me!.state;
    if (!s.light) return;
    this.lightHand = use;
    const { world, manor } = this.ctx;
    const o = use.origin;
    const a = use.aim;
    for (const m of world.query(o.x, o.y, BEAM_RANGE + 1, Monster)) {
      if (m.render.mode === MonsterMode.Dead) continue;
      const spec = MONSTERS[m.render.kind];
      const k = inBeam(o, a, m.x, m.y, spec.height, spec.radius + 0.25);
      if (k <= 0 || !manor.sees(o.x, o.y, m.x, m.y)) continue;
      this.exposure.set(m.id, (this.exposure.get(m.id) ?? 0) + k * dt);
    }
    if (this.now < this.nextGlare) return;
    for (const h of world.all(Haunt)) {
      const p = h.render;
      if (!p.present || Math.hypot(p.px - o.x, p.py - o.y) > GLARE_RANGE) continue;
      if (inBeam(o, a, p.px, p.py, 1.6, 0.8) <= 0 || !manor.sees(o.x, o.y, p.px, p.py)) continue;
      this.nextGlare = this.now + GLARE_MS;
      world.command(Glare, { target: h.id, by: this.me!.id });
    }
  }

  /** Tell each lit monster's owner how much light it's had. */
  private flushBeam(): void {
    if (this.now < this.nextBurn || !this.exposure.size) return;
    this.nextBurn = this.now + BURN_MS;
    for (const [id, amount] of this.exposure) this.ctx.world.command(Burn, { target: id, by: this.me!.id, amount });
    this.exposure.clear();
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  /** Pick up a key by walking over it (its owner hands it over), and put it in the pedestal by walking up to that. */
  private keys(): void {
    const { ctx } = this;
    const { world } = ctx;
    const s = this.me!.state;
    const round = ctx.round()?.state;
    if (!round) return;

    if (this.pickup) {
      const { key, until } = this.pickup;
      const free = key.alive && !key.state.holder && !key.state.socket;
      if (free && key.mine && key.held && !s.key) {
        this.pickup = null;
        key.state.holder = this.me!.id;
        s.key = key.id;
        world.send(Noise, { kind: Sound.Pickup, x: key.state.x, y: key.state.y, z: 1, a: 0 }, { to: 'all' });
        world.send(Feed, { text: `${s.name} found a key` }, { to: 'all' });
        this.body.gotKey();
      } else if (!free || this.now > until) {
        this.pickup = null;
        if (key.alive && key.mine && key.held && !key.state.holder) world.release(key);
      }
    }

    if (s.key) {
      const key = world.getAs(Key, s.key);
      if (!key || !key.mine || key.state.holder !== this.me!.id) {
        s.key = 0;
        return;
      }
      if (Math.hypot(s.x - PEDESTAL.cx, s.y - PEDESTAL.cy) < PEDESTAL_REACH) this.socket(key, round.round);
      return;
    }

    if (this.pickup || round.phase !== Phase.Hunt) return;
    for (const key of world.query(s.x, s.y, KEY_REACH, Key) as KeyEntity[]) {
      const k = key.render;
      if (k.holder || k.socket || k.round !== round.round) continue;
      this.pickup = { key, until: this.now + 1500 };
      void world.requestOwnership(key);
      return;
    }
  }

  /** Put a key you're carrying in a free socket of the pedestal. */
  private socket(key: KeyEntity, round: number): void {
    const { world } = this.ctx;
    const taken = new Set<number>();
    for (const k of world.all(Key)) if (k.render.round === round && k.render.socket) taken.add(k.render.socket);
    const free = SOCKETS.findIndex((_, i) => !taken.has(i + 1));
    if (free < 0) return;
    const s = this.me!.state;
    Object.assign(key.state, { holder: 0, socket: free + 1, x: SOCKETS[free].x, y: SOCKETS[free].y, z: 1.12 });
    s.key = 0;
    world.release(key);
    world.send(Noise, { kind: Sound.Socket, x: PEDESTAL.cx, y: PEDESTAL.cy, z: 1.1, a: taken.size + 1 }, { to: 'all' });
    world.send(Feed, { text: `${s.name} put a key in the pedestal (${Math.min(SOCKETS.length, taken.size + 1)}/${SOCKETS.length})` }, { to: 'all' });
    this.body.placedKey();
  }

  /** Let go of any key: whoever owns it drops it where it is (keys.ts). */
  private dropKey(): void {
    const s = this.me!.state;
    s.key = 0;
    this.pickup = null;
  }

  // -------------------------------------------------------------------------
  // Hurt, downed, helped up
  // -------------------------------------------------------------------------

  /** Hold `interact` over a downed survivor to help them up. */
  private help(intent: SurvivorIntent): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    this.helping = null;
    if (!intent.interact) return;
    let best: SurvivorEntity | null = null;
    let bestD = HELP_REACH;
    for (const sv of world.query(s.x, s.y, HELP_REACH, SurvivorDef) as SurvivorEntity[]) {
      if (sv === this.me || sv.render.mode !== SurvivorMode.Downed) continue;
      const d = Math.hypot(sv.x - s.x, sv.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = sv;
      }
    }
    this.helping = best;
    if (!best || this.now < this.nextHelp) return;
    this.nextHelp = this.now + 150;
    world.command(Revive, { target: best.id, by: this.me!.id });
  }

  /** Someone near is helping you up: keep at it and you're up. */
  helpedBy(by: number): void {
    if (this.mode !== SurvivorMode.Downed) return;
    this.helpedAt = this.now;
    this.helper = by;
  }

  /** A monster struck you. */
  hurt(amount: number, kx: number, ky: number): void {
    const s = this.me!.state;
    if (s.mode !== SurvivorMode.Alive || this.now < this.hurtUntil) return;
    this.hurtUntil = this.now + HURT_GRACE_MS;
    s.hp = Math.max(0, s.hp - amount);
    this.nudge(kx * 0.12, ky * 0.12);
    this.body.hurt(amount);
    if (s.hp <= 0) this.goDown();
  }

  private goDown(): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    this.dropKey();
    s.mode = SurvivorMode.Downed;
    s.revive = 0;
    this.bleed = BLEED_SECONDS;
    s.bleed = BLEED_SECONDS;
    world.send(Noise, { kind: Sound.Scream, x: s.x, y: s.y, z: 0.6, a: 0 }, { to: 'all' });
    world.send(Feed, { text: `${s.name} is down! Help them up` }, { to: 'all' });
    this.body.downed();
  }

  private getUp(): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    s.mode = SurvivorMode.Alive;
    s.hp = 2;
    s.revive = 0;
    s.bleed = 0;
    s.head = 1.65;
    this.hurtUntil = this.now + 2000;
    const helper = world.getAs(SurvivorDef, this.helper);
    world.send(Feed, { text: helper ? `${helper.render.name} helped ${s.name} up` : `${s.name} got up` }, { to: 'all' });
    this.body.helpedUp();
  }

  private die(): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    s.mode = SurvivorMode.Dead;
    s.revive = 0;
    s.bleed = 0;
    this.putAway();
    world.send(Feed, { text: `The house has claimed ${s.name}` }, { to: 'all' });
    this.body.died();
  }
}

/** Somewhere near the gate, inside it. */
function startSpot(ctx: HauntContext): { x: number; y: number } {
  return ctx.manor.nearestOpen(START.x + (Math.random() - 0.5) * 8, START.y + (Math.random() - 0.5) * 2);
}

/**
 * How squarely a point at height `z` on the ground (x, y) is in a beam from `o` along unit `a`, allowing for its size:
 * 1 point blank down the middle, falling off toward the beam's reach, 0 outside it.
 */
export function inBeam(o: { x: number; y: number; z: number }, a: { x: number; y: number; z: number }, x: number, y: number, z: number, size: number): number {
  const dx = x - o.x;
  const dy = y - o.y;
  const dz = z - o.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > BEAM_RANGE) return 0;
  if (d < size) return 1;
  const cos = (dx * a.x + dy * a.y + dz * a.z) / d;
  if (cos < Math.cos(BEAM_HALF_ANGLE + Math.atan(size / d))) return 0;
  return 1 - (0.6 * d) / BEAM_RANGE;
}
