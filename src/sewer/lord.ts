import { Avatar, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { Side, type HandIntent } from '../crossplay/intent';
import { clamp, direction, TAU } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import { NO_TOOL } from '../crossplay/tool';
import { waterLevel, type GoblinEntity, type LordEntity, type LootEntity, type SewerContext, type Vec3 } from './context';
import { Bank, Feed, Goblin, GoblinMode, Lord as LordDef, LordMode, Loot, LootKind, LootWhere, Noise, Phase, Punch, Revive, Sound, Spray, SplatKind, TurnValve } from './defs';
import { SCRUFF, alive, distanceToGoblin, drop as dropGoblin, splat } from './goblins';
import type { LordIntent } from './intent';
import { HEADROOM, WADE } from './fatberg';
import { DETECTOR, HOSE, HOSE_RANGE, PUMP_THROW, PumpMeter, SPRAY_DRAIN, STROKE, TOOLS, type SewerTool, type Use } from './kit';
import { LOOT, SACK_MAX } from './loot';

/** How the Lord's rules reach back to the device playing it. */
export interface LordBody extends AvatarBody {
  /** A punch was thrown, this hard, landing on a goblin or not. `side` is the tracked hand, or null for a crosshair. */
  punched(force: number, landed: boolean, side: Side | null): void;
  /** Took hold of something: a goblin, loot out of the muck, a valve's wheel. */
  grabbed(what: 'goblin' | 'loot' | 'valve', side: Side | null): void;
  /** Pulled a goblin in half. */
  tore(): void;
  /** A pump stroke went in: the hose is at `charge` now. */
  pumped(charge: number): void;
  /** Tried to spray with no pressure. */
  sputtered(): void;
  dug(kind: LootKind): void;
  banked(worth: number, count: number): void;
  sackFull(): void;
  /** Out of air, head under the sewage. */
  choking(): void;
  downed(): void;
  helpedUp(): void;
  surfaced(): void;
  /** A new dive: back at the foot of the ladder. */
  restarted(): void;
}

export type LordFrontend = AvatarFrontend<LordIntent> & LordBody;

const NO_BODY: LordBody = {
  platform: Platform.Desktop,
  moved() {},
  placed() {},
  hurt() {},
  used() {},
  died() {},
  punched() {},
  grabbed() {},
  tore() {},
  pumped() {},
  sputtered() {},
  dug() {},
  banked() {},
  sackFull() {},
  choking() {},
  downed() {},
  helpedUp() {},
  surfaced() {},
  restarted() {},
};

export const MAX_HP = 5;
/** Lordz go at this share of the usual avatar speeds, less the deeper the sewage. */
const PACE = 0.8;
/** How much each meter of sewage over your feet slows you, and the slowest it gets. */
const WADE_SLOW = 0.45;
const SLOWEST = 0.4;
/** A crosshair punch: how far it reaches, how wide, how often, and how long a full wind-up takes. */
export const PUNCH_REACH = 1.6;
const PUNCH_CONE = 0.55;
const PUNCH_MS = 320;
export const WINDUP_MS = 700;
/** A tracked fist lands at this speed, m/s, and how near a goblin it has to be. */
const FIST_SPEED = 2.2;
const FIST_REACH = 0.14;
/** How far a tracked hand reaches to take hold of something, m. */
const HAND_GRAB = 0.25;
/** Pull two hands this much further apart than they took hold, and the goblin comes in half. */
const TEAR_PULL = 0.26;
/** Crosshair: hold to pull a goblin apart this long, s. */
const TEAR_SECONDS = 0.6;
/** Thrown this hard, m/s, a goblin goes splat. */
const THROW_SPLAT = 3.2;
/** How fast a crosshair throw is, m/s. */
const THROW_SPEED = 10;
/** The hose needs at least this much pressure to spray. */
const MIN_CHARGE = 4;
/** How near the detector's coil loot shows up, m. */
export const DETECT_RANGE = 3.2;
/** Digging something up out of the silt, s. */
const DIG_SECONDS = 0.8;
/** How near you have to be to dig (crosshair), turn a valve, help someone up, bank or climb out. */
const DIG_REACH = 1.2;
const VALVE_REACH = 1.6;
export const HELP_REACH = 1.8;
const BANK_REACH = 2.2;
const LADDER_REACH = 1.4;
const CLIMB_SECONDS = 1.4;
/** How fast a held crosshair opens a valve (a share a second), and how far a turn of a tracked hand opens it. */
const VALVE_RATE = 0.45;
const VALVE_PER_TURN = 0.35;
/** A tracked hand is on a valve's wheel within this of its hub. */
const WHEEL_REACH = 0.42;
export const REVIVE_SECONDS = 3;
export const BLEED_SECONDS = 40;
/** Seconds of air with your head under, and hit points lost a while after that. */
const AIR_SECONDS = 8;
const CHOKE_MS = 1500;
const HURT_GRACE_MS = 1200;
/** Unhurt this long, ms, you get your breath back: a hit point every `HEAL_MS`. */
const HEAL_AFTER_MS = 8000;
const HEAL_MS = 5000;
/** Down with nobody else on their feet, you can haul yourself up, this slowly, s. */
const SELF_REVIVE_SECONDS = 7;
/** How often held actions are sent: helping someone up, turning a valve. */
const SEND_MS = 150;

type HandMode = 'none' | 'goblin' | 'second' | 'valve' | 'dig' | 'pump' | 'empty';

interface Grip {
  mode: HandMode;
  valve: number;
  angle: number;
  loot: LootEntity | null;
  progress: number;
}

/** Something held `interact` is doing, for the HUD. */
export interface Action {
  kind: 'revive' | 'climb' | 'valve' | 'dig' | 'tear';
  progress: number;
}

/**
 * The player as a Lord: an avatar wading through the sewer. Only sees an intent, and reaches the device through `body`.
 *
 * Fists punch goblins (a crosshair's winds up while held; a tracked hand's lands by how fast it's swung), and a hand can
 * grab one: then throw it, or take hold with the other hand too and pull it in half. The detector finds loot under the
 * murk, which is dug up into the sack on your back, and banked by bringing it to the ladder. The hose is pumped up and
 * blasts the fatberg. Relief valves are turned by holding on (a crosshair) or cranking the wheel round (a hand).
 * Scratched to nothing, or with your head under too long, you're down until someone hauls you up.
 */
export class LordRole extends Avatar<LordIntent, LordBody, SewerTool> implements Role<LordIntent, LordFrontend> {
  body: LordBody = NO_BODY;
  /** Hose pressure, 0..100 (the entity keeps it rounded). */
  charge = 0;
  /** How strongly the detector's picking something up, 0..1, while it's in hand. */
  signal = 0;
  sweeping = false;
  /** What a held `interact` is doing. */
  action: Action | null = null;
  /** The downed Lord you're hauling up. */
  helping: LordEntity | null = null;
  /** Where the pump handle is, for the hose's model: 0 back, 1 home, null nobody on it. */
  pumpAt: number | null = null;
  /** When the crosshair's fist started winding up, or null. */
  windupAt: number | null = null;
  /** Where the jet last struck the fat, for the splash. */
  jetHit: Vec3 | null = null;
  private readonly pump = new PumpMeter();
  private pumpBase: number | null = null;
  private readonly grips: [Grip, Grip] = [grip(), grip()];
  private readonly wasGrabbing = [false, false];
  private readonly fistCool = [0, 0];
  private readonly fling: [Vec3, Vec3] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  private holdSide: Side | null = null;
  private tearBase = 0;
  private tearing = 0;
  private pendingGrab: { goblin: GoblinEntity; side: Side | null; until: number } | null = null;
  private pendingLoot: { loot: LootEntity; until: number } | null = null;
  private nextPunch = 0;
  private hurtUntil = 0;
  private bleed = 0;
  private helpedAt = -1e9;
  private helper = 0;
  private nextSend = 0;
  private valveAcc = 0;
  private valveOn = -1;
  private climbing = 0;
  private digging: { loot: LootEntity; progress: number } | null = null;
  private nextChoke = 0;
  private nextSputter = 0;
  private nextFull = 0;
  private sprayUntil = 0;
  private readonly jetCool = new Map<number, number>();

  constructor(readonly ctx: SewerContext) {
    super(TOOLS);
    this.inventory.current = null;
  }

  get me(): LordEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  get mode(): LordMode {
    return this.me?.state.mode ?? LordMode.Active;
  }

  /** The goblin in your hand, if you've got one. */
  get holding(): GoblinEntity | null {
    const id = this.me?.state.holding;
    return id ? (this.ctx.world.getAs(Goblin, id) ?? null) : null;
  }

  /** How far a crosshair fist is wound up, 0..1. */
  get windup(): number {
    return this.windupAt === null ? 0 : Math.min(1, (this.now - this.windupAt) / WINDUP_MS);
  }

  /** How far through pulling a goblin apart a crosshair is, 0..1. */
  get tearProgress(): number {
    return this.tearing;
  }

  protected override groundAt(x: number, y: number): number {
    return this.ctx.map.groundAt(x, y);
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    const x0 = p.x;
    const y0 = p.y;
    this.ctx.map.move(p, dx, dy, RADIUS);
    if (!this.inFat(p.x, p.y) || this.inFat(x0, y0)) return;
    // slide along the fat a side at a time
    const tx = p.x;
    const ty = p.y;
    p.y = y0;
    if (!this.inFat(tx, y0)) return;
    p.x = x0;
    p.y = ty;
    if (!this.inFat(x0, ty)) return;
    p.y = y0;
  }

  protected override collide(p: { x: number; y: number }): void {
    this.ctx.map.pushOut(p, RADIUS);
  }

  private inFat(x: number, y: number): boolean {
    const g = this.ctx.map.groundAt(x, y);
    return this.ctx.plug.blocks(x, y, g + WADE + 0.05, g + HEADROOM - 0.05, RADIUS - 0.05);
  }

  /** At the foot of the ladder. */
  spawn(): void {
    const { ctx } = this;
    const at = gatherSpot(ctx);
    ctx.me = ctx.world.spawn(LordDef, { x: at.x, y: at.y, name: ctx.playerName, skin: Math.floor(Math.random() * 30), mode: LordMode.Active, hp: MAX_HP, air: 1 });
    this.heading = Math.atan2(ctx.map.start.cy - at.y, ctx.map.start.cx - at.x);
    ctx.world.setFocus(at.x, at.y);
  }

  update(dt: number, intent: LordIntent): void {
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    this.dive();
    this.sweeping = false;
    this.action = null;
    this.helping = null;

    switch (s.mode) {
      case LordMode.Dead:
      case LordMode.Surfaced:
        this.putAway();
        if (intent.head) this.walkTracked(dt, intent.head, intent, false);
        break;
      case LordMode.Downed:
        this.putAway();
        this.crawl(dt, intent);
        this.breathe(dt);
        break;
      default:
        this.wade(dt, intent);
        this.useTools(dt, intent);
        this.pumpHose(intent);
        this.takeHold();
        if (intent.hands) this.useHandsOnThings(dt, intent.hands);
        else this.useFists(intent, dt);
        this.carryGoblin(intent);
        if (!intent.grab || !this.grabbedThisFrame) this.interact(dt, intent);
        this.takeLoot();
        this.flush();
        this.bank();
        this.breathe(dt);
        this.heal();
    }
    this.grabbedThisFrame = false;
    this.countSack();
    s.charge = Math.round(this.charge);
    this.ctx.world.setFocus(s.x, s.y);
  }

  private grabbedThisFrame = false;

  // -------------------------------------------------------------------------
  // Moving
  // -------------------------------------------------------------------------

  /** Walk, slowed by how deep the sewage is. */
  private wade(dt: number, intent: LordIntent): void {
    const s = this.me!.state;
    const depth = Math.max(0, waterLevel(this.ctx) - this.groundAt(s.x, s.y));
    const k = PACE * Math.max(SLOWEST, 1 - depth * WADE_SLOW);
    intent.strafe *= k;
    intent.forward *= k;
    if (intent.head) this.walkTracked(dt, intent.head, intent, true);
    else this.walk(dt, intent);
  }

  /** Down: drag yourself along, bleeding, unless someone's hauling you up. */
  private crawl(dt: number, intent: LordIntent): void {
    const s = this.me!.state;
    const helped = this.now - this.helpedAt < 450;
    intent.run = intent.jump = false;
    if (helped) intent.strafe = intent.forward = 0;
    intent.strafe *= 0.3;
    intent.forward *= 0.3;
    if (intent.head) {
      this.walkTracked(dt, intent.head, intent, true);
    } else {
      intent.crouch = true;
      this.walk(dt, intent);
      s.head = 0.55;
    }
    if (helped) {
      s.revive = Math.min(1, s.revive + dt / REVIVE_SECONDS);
      if (s.revive >= 1) this.getUp();
      return;
    }
    // nobody coming: drag yourself up, slowly
    if (intent.interact && !this.friendsUp()) {
      s.revive = Math.min(1, s.revive + dt / SELF_REVIVE_SECONDS);
      this.action = { kind: 'revive', progress: s.revive };
      if (s.revive >= 1) this.getUp();
      return;
    }
    s.revive = Math.max(0, s.revive - dt * 0.5);
    // in the sewage face down, it's quicker
    const under = this.feetZ() + s.head < waterLevel(this.ctx);
    this.bleed -= dt * (under ? 3 : 1);
    s.bleed = Math.max(0, Math.ceil(this.bleed));
    if (this.bleed <= 0) this.die(under);
  }

  /** A new dive started without you: back to the ladder, whole. */
  private dive(): void {
    const sewer = this.ctx.sewer()?.state;
    const s = this.me!.state;
    if (!sewer || s.dive === sewer.dive || sewer.phase === Phase.Over) return;
    const first = s.dive === 0;
    s.dive = sewer.dive;
    Object.assign(s, { mode: LordMode.Active, hp: MAX_HP, air: 1, revive: 0, bleed: 0, sack: 0, holding: 0, spraying: false });
    this.charge = 0;
    this.pendingGrab = this.pendingLoot = null;
    if (first) return;
    const at = gatherSpot(this.ctx);
    this.heading = Math.atan2(this.ctx.map.start.cy - at.y, this.ctx.map.start.cx - at.x);
    this.pitch = 0;
    s.head = 1.65;
    this.teleport(at.x, at.y);
    this.body.restarted();
  }

  // -------------------------------------------------------------------------
  // Tools: the detector and the hose
  // -------------------------------------------------------------------------

  private useTools(dt: number, intent: LordIntent): void {
    if (intent.hands) {
      this.useHands(intent.hands, dt);
      return;
    }
    const inv = this.inventory;
    if (intent.fists) inv.current = null;
    if (intent.cycleTool) {
      const slots: (SewerTool | null)[] = [null, DETECTOR, HOSE];
      const at = slots.indexOf(inv.current);
      inv.current = slots[(at + (intent.cycleTool > 0 ? 1 : -1) + slots.length) % slots.length];
      intent.cycleTool = 0;
    }
    // hands full of goblin: no tool
    if (this.me!.state.holding) inv.current = null;
    this.useCrosshair(intent, dt);
  }

  /** Nothing in hand: down, dead or out. */
  private putAway(): void {
    const s = this.me!.state;
    this.hands[0].hold(null);
    this.hands[1].hold(null);
    s.tool = s.ltool = NO_TOOL;
    s.spraying = false;
    if (s.holding) this.letGo(0, 0, 0);
    this.windupAt = null;
  }

  /** The detector's in a hand: how near is anything buried? */
  sweep(use: Use): void {
    const { ctx } = this;
    const s = this.me!.state;
    this.sweeping = true;
    const tracked = use.side !== null;
    const coil = tracked ? use.origin : { x: s.x + Math.cos(this.heading) * 1.1, y: s.y + Math.sin(this.heading) * 1.1, z: 0 };
    const water = waterLevel(ctx);
    const lift = tracked ? Math.max(0, coil.z - water - 0.2) * 0.8 : 0;
    let best = 0;
    for (const loot of ctx.world.query(coil.x, coil.y, DETECT_RANGE + 1, Loot) as LootEntity[]) {
      const l = loot.render;
      if (l.where === LootWhere.Carried) continue;
      if (l.where === LootWhere.Lying && l.z > water) continue;
      const d = Math.hypot(loot.x - coil.x, loot.y - coil.y) + lift;
      best = Math.max(best, clamp(1 - d / DETECT_RANGE, 0, 1) ** 1.4);
    }
    this.signal = best;
  }

  /** The trigger's held on the hose: every tenth of a second, a jet at whatever it's pointed at. */
  spray(use: Use): void {
    const { ctx } = this;
    const { world, plug } = ctx;
    const s = this.me!.state;
    if (this.charge < MIN_CHARGE) {
      s.spraying = false;
      if (this.now >= this.nextSputter) {
        this.nextSputter = this.now + 700;
        this.body.sputtered();
      }
      return;
    }
    s.spraying = true;
    this.sprayUntil = this.now + 250;
    const power = 0.45 + (0.55 * this.charge) / 100;
    const o = use.origin;
    const a = use.aim;
    const hit = plug.raycast(o, a, HOSE_RANGE);
    const reach = hit ? hit.dist : HOSE_RANGE;
    for (const g of world.query(o.x, o.y, HOSE_RANGE + 1, Goblin) as GoblinEntity[]) {
      if (!alive(g.render.mode) || g.render.mode === GoblinMode.Held) continue;
      const cx = g.x - o.x;
      const cy = g.y - o.y;
      const cz = g.render.z + 0.8 - o.z;
      const t = cx * a.x + cy * a.y + cz * a.z;
      if (t < 0 || t > reach) continue;
      const off = Math.hypot(cx - a.x * t, cy - a.y * t, cz - a.z * t);
      if (off > 0.5 || this.now < (this.jetCool.get(g.id) ?? 0)) continue;
      this.jetCool.set(g.id, this.now + 350);
      world.command(Punch, { target: g.id, by: this.me!.id, force: 0.3, dx: a.x, dy: a.y, dz: 0 });
    }
    this.jetHit = hit?.at ?? null;
    if (!hit) return;
    const chunk = plug.chunks[hit.ci];
    if (chunk) world.command(Spray, { target: chunk.id, u: hit.u, v: hit.v, w: hit.w, power });
  }

  /** Every frame the hose is in hand: spraying uses up the pressure. */
  holdHose(_use: Use, dt: number): void {
    const s = this.me!.state;
    if (!s.spraying) return;
    this.charge = Math.max(0, this.charge - SPRAY_DRAIN * dt);
    if (this.charge <= 0 || this.now > this.sprayUntil) s.spraying = false;
  }

  stopSpray(): void {
    const s = this.me?.state;
    if (s) s.spraying = false;
    this.jetHit = null;
  }

  /** Build pressure in the hose in hand: the pump key on a crosshair, the other hand on the slide in a headset. */
  private pumpHose(intent: LordIntent): void {
    const hands = intent.hands;
    const hose = hands ? hands[0].tool === HOSE || hands[1].tool === HOSE : this.inventory.current === HOSE;
    const pos = !hose ? null : hands ? this.handPump(hands) : intent.pump;
    this.pumpAt = pos;
    if (!this.pump.update(pos)) return;
    this.charge = Math.min(100, this.charge + STROKE);
    this.body.pumped(this.charge);
  }

  /** Where the slide is, from how far the free hand's gone back along the hose since it took hold of it. */
  private handPump(hands: [HandIntent, HandIntent]): number | null {
    const hs = hands[Side.Right].tool === HOSE ? Side.Right : Side.Left;
    const other = hands[1 - hs];
    const hose = hands[hs];
    const g = this.grips[1 - hs];
    const dx = other.grip.x - hose.grip.x;
    const dy = other.grip.y - hose.grip.y;
    const dz = other.grip.z - hose.grip.z;
    const onIt = other.tracked && other.grab && !other.tool && (g.mode === 'pump' || (g.mode === 'none' && Math.hypot(dx, dy, dz) < 0.6));
    if (!onIt) {
      if (g.mode === 'pump') g.mode = other.grab ? 'empty' : 'none';
      this.pumpBase = null;
      return null;
    }
    g.mode = 'pump';
    const along = dx * hose.aim.x + dy * hose.aim.y + dz * hose.aim.z;
    this.pumpBase ??= along;
    // pushed further forward than it started: that's home now
    this.pumpBase = Math.max(this.pumpBase, along);
    return clamp(1 + (along - this.pumpBase) / PUMP_THROW, 0, 1);
  }

  // -------------------------------------------------------------------------
  // Fists and goblins
  // -------------------------------------------------------------------------

  /** A crosshair's fists: wind up while the trigger's held, punch on letting go, and grab or throw. */
  private useFists(intent: LordIntent, dt: number): void {
    const s = this.me!.state;
    if (s.holding) {
      this.windupAt = null;
      if (intent.trigger && !this.triggerWas) this.throwHeld();
      else if (intent.grab) this.letGo(0, 0, 0);
      else if (intent.tear) this.pullApart(dt);
      else this.tearing = 0;
      this.triggerWas = intent.trigger;
      if (intent.grab) this.grabbedThisFrame = true;
      return;
    }
    this.tearing = 0;
    if (intent.grab) {
      const g = this.goblinInFront(PUNCH_REACH + 0.2);
      if (g) {
        this.startGrab(g, null);
        this.grabbedThisFrame = true;
      }
    }
    const fists = this.inventory.current === null;
    if (fists && intent.trigger && this.windupAt === null && !this.triggerWas && this.now >= this.nextPunch) this.windupAt = this.now;
    if (this.windupAt !== null && (!intent.trigger || !fists)) {
      const force = 0.55 + 0.55 * this.windup;
      this.windupAt = null;
      if (fists) this.punchFront(force);
    }
    this.triggerWas = intent.trigger;
  }

  private triggerWas = false;

  /** A crosshair punch at whatever's in front. */
  private punchFront(force: number): void {
    const s = this.me!.state;
    this.nextPunch = this.now + PUNCH_MS;
    s.punches = (s.punches + 1) & 0xff;
    const g = this.goblinInFront(PUNCH_REACH);
    const aim = direction(this.heading, Math.max(this.pitch, 0) + 0.25, dirTmp);
    if (g) this.ctx.world.command(Punch, { target: g.id, by: this.me!.id, force, dx: aim.x, dy: aim.y, dz: aim.z });
    this.body.punched(force, !!g, null);
  }

  /** The nearest goblin in front of the eyes, within `reach`. */
  goblinInFront(reach: number): GoblinEntity | null {
    const s = this.me!.state;
    let best: GoblinEntity | null = null;
    let bestD = reach;
    for (const g of this.ctx.world.query(s.x, s.y, reach + 1, Goblin) as GoblinEntity[]) {
      const r = g.render;
      if (!alive(r.mode) || (r.mode === GoblinMode.Held && r.heldBy === this.me!.id)) continue;
      const dx = g.x - s.x;
      const dy = g.y - s.y;
      const d = Math.hypot(dx, dy) - 0.25;
      if (d > bestD) continue;
      const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - this.heading), Math.cos(Math.atan2(dy, dx) - this.heading)));
      if (off > PUNCH_CONE && d > 0.3) continue;
      bestD = d;
      best = g;
    }
    return best;
  }

  /** Tracked hands: fists land by how fast they're swung, and grips take hold of goblins, valves and loot. */
  private useHandsOnThings(dt: number, hands: [HandIntent, HandIntent]): void {
    const { world } = this.ctx;
    const me = this.me!;
    for (const side of [Side.Left, Side.Right]) {
      const intent = hands[side];
      const hand = this.hands[side];
      const g = this.grips[side];
      const grabbing = intent.tracked && intent.grab;
      const started = grabbing && !this.wasGrabbing[side];
      this.wasGrabbing[side] = grabbing;

      // the swing a hand's been making lately: a throw lets go at the end of one
      const fling = this.fling[side];
      const hv = hand.velocity;
      if (Math.hypot(hv.x, hv.y, hv.z) > Math.hypot(fling.x, fling.y, fling.z)) Object.assign(fling, hv);
      else {
        const k = Math.exp(-dt * 10);
        fling.x *= k;
        fling.y *= k;
        fling.z *= k;
      }
      if (!grabbing) {
        if (g.mode === 'goblin') this.letGo(fling.x, fling.y, fling.z);
        g.mode = 'none';
        g.loot = null;
      } else if (started && g.mode === 'none') {
        this.takeHoldWith(side, hand.origin);
      }

      switch (g.mode) {
        case 'second': {
          const held = this.holding;
          if (!held || this.holdSide === null || this.holdSide === side) {
            g.mode = 'empty';
            break;
          }
          const apart = distance(this.hands[this.holdSide].origin, hand.origin);
          this.action = { kind: 'tear', progress: clamp((apart - this.tearBase) / TEAR_PULL, 0, 1) };
          if (apart > this.tearBase + TEAR_PULL) this.tearHeld(this.hands[this.holdSide].origin, hand.origin);
          break;
        }
        case 'valve':
          this.crank(g, hand.origin);
          break;
        case 'dig': {
          const loot = g.loot;
          if (!loot?.alive || (loot.render.where !== LootWhere.Buried && loot.render.where !== LootWhere.Lying)) {
            g.mode = 'empty';
            break;
          }
          g.progress += loot.render.where === LootWhere.Lying ? 1 : dt / DIG_SECONDS;
          this.action = { kind: 'dig', progress: Math.min(1, g.progress) };
          if (g.progress >= 1) {
            this.pickUp(loot);
            g.mode = 'empty';
          }
          break;
        }
      }

      // a bare fist swung into a goblin
      if (intent.tool || (g.mode !== 'none' && g.mode !== 'empty') || this.holdSide === side || !intent.tracked) continue;
      const v = hand.velocity;
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < FIST_SPEED || this.now < this.fistCool[side]) continue;
      for (const gob of world.query(hand.origin.x, hand.origin.y, 1.2, Goblin) as GoblinEntity[]) {
        if (!alive(gob.render.mode) || gob.render.heldBy === me.id || distanceToGoblin(gob, hand.origin) > FIST_REACH) continue;
        this.fistCool[side] = this.now + 300;
        const force = clamp((speed - 1.4) / 4.5, 0.3, 1.4);
        me.state.punches = (me.state.punches + 1) & 0xff;
        world.command(Punch, { target: gob.id, by: me.id, force, dx: v.x / speed, dy: v.y / speed, dz: v.z / speed });
        this.body.punched(force, true, side);
        break;
      }
    }
  }

  /** A tracked hand closed: on a goblin, a valve's wheel, or loot down in the muck? */
  private takeHoldWith(side: Side, p: Vec3): void {
    const { ctx } = this;
    const g = this.grips[side];
    g.mode = 'empty';
    const me = this.me!;
    // a goblin: or the one in your other hand, to pull apart
    let gob: GoblinEntity | null = null;
    let gobD = HAND_GRAB;
    for (const o of ctx.world.query(p.x, p.y, 1.5, Goblin) as GoblinEntity[]) {
      if (!alive(o.render.mode)) continue;
      const d = distanceToGoblin(o, p) + (o.id === me.state.holding ? 0 : 0.05);
      if (d < gobD || (o.id === me.state.holding && d < HAND_GRAB + 0.2)) {
        gobD = d;
        gob = o;
      }
    }
    if (gob && gob.id === me.state.holding && this.holdSide !== null && this.holdSide !== side) {
      g.mode = 'second';
      this.tearBase = distance(this.hands[this.holdSide].origin, p);
      this.body.grabbed('goblin', side);
      return;
    }
    if (gob && !me.state.holding && gob.render.mode !== GoblinMode.Held) {
      g.mode = 'goblin';
      this.startGrab(gob, side);
      return;
    }
    // a valve's wheel
    const valves = ctx.map.valves;
    for (let i = 0; i < valves.length; i++) {
      const v = valves[i];
      if (Math.hypot(p.x - v.x, p.y - v.y, p.z - v.z) > WHEEL_REACH) continue;
      g.mode = 'valve';
      g.valve = i;
      g.angle = wheelAngle(v, p);
      this.body.grabbed('valve', side);
      return;
    }
    // loot in the muck under the hand, or lying on a walkway
    const loot = this.lootNear(p, 0.55, true);
    if (loot) {
      g.mode = 'dig';
      g.loot = loot;
      g.progress = 0;
    }
  }

  /** Turning a valve's wheel round with a hand: the angle swept opens it. */
  private crank(g: Grip, p: Vec3): void {
    const v = this.ctx.map.valves[g.valve];
    if (Math.hypot(p.x - v.x, p.y - v.y, p.z - v.z) > WHEEL_REACH + 0.25) {
      g.mode = 'empty';
      return;
    }
    const a = wheelAngle(v, p);
    let da = a - g.angle;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    g.angle = a;
    this.turnValve(g.valve, (Math.abs(da) / TAU) * VALVE_PER_TURN);
  }

  private turnValve(valve: number, amount: number): void {
    if (this.valveOn !== valve) {
      this.flushValve();
      this.valveOn = valve;
    }
    this.valveAcc += amount;
    const sewer = this.ctx.sewer()?.render;
    const open = sewer ? [sewer.v0, sewer.v1, sewer.v2, sewer.v3][valve] ?? 0 : 0;
    this.action = { kind: 'valve', progress: Math.min(1, open + this.valveAcc) };
  }

  /** Reach for a goblin: its owner hands it over (see `takeHold`). */
  private startGrab(g: GoblinEntity, side: Side | null): void {
    this.pendingGrab = { goblin: g, side, until: this.now + 900 };
    if (!g.mine || !g.held) void this.ctx.world.requestOwnership(g);
  }

  /** The goblin reached for is ours now: take it by the scruff. */
  private takeHold(): void {
    const p = this.pendingGrab;
    if (!p) return;
    const g = p.goblin;
    const me = this.me!;
    const handGone = p.side !== null && this.grips[p.side].mode !== 'goblin';
    if (!g.alive || !alive(g.render.mode) || this.now > p.until || handGone || me.state.holding) {
      this.pendingGrab = null;
      if (g.alive && g.mine && g.held && g.state.mode !== GoblinMode.Held) this.ctx.world.release(g);
      return;
    }
    if (!g.mine || !g.held) return;
    this.pendingGrab = null;
    const s = g.state;
    Object.assign(s, { mode: GoblinMode.Held, heldBy: me.id, target: 0 });
    me.state.holding = g.id;
    this.holdSide = p.side;
    this.tearing = 0;
    this.ctx.world.send(Noise, { kind: Sound.Grab, x: s.x, y: s.y, z: s.z + 1, a: 0 }, { to: 'all' });
    this.body.grabbed('goblin', p.side);
  }

  /** Hold the goblin you've got where your hand is: out in front of a crosshair. */
  private carryGoblin(intent: LordIntent): void {
    const me = this.me!;
    if (!me.state.holding) return;
    const g = this.holding;
    if (!g || !g.mine || g.state.mode !== GoblinMode.Held || g.state.heldBy !== me.id) {
      me.state.holding = 0;
      this.holdSide = null;
      return;
    }
    const s = g.state;
    if (this.holdSide !== null && intent.hands) {
      const h = this.hands[this.holdSide].origin;
      s.x = h.x;
      s.y = h.y;
      s.z = h.z - SCRUFF;
    } else {
      const eye = this.eyePosition(eyeTmp);
      s.x = eye.x + Math.cos(this.heading) * 1.0;
      s.y = eye.y + Math.sin(this.heading) * 1.0;
      s.z = eye.z - 0.35 - SCRUFF;
    }
    // not into the rock
    const p = { x: s.x, y: s.y };
    this.ctx.map.pushOut(p, 0.2);
    s.x = p.x;
    s.y = p.y;
    s.z = Math.max(s.z, this.ctx.map.groundAt(s.x, s.y) - 0.4);
    s.angle = Math.atan2(me.state.y - s.y, me.state.x - s.x);
  }

  /** Let go of the goblin in hand: moving fast, it's thrown (to its death, if hard enough); otherwise dropped, dazed. */
  private letGo(vx: number, vy: number, vz: number): void {
    const me = this.me!;
    const g = this.holding;
    me.state.holding = 0;
    this.holdSide = null;
    this.tearing = 0;
    for (const grip of this.grips) if (grip.mode === 'second' || grip.mode === 'goblin') grip.mode = 'empty';
    if (!g?.mine || g.state.mode !== GoblinMode.Held) return;
    const speed = Math.hypot(vx, vy, vz);
    if (speed > THROW_SPLAT) {
      const k = Math.min(3, 12 / speed);
      splat(this.ctx, g, SplatKind.Fling, vx * k, vy * k, vz * k + 1.5);
    } else {
      dropGoblin(this.ctx, g);
    }
  }

  /** A crosshair throws the goblin in hand where it looks. */
  private throwHeld(): void {
    const aim = direction(this.heading, this.pitch + 0.2, dirTmp);
    this.me!.state.punches = (this.me!.state.punches + 1) & 0xff;
    this.body.punched(0.6, false, null);
    this.letGo(aim.x * THROW_SPEED, aim.y * THROW_SPEED, aim.z * THROW_SPEED);
  }

  /** A crosshair pulling the goblin in hand apart: keep at it. */
  private pullApart(dt: number): void {
    this.tearing = Math.min(1, this.tearing + dt / TEAR_SECONDS);
    this.action = { kind: 'tear', progress: this.tearing };
    if (this.tearing < 1) return;
    const eye = this.eyePosition(eyeTmp);
    const side = this.heading + Math.PI / 2;
    this.tearHeld({ x: eye.x + Math.cos(side) * 0.3, y: eye.y + Math.sin(side) * 0.3, z: eye.z }, { x: eye.x - Math.cos(side) * 0.3, y: eye.y - Math.sin(side) * 0.3, z: eye.z });
  }

  /** Pull the goblin in hand in half, between two points. */
  private tearHeld(a: Vec3, b: Vec3): void {
    const me = this.me!;
    const g = this.holding;
    me.state.holding = 0;
    this.holdSide = null;
    this.tearing = 0;
    for (const grip of this.grips) if (grip.mode === 'second' || grip.mode === 'goblin') grip.mode = 'empty';
    if (!g?.mine) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    splat(this.ctx, g, SplatKind.Tear, (dx / len) * 3, (dy / len) * 3, 1);
    this.body.tore();
    this.ctx.world.send(Feed, { text: `${me.state.name} tore a goblin in half!` }, { to: 'all' });
  }

  // -------------------------------------------------------------------------
  // Held interact: helping up, climbing out, valves and digging on a crosshair
  // -------------------------------------------------------------------------

  private interact(dt: number, intent: LordIntent): void {
    const { ctx } = this;
    const s = this.me!.state;
    if (!intent.interact) {
      this.climbing = 0;
      this.digging = null;
      return;
    }
    const downed = this.downedNear();
    if (downed) {
      this.helping = downed;
      this.action = { kind: 'revive', progress: downed.render.revive };
      if (this.now >= this.nextSend) {
        this.nextSend = this.now + SEND_MS;
        ctx.world.command(Revive, { target: downed.id, by: this.me!.id });
      }
      return;
    }
    const foot = ctx.map.ladderFoot;
    if (Math.hypot(s.x - foot.x, s.y - foot.y) < LADDER_REACH && ctx.sewer()?.state.phase === Phase.Dive) {
      this.climbing += dt / CLIMB_SECONDS;
      this.action = { kind: 'climb', progress: Math.min(1, this.climbing) };
      if (this.climbing >= 1) this.surface();
      return;
    }
    this.climbing = 0;
    if (intent.hands) return;
    const valve = this.valveNear();
    if (valve >= 0) {
      this.turnValve(valve, VALVE_RATE * dt);
      return;
    }
    const ahead = { x: s.x + Math.cos(this.heading) * 0.8, y: s.y + Math.sin(this.heading) * 0.8, z: this.feetZ() };
    const loot = this.digging?.loot.alive && this.stillDiggable(this.digging.loot) ? this.digging.loot : this.lootNear(ahead, DIG_REACH, false);
    if (!loot) {
      this.digging = null;
      return;
    }
    if (this.digging?.loot !== loot) this.digging = { loot, progress: 0 };
    this.digging.progress += loot.render.where === LootWhere.Lying ? 1 : dt / DIG_SECONDS;
    this.action = { kind: 'dig', progress: Math.min(1, this.digging.progress) };
    if (this.digging.progress >= 1) {
      this.pickUp(loot);
      this.digging = null;
    }
  }

  /** A downed Lord within reach to haul up. */
  downedNear(): LordEntity | null {
    const s = this.me!.state;
    for (const l of this.ctx.world.query(s.x, s.y, HELP_REACH, LordDef) as LordEntity[]) if (l !== this.me && l.render.mode === LordMode.Downed) return l;
    return null;
  }

  /** The relief valve within reach of a crosshair, or -1. */
  valveNear(): number {
    const s = this.me!.state;
    return this.ctx.map.valves.findIndex((v) => Math.hypot(v.x - s.x, v.y - s.y) < VALVE_REACH);
  }

  /** Whether you're at the foot of the ladder. */
  atLadder(): boolean {
    const s = this.me!.state;
    const foot = this.ctx.map.ladderFoot;
    return Math.hypot(s.x - foot.x, s.y - foot.y) < LADDER_REACH;
  }

  private stillDiggable(loot: LootEntity): boolean {
    const w = loot.render.where;
    return w === LootWhere.Buried || w === LootWhere.Lying;
  }

  /** Loot to dig up or pick up near a point: in the silt or loose on the bottom, or lying on a walkway. */
  lootNear(p: Vec3, reach: number, hand: boolean): LootEntity | null {
    const water = waterLevel(this.ctx);
    let best: LootEntity | null = null;
    let bestD = reach;
    for (const loot of this.ctx.world.query(p.x, p.y, reach + 0.5, Loot) as LootEntity[]) {
      if (!this.stillDiggable(loot)) continue;
      const l = loot.render;
      // a hand has to be down in the muck for anything under it
      if (hand && p.z > Math.max(water, l.z + 0.3) + 0.15) continue;
      const d = Math.hypot(loot.x - p.x, loot.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = loot;
      }
    }
    return best;
  }

  /** Dig something up, or pick it up: its owner hands it over (see `takeLoot`). */
  private pickUp(loot: LootEntity): void {
    if (this.me!.state.sack >= SACK_MAX) {
      if (this.now >= this.nextFull) {
        this.nextFull = this.now + 2000;
        this.body.sackFull();
      }
      return;
    }
    this.pendingLoot = { loot, until: this.now + 1500 };
    if (!loot.mine || !loot.held) void this.ctx.world.requestOwnership(loot);
  }

  /** Loot reached for is ours now: into the sack. */
  private takeLoot(): void {
    const p = this.pendingLoot;
    if (!p) return;
    const { loot, until } = p;
    const free = loot.alive && this.stillDiggable(loot);
    if (free && loot.mine && loot.held) {
      this.pendingLoot = null;
      const me = this.me!;
      Object.assign(loot.state, { where: LootWhere.Carried, carrier: me.id });
      me.state.sack++;
      this.ctx.world.send(Noise, { kind: Sound.Dig, x: loot.state.x, y: loot.state.y, z: this.ctx.map.groundAt(me.state.x, me.state.y) + 0.5, a: 0 }, { to: 'all' });
      this.body.dug(loot.state.kind);
      this.body.grabbed('loot', null);
    } else if (!free || this.now > until) {
      this.pendingLoot = null;
      if (loot.alive && loot.mine && loot.held && loot.state.where !== LootWhere.Carried) this.ctx.world.release(loot);
    }
  }

  /** Send what the held actions have been doing. */
  private flush(): void {
    if (this.now < this.nextSend) return;
    this.flushValve();
  }

  private flushValve(): void {
    const sewer = this.ctx.sewer();
    if (this.valveOn >= 0 && this.valveAcc > 0.001 && sewer) {
      this.nextSend = this.now + SEND_MS;
      this.ctx.world.command(TurnValve, { target: sewer.id, valve: this.valveOn, amount: Math.min(1, this.valveAcc) });
    }
    this.valveAcc = 0;
    this.valveOn = -1;
  }

  /** How many things are in the sack: the loot this peer's carrying for you. */
  private countSack(): void {
    const me = this.me!;
    let n = 0;
    for (const loot of this.ctx.world.owned(Loot)) if (loot.state.carrier === me.id && loot.state.where === LootWhere.Carried) n++;
    me.state.sack = n;
  }

  /** At the ladder with loot: it goes up to the surface, and counts. */
  private bank(): void {
    const { ctx } = this;
    const me = this.me!;
    const sewer = ctx.sewer();
    if (!me.state.sack || !sewer || sewer.render.phase !== Phase.Dive) return;
    const foot = ctx.map.ladderFoot;
    if (Math.hypot(me.state.x - foot.x, me.state.y - foot.y) > BANK_REACH) return;
    let worth = 0;
    let count = 0;
    for (const loot of [...ctx.world.owned(Loot)] as LootEntity[]) {
      if (loot.state.carrier !== me.id || loot.state.where !== LootWhere.Carried) continue;
      worth += LOOT[loot.state.kind].worth;
      count++;
      ctx.world.command(Bank, { target: sewer.id, by: me.id, kind: loot.state.kind });
      ctx.world.despawn(loot);
    }
    if (!count) return;
    me.state.sack = 0;
    ctx.world.send(Noise, { kind: Sound.Bank, x: foot.x, y: foot.y, z: 1.2, a: count }, { to: 'all' });
    this.body.banked(worth, count);
  }

  /** Up the ladder and out, with whatever's banked. */
  private surface(): void {
    const s = this.me!.state;
    this.bank();
    this.putAway();
    s.mode = LordMode.Surfaced;
    this.climbing = 0;
    this.ctx.world.send(Feed, { text: `${s.name} climbed out of the sewer` }, { to: 'all' });
    this.body.surfaced();
  }

  // -------------------------------------------------------------------------
  // Hurt, air, downed, hauled up
  // -------------------------------------------------------------------------

  /** Keep your head above the sewage, or run out of air. */
  private breathe(dt: number): void {
    const s = this.me!.state;
    const under = this.feetZ() + s.head < waterLevel(this.ctx) - 0.04;
    if (!under) {
      s.air = Math.min(1, s.air + dt / 2);
      return;
    }
    s.air = Math.max(0, s.air - dt / AIR_SECONDS);
    if (s.air > 0 || this.now < this.nextChoke || s.mode !== LordMode.Active) return;
    this.nextChoke = this.now + CHOKE_MS;
    this.body.choking();
    this.lose(1);
  }

  /** Unhurt a while, your health comes back a little at a time. */
  private heal(): void {
    const s = this.me!.state;
    if (s.hp >= MAX_HP || this.now - this.hurtUntil < HEAL_AFTER_MS || this.now < this.nextHeal) return;
    this.nextHeal = this.now + HEAL_MS;
    s.hp++;
  }

  private nextHeal = 0;

  /** Whether any other Lord on this dive is still on their feet to haul you up. */
  private friendsUp(): boolean {
    const me = this.me!;
    for (const l of this.ctx.world.all(LordDef)) if (l !== me && l.render.dive === me.state.dive && l.render.mode === LordMode.Active) return true;
    return false;
  }

  /** Someone near is hauling you up: keep at it and you're up. */
  helpedBy(by: number): void {
    if (this.mode !== LordMode.Downed) return;
    this.helpedAt = this.now;
    this.helper = by;
  }

  /** A goblin scratched you. */
  hurt(amount: number, kx: number, ky: number): void {
    const s = this.me!.state;
    if (s.mode !== LordMode.Active || this.now < this.hurtUntil) return;
    this.hurtUntil = this.now + HURT_GRACE_MS;
    this.nudge(kx * 0.1, ky * 0.1);
    this.body.hurt(amount);
    this.lose(amount);
  }

  private lose(amount: number): void {
    const s = this.me!.state;
    s.hp = Math.max(0, s.hp - amount);
    if (s.hp <= 0) this.goDown();
  }

  private goDown(): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    this.putAway();
    s.mode = LordMode.Downed;
    s.revive = 0;
    this.bleed = BLEED_SECONDS;
    s.bleed = BLEED_SECONDS;
    world.send(Noise, { kind: Sound.Down, x: s.x, y: s.y, z: 0.6, a: 0 }, { to: 'all' });
    world.send(Feed, { text: `${s.name} is down in the muck! Haul them up` }, { to: 'all' });
    this.body.downed();
  }

  private getUp(): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    Object.assign(s, { mode: LordMode.Active, hp: 3, air: 1, revive: 0, bleed: 0, head: 1.65 });
    this.hurtUntil = this.now + 2000;
    const helper = world.getAs(LordDef, this.helper);
    world.send(Feed, { text: helper ? `${helper.render.name} hauled ${s.name} up` : `${s.name} got up` }, { to: 'all' });
    this.body.helpedUp();
  }

  private die(drowned: boolean): void {
    const s = this.me!.state;
    s.mode = LordMode.Dead;
    s.revive = 0;
    s.bleed = 0;
    this.putAway();
    this.ctx.world.send(Feed, { text: drowned ? `${s.name} drowned in the sewage` : `The sewer has claimed ${s.name}` }, { to: 'all' });
    this.body.died();
  }
}

function grip(): Grip {
  return { mode: 'none', valve: -1, angle: 0, loot: null, progress: 0 };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Where a hand is round a valve's wheel, as an angle in the wall's plane. */
function wheelAngle(v: { x: number; y: number; z: number; nx: number; ny: number }, p: Vec3): number {
  // across the wall, and up
  const ax = -v.ny;
  const ay = v.nx;
  return Math.atan2(p.z - v.z, (p.x - v.x) * ax + (p.y - v.y) * ay);
}

/** Somewhere at the foot of the ladder. */
function gatherSpot(ctx: SewerContext): { x: number; y: number } {
  const spots = ctx.map.gather;
  return spots[Math.floor(Math.random() * spots.length)];
}

const eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
const dirTmp: Vec3 = { x: 0, y: 0, z: 0 };

