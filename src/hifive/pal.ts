import { Avatar, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { Side, type HandIntent } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import { Toolbox, type Tool } from '../crossplay/tool';
import { clamp, type BuddyEntity, type HiContext, type PalEntity, type Vec3 } from './context';
import { BuddyMode, Pal as PalDef } from './defs';
import { tellFive, tellSlap } from './events';
import { collide, spawnPoint } from './field';
import type { PalIntent } from './intent';
import {
  BEHIND,
  FACING,
  Grade,
  MIN_SWING,
  Move,
  REST,
  bearingFrom,
  classifyHands,
  moveAt,
  offerPose,
  posePoint,
  ringError,
  ringPhase,
  speedGrade,
  timingGrade,
  type HandPose,
  type TrackedHand,
} from './moves';
import { followHands, handOf, leadHand, offerPoint, offerSides, partnerButt, partnerById, partnersNear, type Partner } from './partners';

/** How a pal's rules reach back to the device: an avatar's, and a jolt when a five or a slap lands. */
export interface PalBody extends AvatarBody {
  /** A five or a slap landed, on you or from you: `side` is the hand (null when it's no hand in particular), `strength` 0..1. */
  smacked(side: Side | null, strength: number): void;
}

export type PalFrontend = AvatarFrontend<PalIntent> & PalBody;

const NO_BODY: PalBody = {
  platform: Platform.Desktop,
  moved() {},
  placed() {},
  hurt() {},
  used() {},
  died() {},
  smacked() {},
};

/** Nobody carries anything here: hands are for fives. */
const NO_TOOLS = new Toolbox<Tool<any>>([]);

/** A key press swings at an offer this near, and this far round from where you face. */
export const ENGAGE_RANGE = 2.4;
const ENGAGE_BEARING = (50 * Math.PI) / 180;
/** A slap reaches a backside this near, in front of you. */
export const SLAP_RANGE = 1.5;
const SLAP_BEARING = (60 * Math.PI) / 180;
/** A timed swing's wind-up and strike, and how long the hand stays out after, ms. */
export const SWING_MS = 230;
const RECOVER_MS = 300;
/** A slap's wind-up, ms: long enough for someone who hears it coming to turn round. */
export const SLAP_MS = 450;
/** An offer nobody takes is put down after this long, ms. */
const OFFER_MS = 9000;
/** Swing at an offer this soon after it's pulled away and you're too slow, ms. */
export const YANK_MS = 1200;
/** A headset hand has to hold a pose this long to be an offer, ms, and leave it this fast to pull it away, m/s. */
const HOLD_MS = 200;
const YANK_SPEED = 2;
/** Tracked hands meet within this, m (palm to palm, with some give for the network), and a backside within this. */
export const CONTACT = 0.24;
const BUTT_CONTACT = 0.26;
/** A tracked hand has to be going this fast to slap a backside, m/s. */
const SLAP_SPEED = 1.3;
/** After a five, the same pair can't have another for this long, ms (both their peers may have seen it). */
const PAIR_MS = 650;
/** A backside you've slapped gets this long to recover before you can slap it again, ms. */
export const SLAP_REST_MS = 6000;
/** Both hands of a double have to land this close together, ms. */
const DOUBLE_MS = 250;
/** Anyone behind you this near, standing up, is heard. */
const ALERT_RANGE = 3.2;
/** A headset player whose head is this low is creeping. */
const SNEAK_HEAD = 1.3;

/** A timed swing at someone's offer, from a key or a finger. */
export interface Swing {
  target: number;
  move: Move;
  /** How the press was timed on the ring. */
  timing: Grade;
  start: number;
  contactAt: number;
  air: boolean;
  /** How it went, once it's landed (or didn't). */
  grade: Grade | null;
  /** Where the hands are going: the offer's hands, right then left. */
  points: [Vec3, Vec3];
}

/** A slap on its way to a backside, from a key or a finger. `target` 0 is a slap at the air. */
export interface SlapSwing {
  target: number;
  start: number;
  at: number;
  resolved: boolean;
  point: Vec3;
}

/** Why a slap at whoever's in front of you won't land. */
export type SlapCheck = 'ok' | 'front' | 'theirs-off' | 'mine-off' | 'resting';

const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const pa = v3();
const pb = v3();
const pc = v3();
const pose: HandPose = { f: 0, s: 0, z: 0 };

/**
 * The player: an avatar walking the locker room and the field, giving everyone five. Only sees an intent, and reaches
 * the device through `body`.
 *
 * With keys or fingers, a move pressed at someone holding one out is a swing at it, graded by how well it was timed on
 * the ring; otherwise it holds that move out for someone else to hit, and pressing it again pulls it away (too slow!).
 * With tracked hands it's all real: a hand held still over your head is an offer, and a hand swung into someone's is a
 * five, graded by how fast it was going. Slaps land on backsides from behind, unless they turn round in time.
 */
export class PalRole extends Avatar<PalIntent, PalBody, Tool<any>> implements Role<PalIntent, PalFrontend> {
  body: PalBody = NO_BODY;
  /** This player would rather nobody slapped them (the settings menu). */
  noSlaps = false;
  /** Keys and fingers: who a press would swing at, when the ring started turning for them, and who's in front. */
  engaged: Partner | null = null;
  ringStart = 0;
  facing: Partner | null = null;
  /** Who a slap would go for, and whether it can. */
  slapTarget: Partner | null = null;
  slapCheck: SlapCheck | null = null;
  swing: Swing | null = null;
  slap: SlapSwing | null = null;
  /** Somebody standing behind you, or winding up a slap. */
  alert: 'behind' | 'windup' | null = null;
  /** When the current offer went up. */
  offerAt = 0;
  private yankUntil = 0;
  private engagedId = 0;
  private readonly cooldowns = new Map<number, number>();
  /** Backsides you've slapped, and when they're fair game again. */
  private readonly slapped = new Map<number, number>();
  /** A headset pose that's becoming an offer. */
  private pending = { move: Move.None, left: false, since: 0 };
  /** One hand of a double landed: waiting on the other. */
  private double: { partner: number; side: Side; speed: number; at: number; point: Vec3 } | null = null;
  private readonly read: [TrackedHand, TrackedHand] = [trackedHand(), trackedHand()];

  constructor(readonly ctx: HiContext) {
    super(NO_TOOLS);
  }

  get me(): PalEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  /** How far round the timing ring is, 0..1 (see `RING_HIT`). */
  ringPhase(): number {
    return ringPhase(this.now - this.ringStart);
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    p.x += dx;
    p.y += dy;
    collide(p, RADIUS);
  }

  /** Into the locker room. */
  spawn(): void {
    const { ctx } = this;
    const at = spawnPoint();
    ctx.me = ctx.world.spawn(PalDef, { x: at.x, y: at.y, yaw: at.heading, name: ctx.playerName, skin: Math.floor(Math.random() * 256) });
    this.heading = at.heading;
    ctx.world.setFocus(at.x, at.y);
  }

  update(dt: number, intent: PalIntent): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    if (intent.head) this.walkTracked(dt, intent.head, intent, true);
    else this.walk(dt, intent);
    s.sneak = intent.head ? s.head < SNEAK_HEAD : intent.crouch;
    s.noSlaps = this.noSlaps;
    if (s.yank && this.now > this.yankUntil) s.yank = Move.None;

    this.lookAround();
    if (intent.hands) {
      this.useHands(intent.hands, dt);
      this.swing = null;
      this.slap = null;
      s.windup = 0;
      this.trackedHands(intent.hands);
    } else {
      this.flat(intent);
    }
    this.listen();
    ctx.world.setFocus(s.x, s.y);
  }

  // -------------------------------------------------------------------------
  // Keys and fingers
  // -------------------------------------------------------------------------

  /** Who's in front of you: someone to swing at, someone to hold one out for, and a backside within reach. */
  private lookAround(): void {
    const s = this.me!.state;
    const heading = s.yaw;
    this.engaged = this.facing = this.slapTarget = null;
    this.slapCheck = null;
    let best = Infinity;
    for (const p of partnersNear(this.ctx.world, s.x, s.y, ENGAGE_RANGE, this.me!.id)) {
      const bearing = bearingFrom(s.x, s.y, heading, p.x, p.y);
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (bearing > ENGAGE_BEARING) continue;
      this.facing ??= p;
      const rank = d + bearing;
      if ((p.offer !== Move.None || p.yank !== Move.None) && rank < best) {
        best = rank;
        this.engaged = p;
      }
      if (!this.slapTarget && d <= SLAP_RANGE && bearing < SLAP_BEARING) {
        this.slapTarget = p;
        this.slapCheck = this.noSlaps
          ? 'mine-off'
          : p.noSlaps
            ? 'theirs-off'
            : (this.slapped.get(p.id) ?? 0) > this.now
              ? 'resting'
              : bearingFrom(p.x, p.y, p.heading, s.x, s.y) > BEHIND
                ? 'ok'
                : 'front';
      }
    }
    // the ring starts turning afresh for each new person you line up with
    const id = this.engaged?.id ?? 0;
    if (id !== this.engagedId) this.ringStart = this.now;
    this.engagedId = id;
  }

  private flat(intent: PalIntent): void {
    const s = this.me!.state;
    if (intent.move !== Move.None) this.press(intent.move);
    if (intent.yank && s.offer !== Move.None) this.yankOffer();
    if (intent.slap) this.startSlap();
    if (s.offer !== Move.None && this.now - this.offerAt > OFFER_MS) s.offer = Move.None;
    this.stepSwing();
    this.stepSlap();
    this.poseHands();
  }

  /** A move key: swing at whoever's holding one out in front of you, or hold it out yourself (again pulls it away). */
  press(move: Move): void {
    const s = this.me!.state;
    if (this.swing || this.slap) return;
    if (this.engaged) {
      this.startSwing(this.engaged, move);
      return;
    }
    if (s.offer === move) this.yankOffer();
    else this.offerMove(move);
  }

  private offerMove(move: Move): void {
    const s = this.me!.state;
    s.offer = move;
    s.offerLeft = false;
    s.yank = Move.None;
    this.offerAt = this.now;
    this.ctx.sfx.play('offer');
  }

  /** Pull the offer away: anyone swinging at it is too slow. */
  yankOffer(): void {
    const s = this.me!.state;
    if (s.offer === Move.None) return;
    s.yank = s.offer;
    s.offer = Move.None;
    this.yankUntil = this.now + YANK_MS;
    this.ctx.sfx.play('yank');
  }

  /** Someone hit your offer: it's done. */
  offerTaken(): void {
    const s = this.me?.state;
    if (!s) return;
    s.offer = Move.None;
    this.pending.since = this.now;
  }

  private startSwing(p: Partner, move: Move): void {
    const s = this.me!.state;
    s.offer = Move.None;
    const points: [Vec3, Vec3] = [v3(), v3()];
    this.aimAt(p, points);
    this.swing = {
      target: p.id,
      move,
      timing: timingGrade(ringError(this.ringPhase())),
      start: this.now,
      contactAt: this.now + SWING_MS,
      air: s.z > 0.15,
      grade: null,
      points,
    };
    this.ctx.sfx.play('whoosh', undefined, 0.5);
  }

  /** Where a swing's hands go on a partner: their offer's hands, or where they were before it was pulled away. */
  private aimAt(p: Partner, out: [Vec3, Vec3]): void {
    const trail = followHands(p, this.now);
    const sides = offerSides(p);
    if (sides.length === 2) {
      handOf(p, 1, out[0]); // facing each other, your right meets their left
      handOf(p, 0, out[1]);
    } else if (sides.length === 1) {
      offerPoint(p, out[0]);
    } else if (trail.offered.length) {
      Object.assign(out[0], trail.offered[0]);
      if (trail.offered[1]) Object.assign(out[1], trail.offered[1]);
    } else {
      offerPoint(p, out[0]);
    }
  }

  private stepSwing(): void {
    const sw = this.swing;
    if (!sw) return;
    if (sw.grade === null && this.now >= sw.contactAt) {
      const p = partnerById(this.ctx.world, sw.target);
      let grade: Grade;
      if (!p) grade = Grade.Whiff;
      else if (p.offer === Move.None) grade = p.yank !== Move.None ? Grade.TooSlow : Grade.Whiff;
      else if (p.offer !== sw.move) grade = Grade.Awkward;
      else grade = sw.timing;
      if (p && p.offer !== Move.None) this.aimAt(p, sw.points);
      sw.grade = grade;
      const at = sw.move === Move.Double ? mid(sw.points[0], sw.points[1], pc) : sw.points[0];
      if (p) this.sendFive(p, sw.move, grade, at, sw.air);
      if (grade !== Grade.Whiff && grade !== Grade.TooSlow) this.body.smacked(null, grade === Grade.Perfect ? 1 : 0.6);
    }
    if (this.now >= sw.contactAt + RECOVER_MS) this.swing = null;
  }

  private startSlap(): void {
    const s = this.me!.state;
    if (this.slap || this.swing) return;
    const p = this.slapCheck === 'ok' ? this.slapTarget : null;
    const point = v3();
    if (p) partnerButt(p, point);
    else posePoint(s.x, s.y, this.feetZ(), s.yaw, { f: 0.7, s: 0.1, z: 0.95 }, false, point);
    this.slap = { target: p?.id ?? 0, start: this.now, at: this.now + SLAP_MS, resolved: false, point };
    // standing up, everyone hears it coming; creeping, nobody does
    s.windup = p?.id ?? 0;
    s.offer = Move.None;
  }

  private stepSlap(): void {
    const sl = this.slap;
    if (!sl) return;
    const s = this.me!.state;
    const p = sl.target ? partnerById(this.ctx.world, sl.target) : null;
    if (p && !sl.resolved) partnerButt(p, sl.point);
    if (!sl.resolved && this.now >= sl.at) {
      sl.resolved = true;
      s.windup = 0;
      if (p && Math.hypot(p.x - s.x, p.y - s.y) <= SLAP_RANGE + 0.4 && !p.noSlaps) {
        this.sendSlap(p, bearingFrom(p.x, p.y, p.heading, s.x, s.y) < FACING, sl.point);
      } else {
        this.ctx.sfx.play('whoosh');
      }
    }
    if (this.now >= sl.at + RECOVER_MS) this.slap = null;
  }

  /** Put a flat player's hands where the rules say: by their sides, held out, or on their way to someone. */
  private poseHands(): void {
    const s = this.me!.state;
    const feet = this.feetZ();
    const eye = s.head;
    let reach = 0;
    let fists = 0;
    const right = posePoint(s.x, s.y, feet, s.yaw, REST, false, pa);
    const left = posePoint(s.x, s.y, feet, s.yaw, REST, true, pb);
    if (s.offer !== Move.None) {
      offerPose(s.offer, eye, pose);
      posePoint(s.x, s.y, feet, s.yaw, pose, false, right);
      reach |= 1;
      if (s.offer === Move.Double) {
        posePoint(s.x, s.y, feet, s.yaw, pose, true, left);
        reach |= 2;
      }
      if (s.offer === Move.Fist) fists |= 1;
    }
    const sw = this.swing;
    if (sw) {
      const t = (this.now - sw.start) / SWING_MS;
      this.strike(right, sw.points[0], t, false);
      reach |= 1;
      if (sw.move === Move.Double) {
        this.strike(left, sw.points[1], t, true);
        reach |= 2;
      }
      if (sw.move === Move.Fist) fists |= 1;
    }
    const sl = this.slap;
    if (sl) {
      this.strike(right, sl.point, (this.now - sl.start) / SLAP_MS, false, true);
      reach |= 1;
    }
    this.putHand(Side.Right, right);
    this.putHand(Side.Left, left);
    s.reach = reach;
    s.fists = fists;
  }

  /** A hand winding back and then going for `target`, `t` of the way there (past 1 it stays). */
  private strike(hand: Vec3, target: Vec3, t: number, mirror: boolean, low = false): void {
    const s = this.me!.state;
    const feet = this.feetZ();
    const wind: HandPose = low ? { f: -0.25, s: 0.42, z: 1.45 } : { f: -0.05, s: 0.36, z: clamp(target.z - feet + 0.25, 1, s.head + 0.45) };
    const back = posePoint(s.x, s.y, feet, s.yaw, wind, mirror, pc);
    if (t < 0.4) lerp(hand, back, ease(t / 0.4), hand);
    else lerp(back, target, ease(Math.min(1, (t - 0.4) / 0.6)), hand);
  }

  private putHand(side: Side, p: Vec3): void {
    const s = this.me!.state;
    const feet = this.feetZ();
    const x = clamp(p.x - s.x, -1.5, 1.5);
    const y = clamp(p.y - s.y, -1.5, 1.5);
    const z = clamp(p.z - feet, 0, 2.5);
    if (side === Side.Left) Object.assign(s, { lhx: x, lhy: y, lhz: z, laimYaw: s.yaw, laimPitch: 0 });
    else Object.assign(s, { hx: x, hy: y, hz: z, aimYaw: s.yaw, aimPitch: 0 });
  }

  // -------------------------------------------------------------------------
  // Tracked hands
  // -------------------------------------------------------------------------

  private trackedHands(hands: [HandIntent, HandIntent]): void {
    const s = this.me!.state;
    const feet = this.feetZ();
    for (const side of [Side.Right, Side.Left]) {
      const h = this.hands[side];
      const r = this.read[side];
      r.tracked = hands[side].tracked;
      r.x = h.origin.x - s.x;
      r.y = h.origin.y - s.y;
      r.z = h.origin.z - feet;
      r.fist = hands[side].grab;
      r.speed = Math.hypot(h.velocity.x, h.velocity.y, h.velocity.z);
    }
    s.reach = 3;
    s.fists = (hands[Side.Right].grab ? 1 : 0) | (hands[Side.Left].grab ? 2 : 0);
    this.readOffer();
    this.contacts(hands);
    if (this.double && this.now - this.double.at > DOUBLE_MS) {
      // only one hand made it: a plain high five
      const d = this.double;
      this.double = null;
      const p = partnerById(this.ctx.world, d.partner);
      if (p) this.sendFive(p, Move.High, speedGrade(d.speed), d.point, false);
    }
  }

  /** A pose held for a moment is an offer; leaving it fast pulls it away. */
  private readOffer(): void {
    const s = this.me!.state;
    const o = classifyHands(s.head, s.yaw, this.read);
    const p = this.pending;
    if (o.move !== p.move || o.left !== p.left) Object.assign(p, o, { since: this.now });
    if (o.move === Move.None) {
      if (s.offer === Move.None) return;
      const sides = s.offer === Move.Double ? [0, 1] : [s.offerLeft ? 1 : 0];
      if (sides.some((side) => this.read[side].speed > YANK_SPEED)) this.yankOffer();
      else s.offer = Move.None;
      return;
    }
    if (this.now - p.since < HOLD_MS || (o.move === s.offer && o.left === s.offerLeft)) return;
    s.offer = o.move;
    s.offerLeft = o.left;
    s.yank = Move.None;
    this.offerAt = this.now;
  }

  /** A tracked hand swung into someone's hand, or their backside. */
  private contacts(hands: [HandIntent, HandIntent]): void {
    const me = this.me!;
    const s = me.state;
    const now = this.now;
    for (const p of partnersNear(this.ctx.world, s.x, s.y, 2.8, me.id)) {
      const trail = followHands(p, now);
      if ((this.cooldowns.get(p.id) ?? 0) > now) continue;
      const targets = this.targetsOn(p, trail);
      contact: for (const side of [Side.Right, Side.Left]) {
        if (!hands[side].tracked) continue;
        const h = this.hands[side];
        const speed = Math.hypot(h.velocity.x, h.velocity.y, h.velocity.z);
        if (speed < MIN_SWING) continue;
        const at = h.origin;
        if (!p.noSlaps && !this.noSlaps && (this.slapped.get(p.id) ?? 0) <= now && speed >= SLAP_SPEED && dist(at, partnerButt(p, pa)) < BUTT_CONTACT) {
          this.sendSlap(p, bearingFrom(p.x, p.y, p.heading, s.x, s.y) < FACING, at);
          this.body.smacked(side, 0.8);
          break;
        }
        for (const t of targets) {
          if (dist(at, t.point) >= CONTACT) continue;
          // this hand's half of a double has landed: it's the other one's turn
          if (this.double?.partner === p.id && this.double.side === side) continue contact;
          this.handContact(p, side, speed, t.point, t.side, hands[side].grab);
          if (this.double) continue contact;
          break contact;
        }
      }
    }
  }

  /** The hands of someone's that a tracked hand could meet: what they're offering (or just pulled away), or any that are up. */
  private targetsOn(p: Partner, trail: ReturnType<typeof followHands>): { point: Vec3; side: 0 | 1 }[] {
    const sides = offerSides(p);
    if (sides.length) return sides.map((side) => ({ point: leadHand(trail, side, v3()), side }));
    if (p.yank !== Move.None) return trail.offered.map((point, i) => ({ point, side: i as 0 | 1 }));
    const out: { point: Vec3; side: 0 | 1 }[] = [];
    for (const side of [0, 1] as const) {
      if (!(p.reach & (1 << side))) continue;
      const point = leadHand(trail, side, v3());
      // a hand hanging by someone's side isn't up for anything
      if (Math.hypot(point.x - p.x, point.y - p.y) < 0.3 && point.z - p.feet < 1.05) continue;
      out.push({ point, side });
    }
    return out;
  }

  private handContact(p: Partner, side: Side, speed: number, point: Vec3, theirSide: 0 | 1, fist: boolean): void {
    if (p.offer === Move.Double) {
      const d = this.double;
      if (d && d.partner === p.id && d.side !== side) {
        this.double = null;
        this.sendFive(p, Move.Double, speedGrade(Math.min(speed, d.speed)), mid(d.point, point, v3()), false);
        this.body.smacked(side, 1);
      } else if (!d) {
        this.double = { partner: p.id, side, speed, at: this.now, point: { ...point } };
        this.body.smacked(side, 0.5);
      }
      return;
    }
    let move: Move;
    let grade: Grade;
    if (p.offer !== Move.None) {
      move = p.offer;
      grade = (p.offer === Move.Fist) !== fist ? Grade.Awkward : speedGrade(speed);
    } else if (p.yank !== Move.None) {
      move = p.yank;
      grade = Grade.TooSlow;
    } else {
      const theirs = !!(p.fists & (1 << theirSide));
      move = fist && theirs ? Move.Fist : moveAt(point.z - this.feetZ(), this.me!.state.head, false);
      grade = fist !== theirs ? Grade.Awkward : speedGrade(speed);
    }
    this.sendFive(p, move, grade, point, false);
    if (grade !== Grade.TooSlow) this.body.smacked(side, grade === Grade.Perfect ? 1 : 0.6);
  }

  // -------------------------------------------------------------------------
  // Telling everyone
  // -------------------------------------------------------------------------

  private sendFive(p: Partner, move: Move, grade: Grade, at: Vec3, air: boolean): void {
    this.cooldowns.set(p.id, this.now + PAIR_MS);
    tellFive(this.ctx, this.me!.id, p.id, move, grade, at, air);
  }

  private sendSlap(p: Partner, denied: boolean, at: Vec3): void {
    this.cooldowns.set(p.id, this.now + PAIR_MS * 2);
    this.slapped.set(p.id, this.now + SLAP_REST_MS);
    tellSlap(this.ctx, this.me!.id, p.id, denied, at);
  }

  /** Your backside was slapped: stumble forward a step. */
  stumble(fromX: number, fromY: number): void {
    const s = this.me?.state;
    if (!s) return;
    const d = Math.hypot(s.x - fromX, s.y - fromY) || 1;
    this.nudge(((s.x - fromX) / d) * 0.35, ((s.y - fromY) / d) * 0.35);
  }

  /** Is anyone behind you, standing up where you'd hear them, or winding up a slap? */
  private listen(): void {
    const me = this.me!;
    const s = me.state;
    let alert: PalRole['alert'] = null;
    for (const p of partnersNear(this.ctx.world, s.x, s.y, ALERT_RANGE, me.id)) {
      if (p.sneak) continue;
      let windup: boolean;
      let lurking: boolean;
      if (p.buddy) {
        // buddies stroll about behind people all the time; only the mascot on the prowl is worth hearing
        const r = (p.e as BuddyEntity).render;
        windup = r.mode === BuddyMode.Slap && r.target === me.id;
        lurking = r.mode === BuddyMode.Sneak && r.target === me.id;
      } else {
        windup = (p.e as PalEntity).render.windup === me.id;
        lurking = true;
      }
      if (windup) {
        alert = 'windup';
        break;
      }
      if (lurking && bearingFrom(s.x, s.y, s.yaw, p.x, p.y) > BEHIND) alert = 'behind';
    }
    this.alert = alert;
  }
}

function trackedHand(): TrackedHand {
  return { tracked: false, x: 0, y: 0, z: 0, fist: false, speed: 0 };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function mid(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  out.x = (a.x + b.x) / 2;
  out.y = (a.y + b.y) / 2;
  out.z = (a.z + b.z) / 2;
  return out;
}

function lerp(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}
