import { Avatar, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import { NO_TOOL } from '../crossplay/tool';
import { BALL_RADIUS, CLUBS, Club, Flight, ballAt, launch, lieFactor, stepBall, strike, type BallEvent, type BallState } from './ball';
import { BOARD_REACH, EJECT_FORCE, PARKED, cartHeading, pushOutOfCarts, seatOf, type Crash } from './carts';
import { angleDiff, clamp, type BallEntity, type CartEntity, type GolfContext, type GolferEntity, type MatchEntity, type Vec3 } from './context';
import { HALF, HOLES, LIE_NAMES, Lie, type Hole } from './course';
import { Ball as BallDef, BallMode, Cart, Feed, Golfer as GolferDef, Knock, Noise, Phase, Whack } from './defs';
import type { GolfIntent } from './intent';
import { TOOLS, clubTool, meter, type ClubTool, type Use } from './kit';
import { maxStrokes, scoreName, unfinishedScore } from './match';

/** How the golfer's rules reach back to the device playing it. */
export interface GolferBody extends AvatarBody {
  /** Got into a cart, or out of one. */
  seated(seated: boolean): void;
  /** Knocked flat. */
  knocked(): void;
  /** Played your ball: `power` 0..1. */
  struck(power: number): void;
  /** Your ball dropped. */
  holed(strokes: number, par: number): void;
}

export type GolferFrontend = AvatarFrontend<GolfIntent> &
  GolferBody & {
    /** Whether to draw yourself sitting in your cart, e.g. from a camera behind it. */
    readonly showDriver: boolean;
  };

const NO_BODY: GolferBody = {
  platform: Platform.Desktop,
  moved() {},
  placed() {},
  hurt() {},
  used() {},
  died() {},
  seated() {},
  knocked() {},
  struck() {},
  holed() {},
};

/** Walk up this close to your resting ball and you stand over it to play it. */
export const ADDRESS_RANGE = 1.3;
/** Where you stand over the ball: this far to its side. */
const STANCE = 0.72;
/** How far a crosshair's club reaches someone, and how wide in front. */
const MELEE_REACH = 2.1;
const MELEE_ANGLE = 1.0;
const MELEE_COOLDOWN = 650;
const MELEE_KNOCK = 7;
/** A tracked club head must move this fast to hit a ball, or this fast to hit someone. */
const BALL_SWING_SPEED = 0.6;
const BODY_SWING_SPEED = 4.5;
const DOWN_MS = 2300;
/** After getting up, a moment when nothing can knock you down again. */
const GRACE_MS = 1600;
/** A ball faster than this knocks over whoever it hits. */
const FORE_SPEED = 14;

const tmp: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The player in Peer Golf: an avatar walking the course with four clubs, playing their own ball on the hole everyone's
 * playing, clubbing anyone who gets in the way, and driving a cart when they can get one. Only sees an intent, and
 * reaches the device through `body`.
 */
export class Golfer extends Avatar<GolfIntent, GolferBody, ClubTool> implements Role<GolfIntent, GolferFrontend> {
  body: GolferBody = NO_BODY;
  /** The ball as this peer simulates it. */
  readonly sim: BallState = ballAt(0, 0, 0);
  /** Standing over the ball (a crosshair golfer), aiming along `aim`. */
  addressing = false;
  aimHeading = 0;
  /** Drawing the club back on a crosshair, and how far: the swing's power. */
  charging = false;
  charge = 0;
  /** The cart being driven. */
  cart: CartEntity | null = null;
  /** When the knocked-down golfer gets up, ms. */
  downUntil = 0;
  /** Seconds of the last shot's follow-through left, for posing the arms. */
  private follow = 0;
  private melee = 0;
  private nextMelee = 0;
  private chargeFrom = 0;
  private powerOverride: number | null = null;
  /** Walked away from the ball since leaving it, so walking back stands over it again. */
  private rearmed = true;
  /** Walked onto the ball with a move still held: that move doesn't step away until it's let go. */
  private arrivedWalking = false;
  private graceUntil = 0;
  private readonly knock = { x: 0, y: 0 };
  /** A cart asked for and not yet handed over, and until when to wait for it, ms. */
  private boarding: { cart: CartEntity; until: number } | null = null;
  /** Where the ball was played from, for a penalty drop. */
  private readonly lastSpot: Vec3 = { x: 0, y: 0, z: 0 };
  /** Golfers this shot has already hit, so a rolling ball only knocks each once. */
  private readonly fored = new Set<number>();
  private placedOnHole = false;
  private readonly spawnedAt = { x: 0, y: 0 };
  private noiseAt = 0;
  /** Just got out of a cart: not straight back in with the same press. */
  private boardAfter = 0;

  constructor(readonly ctx: GolfContext) {
    super(TOOLS);
  }

  get me(): GolferEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  get seated(): boolean {
    return !!this.cart;
  }

  get down(): boolean {
    return this.now < this.downUntil;
  }

  /** The club out on a crosshair. */
  get club(): Club {
    return this.inventory.current?.club ?? Club.Driver;
  }

  get ball(): BallEntity | null {
    return this.ctx.ball;
  }

  /** The hole this golfer's ball is on. */
  get hole(): Hole {
    return this.ctx.course.holes[Math.min(HOLES - 1, this.ball?.state.hole ?? 0)];
  }

  /** Whether the ball can be played now: at rest, on the hole being played. */
  get playable(): boolean {
    const b = this.ball?.state;
    const m = this.ctx.match()?.state;
    return !!b && !!m && m.phase === Phase.Playing && b.mode === BallMode.Rest && b.round === m.round && b.hole === m.hole;
  }

  get lie(): Lie {
    return this.ctx.course.lieAt(this.sim.x, this.sim.y);
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    p.x += dx;
    p.y += dy;
  }

  protected override collide(p: { x: number; y: number }, z: number): void {
    const { course, world } = this.ctx;
    course.pushOut(p, RADIUS);
    pushOutOfCarts(world, p, RADIUS, course.heightAt(p.x, p.y) + z);
    const edge = course.outOfBounds(p.x, p.y);
    if (edge) {
      p.x = clamp(p.x, 4, 2 * HALF - 4);
      p.y = clamp(p.y, 4, 2 * HALF - 4);
    }
  }

  protected override groundAt(x: number, y: number): number {
    return this.ctx.course.heightAt(x, y);
  }

  protected override switchedTool(): void {
    this.ctx.sfx.play('switch');
  }

  /** Into the world beside the clubhouse, with a ball waiting for the hole being played. */
  spawn(): void {
    const { ctx } = this;
    const { barn } = ctx.course;
    // between the clubhouse and the back of the cart barn
    const back = -5.5 + (Math.random() - 0.5) * 2;
    const across = (Math.random() - 0.5) * 16;
    const x = barn.x + Math.cos(barn.heading) * back - Math.sin(barn.heading) * across;
    const y = barn.y + Math.sin(barn.heading) * back + Math.cos(barn.heading) * across;
    const skin = Math.floor(Math.random() * 30);
    ctx.me = ctx.world.spawn(GolferDef, { x, y, name: ctx.playerName, skin, card: new Uint8Array(HOLES) });
    ctx.ball = ctx.world.spawn(BallDef, { x, y, z: ctx.course.heightAt(x, y), golfer: ctx.me.id, mode: BallMode.Out, color: skin });
    ctx.me.state.ball = ctx.ball.id;
    Object.assign(this.sim, ballAt(x, y, ctx.course.heightAt(x, y)));
    this.spawnedAt.x = x;
    this.spawnedAt.y = y;
    this.heading = barn.heading;
    this.inventory.select(TOOLS.all[Club.Driver]);
    ctx.world.setFocus(x, y);
  }

  update(dt: number, intent: GolfIntent): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    this.playBall(dt);
    this.follow = Math.max(0, this.follow - dt);
    this.melee = Math.max(0, this.melee - dt);

    const boarded = !!this.boarding && this.board();
    if (this.cart) {
      // the press that got you in doesn't also get you out
      if (boarded) intent.interact = false;
      this.drive(intent);
      ctx.world.setFocus(s.x, s.y);
      return;
    }

    s.down = this.down;
    if (s.down) {
      this.lieFlat(dt);
      if (intent.head) this.walkTracked(dt, intent.head, intent, false);
      ctx.world.setFocus(s.x, s.y);
      return;
    }

    if (intent.interact && this.tryBoard()) return;
    const tracked = !!intent.head;
    if (tracked) this.walkTracked(dt, intent.head!, intent, true);
    else this.address(dt, intent);

    this.powerOverride = intent.power;
    if (intent.hands) {
      this.leaveAddress();
      this.useHands(intent.hands, dt);
    } else {
      this.useCrosshair(intent, dt);
      this.poseClub();
    }
    s.address = this.addressing;
    s.charge = this.charging ? this.charge : 0;
    ctx.world.setFocus(s.x, s.y);
  }

  /** After the physics step: sit in the cart where it went, and what its crashes did. */
  afterPhysics(crashes: readonly Crash[]): void {
    const { ctx } = this;
    for (const crash of crashes) {
      const driven = crash.cart === this.cart;
      if (crash.force > EJECT_FORCE * 0.4 && ctx.now > this.noiseAt) {
        this.noiseAt = ctx.now + 350;
        ctx.world.send(Noise, { kind: Whack.Crash, x: crash.x, y: crash.y, z: crash.z, power: clamp(crash.force / EJECT_FORCE, 0.2, 1.5) }, { to: 'near', x: crash.x, y: crash.y, radius: 200 });
      }
      if (driven && crash.force > EJECT_FORCE) {
        const s = crash.cart.state;
        const f = cartHeading(crash.cart, true);
        this.leaveCart(false);
        this.knockDown(Math.cos(f) * s.speed * 0.6, Math.sin(f) * s.speed * 0.6, 1600);
        ctx.world.send(Feed, { text: `${this.me!.state.name} was thrown out of a cart` }, { to: 'all' });
      }
    }
    if (this.cart) this.placeInSeat();
  }

  // -------------------------------------------------------------------------
  // The ball
  // -------------------------------------------------------------------------

  /** Keep the ball on the hole being played, move it, and score it. */
  private playBall(dt: number): void {
    const { ctx } = this;
    const me = this.me!;
    const ball = this.ball;
    const match = ctx.match();
    if (!ball || !match) return;
    const m = match.state;
    const b = ball.state;
    const s = me.state;
    this.arrive(match);

    if (s.round !== m.round) {
      s.round = m.round;
      s.card = new Uint8Array(HOLES);
    }
    const onHole = b.round === m.round && b.hole === m.hole;
    const inPlay = b.mode === BallMode.Rest || b.mode === BallMode.Moving;
    if (!onHole) {
      // the hole moved on without this ball finishing: score what it would have taken
      if (inPlay && b.round === m.round && b.hole < HOLES && !s.card[b.hole] && b.strokes > 0) this.score(b.hole, unfinishedScore(this.ctx.course.holes[b.hole].par, b.strokes));
      if (m.phase === Phase.Playing) this.teeUp(m.hole, m.round);
      else if (inPlay) b.mode = BallMode.Out;
    } else if (m.phase !== Phase.Playing && inPlay) {
      // time's up: a ball that was played scores what it would have taken; one never struck just isn't counted
      const par = this.hole.par;
      b.mode = BallMode.Out;
      this.leaveAddress();
      if (b.strokes > 0 && !s.card[b.hole]) {
        this.score(b.hole, unfinishedScore(par, b.strokes));
        ctx.hud.message(`Out of time: ${unfinishedScore(par, b.strokes)} on hole ${b.hole + 1}`);
      }
    }

    if (this.sim.flight === Flight.Air || this.sim.flight === Flight.Rolling) {
      const event = stepBall(this.sim, ctx.course, this.hole.pin, dt);
      if (event) this.ballEvent(event);
      if (moving(this.sim)) this.fore();
    }
    b.x = this.sim.x;
    b.y = this.sim.y;
    b.z = this.sim.z;
  }

  /** Just arrived, and the match turns out to be on a hole far from the clubhouse: go straight to its tee. */
  private arrive(match: MatchEntity): void {
    if (this.placedOnHole) return;
    this.placedOnHole = true;
    const s = this.me!.state;
    if (Math.hypot(s.x - this.spawnedAt.x, s.y - this.spawnedAt.y) > 15 || match.state.hole === 0) return;
    const at = this.ctx.course.arrival(match.state.hole);
    this.heading = at.heading;
    this.teleport(at.x, at.y);
  }

  private teeUp(hole: number, round: number): void {
    const b = this.ball!.state;
    const spot = this.ctx.course.teeSpot(hole, this.me!.id);
    Object.assign(this.sim, ballAt(spot.x, spot.y, spot.z + BALL_RADIUS * 0.5));
    Object.assign(b, { hole, round, strokes: 0, mode: BallMode.Rest });
    this.leaveAddress();
    this.rearmed = true;
    const h = this.ctx.course.holes[hole];
    this.ctx.hud.message(`Hole ${hole + 1}: par ${h.par}, ${Math.round(h.length)} m. Your ball's on the tee.`);
  }

  private score(hole: number, strokes: number): void {
    const s = this.me!.state;
    const card = new Uint8Array(HOLES);
    card.set(s.card);
    card[hole] = strokes;
    s.card = card;
  }

  private ballEvent(event: BallEvent): void {
    const { ctx } = this;
    const b = this.ball!.state;
    const name = this.me!.state.name;
    const at = { x: this.sim.x, y: this.sim.y, z: this.sim.z };
    switch (event) {
      case 'holed': {
        b.mode = BallMode.Holed;
        const par = this.hole.par;
        this.score(b.hole, b.strokes);
        this.body.holed(b.strokes, par);
        ctx.world.send(Feed, { text: `${name}: ${scoreName(b.strokes, par)} on hole ${b.hole + 1} (${b.strokes})` }, { to: 'all' });
        break;
      }
      case 'water':
      case 'out':
        b.strokes++;
        if (event === 'water') ctx.world.send(Noise, { kind: Whack.Splash, x: at.x, y: at.y, z: ctx.course.pondAt(at.x, at.y)?.z ?? at.z, power: 1 }, { to: 'near', x: at.x, y: at.y, radius: 200, self: true });
        ctx.hud.message(event === 'water' ? 'In the water: a stroke penalty, and play it again from where you were' : 'Out of bounds: a stroke penalty, and play it again');
        Object.assign(this.sim, ballAt(this.lastSpot.x, this.lastSpot.y, this.lastSpot.z));
        b.mode = BallMode.Rest;
        this.rested();
        break;
      case 'rest':
        b.mode = BallMode.Rest;
        this.rested();
        break;
      case 'tree':
        ctx.sfx.play('tock', at);
        break;
      case 'lip':
        ctx.sfx.play('lip', at);
        break;
      case 'bounce':
        break;
    }
  }

  /** The ball stopped: out of strokes, it's picked up; otherwise it's ready to play again. */
  private rested(): void {
    const b = this.ball!.state;
    const par = this.hole.par;
    this.rearmed = true;
    if (b.strokes >= maxStrokes(par)) {
      b.mode = BallMode.Out;
      this.score(b.hole, maxStrokes(par));
      this.ctx.hud.message(`That's ${b.strokes}: picked up, and ${maxStrokes(par)} goes on your card`);
      return;
    }
    const lie = this.lie;
    const d = Math.round(Math.hypot(this.sim.x - this.hole.pin.x, this.sim.y - this.hole.pin.y));
    this.ctx.hud.message(`${LIE_NAMES[lie]}, ${d} m to the pin`);
  }

  /** A fast ball knocks over whoever it flies into. */
  private fore(): void {
    const { ctx } = this;
    const sim = this.sim;
    const speed = Math.hypot(sim.vx, sim.vy, sim.vz);
    if (speed < FORE_SPEED) return;
    for (const g of ctx.world.query(sim.x, sim.y, 0.6, GolferDef) as Iterable<GolferEntity>) {
      if (g === this.me || g.render.down || g.render.cart || this.fored.has(g.id)) continue;
      const feet = ctx.course.heightAt(g.x, g.y) + g.render.z;
      if (sim.z < feet || sim.z > feet + g.render.head + 0.2) continue;
      if (Math.hypot(sim.x - g.x, sim.y - g.y) > 0.4) continue;
      this.fored.add(g.id);
      const k = speed * 0.08;
      ctx.world.command(Knock, { target: g.id, by: this.me!.id, kx: (sim.vx / speed) * k * 3, ky: (sim.vy / speed) * k * 3, cause: 2 });
      ctx.world.send(Feed, { text: `${this.me!.state.name}'s ball hit ${g.render.name}. Fore!` }, { to: 'all' });
      sim.vx *= -0.2;
      sim.vy *= -0.2;
      sim.vz = Math.min(sim.vz, 0);
    }
  }

  /** Send the ball off: count the stroke and remember where it was played from. */
  private played(power: number): void {
    const { ctx } = this;
    const b = this.ball!.state;
    this.lastSpot.x = this.sim.x;
    this.lastSpot.y = this.sim.y;
    this.lastSpot.z = this.sim.z;
    b.strokes++;
    b.mode = BallMode.Moving;
    this.fored.clear();
    this.follow = 0.55;
    this.body.struck(power);
    ctx.sfx.play(this.club === Club.Putter ? 'putt' : 'thwack', { x: this.sim.x, y: this.sim.y, z: this.sim.z }, 0.5 + power * 0.6);
  }

  /** The club suited to where the ball is and how far it has to go. */
  suggestedClub(): Club {
    const lie = this.lie;
    const pin = this.hole.pin;
    const d = Math.hypot(this.sim.x - pin.x, this.sim.y - pin.y);
    if (lie === Lie.Green || (lie === Lie.Fairway && d < 10)) return Club.Putter;
    if (lie === Lie.Sand) return Club.Wedge;
    if (d > 145 && lie !== Lie.Rough) return Club.Driver;
    if (d > 95) return Club.Iron;
    return Club.Wedge;
  }

  // -------------------------------------------------------------------------
  // Standing over the ball (a crosshair)
  // -------------------------------------------------------------------------

  private address(dt: number, intent: GolfIntent): void {
    const s = this.me!.state;
    const sim = this.sim;
    const dist = Math.hypot(s.x - sim.x, s.y - sim.y);
    const moving = Math.abs(intent.forward) + Math.abs(intent.strafe) > 0.2 || intent.jump;
    if (this.addressing) {
      if (!moving) this.arrivedWalking = false;
      if (!this.playable || (((moving && !this.arrivedWalking) || intent.address) && !this.charging)) {
        this.leaveAddress();
        this.rearmed = false;
        if (!moving) this.walk(dt, intent);
        return;
      }
      this.aimHeading += intent.turn * 0.6;
      this.heading = this.aimHeading;
      this.pitch = clamp(this.pitch + intent.lookUp, -0.6, 0.5);
      this.stance();
      return;
    }
    if (!this.rearmed && dist > 3) this.rearmed = true;
    this.walk(dt, intent);
    const near = Math.hypot(s.x - sim.x, s.y - sim.y);
    if (this.playable && ((near < ADDRESS_RANGE && this.rearmed) || (intent.address && near < 6))) {
      this.standOver();
      this.arrivedWalking = moving;
    }
  }

  /** Step up to the ball, aimed at the pin, with the club for the shot. */
  private standOver(): void {
    const pin = this.hole.pin;
    this.addressing = true;
    this.aimHeading = Math.atan2(pin.y - this.sim.y, pin.x - this.sim.x);
    this.heading = this.aimHeading;
    this.pitch = -0.15;
    const club = clubTool(this.suggestedClub());
    if (this.inventory.current !== club) {
      this.inventory.select(club);
      this.switchedTool();
    }
    this.stance();
    this.place(this.me!.state.x, this.me!.state.y);
  }

  /** Stand to the ball's side, facing it, with the target on your left. */
  private stance(): void {
    const s = this.me!.state;
    const side = this.aimHeading - Math.PI / 2;
    s.x = this.sim.x + Math.cos(side) * STANCE;
    s.y = this.sim.y + Math.sin(side) * STANCE;
    s.z = 0;
    s.yaw = this.aimHeading + Math.PI / 2;
    s.pitch = -0.5;
  }

  leaveAddress(): void {
    if (!this.addressing) return;
    this.addressing = false;
    this.cancelSwing();
  }

  /** The trigger went down over the ball: start the club back. */
  drawBack(): void {
    if (!this.playable) return;
    this.charging = true;
    this.chargeFrom = this.now;
    this.charge = 0;
  }

  /** Still held: the meter runs (or the device says how far it's drawn). */
  holdBack(): void {
    if (!this.charging) return;
    this.charge = this.powerOverride ?? meter((this.now - this.chargeFrom) / 1000);
  }

  /** The trigger came up: swing through the ball with whatever power it had. */
  letGo(): void {
    if (!this.charging) return;
    const power = this.powerOverride ?? this.charge;
    this.charging = false;
    this.charge = 0;
    if (power < 0.02 || !this.playable) return;
    strike(this.sim, this.club, power, this.aimHeading, this.lie);
    this.played(power);
  }

  cancelSwing(): void {
    this.charging = false;
    this.charge = 0;
  }

  // -------------------------------------------------------------------------
  // Hitting people
  // -------------------------------------------------------------------------

  /** A crosshair's swing at whoever's in front. */
  swingAtPeople(): void {
    const { ctx } = this;
    if (this.now < this.nextMelee) return;
    this.nextMelee = this.now + MELEE_COOLDOWN;
    this.melee = 0.35;
    const s = this.me!.state;
    const feet = this.feetZ();
    let hit: GolferEntity | null = null;
    let best = Infinity;
    for (const g of ctx.world.query(s.x, s.y, MELEE_REACH + 1, GolferDef) as Iterable<GolferEntity>) {
      if (g === this.me || g.render.down) continue;
      const dx = g.x - s.x;
      const dy = g.y - s.y;
      const d = Math.hypot(dx, dy);
      const gz = ctx.course.heightAt(g.x, g.y) + g.render.z;
      if (d > MELEE_REACH || Math.abs(gz - feet) > 1.5 || Math.abs(angleDiff(this.heading, Math.atan2(dy, dx))) > MELEE_ANGLE) continue;
      if (d < best) {
        best = d;
        hit = g;
      }
    }
    if (!hit) {
      ctx.world.send(Noise, { kind: Whack.Swish, x: s.x, y: s.y, z: feet + 1.2, power: 0.6 }, { to: 'near', x: s.x, y: s.y, radius: 40, self: true });
      this.body.used(null, this.inventory.current!, { kick: 0.4 });
      return;
    }
    const a = Math.atan2(hit.y - s.y, hit.x - s.x);
    this.whack(hit, Math.cos(a) * MELEE_KNOCK, Math.sin(a) * MELEE_KNOCK, hit.x, hit.y, feet + 1.2);
    this.body.used(null, this.inventory.current!, { kick: 1, hit: 'body' });
  }

  private whack(target: GolferEntity, kx: number, ky: number, x: number, y: number, z: number): void {
    const { ctx } = this;
    ctx.world.command(Knock, { target: target.id, by: this.me!.id, kx, ky, cause: 0 });
    ctx.world.send(Noise, { kind: Whack.Bonk, x, y, z, power: 1 }, { to: 'near', x, y, radius: 120, self: true });
  }

  /**
   * A tracked hand's club head moved from `from` to `use.origin`: through the ball plays it, into someone knocks them
   * over. `swing.next` holds off a second hit on someone from the same swing.
   */
  swingThrough(club: Club, use: Use, from: Vec3, to: Vec3, swing: { next: number }): void {
    const { ctx } = this;
    const v = use.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);

    if (this.playable && speed > BALL_SWING_SPEED && segmentDistance(from, to, this.sim) < BALL_RADIUS + 0.055) {
      const spec = CLUBS[club];
      const flat = Math.hypot(v.x, v.y);
      const heading = flat > 0.2 ? Math.atan2(v.y, v.x) : Math.atan2(use.aim.y, use.aim.x);
      const ballSpeed = Math.min(spec.speed * lieFactor(club, this.lie), speed * spec.smash);
      launch(this.sim, club, ballSpeed, heading, spec.loft);
      this.played(ballSpeed / spec.speed);
      use.effect({ kick: 0.4 + (ballSpeed / spec.speed) * 0.8, hit: 'body' });
      return;
    }

    if (speed < BODY_SWING_SPEED || this.now < swing.next) return;
    for (const g of ctx.world.query(to.x, to.y, 1.2, GolferDef) as Iterable<GolferEntity>) {
      if (g === this.me || g.render.down) continue;
      const feet = ctx.course.heightAt(g.x, g.y) + g.render.z;
      if (Math.hypot(to.x - g.x, to.y - g.y) > 0.38 || to.z < feet || to.z > feet + g.render.head + 0.25) continue;
      swing.next = this.now + 500;
      const k = Math.min(10, speed * 0.7) / (Math.hypot(v.x, v.y) || 1);
      this.whack(g, v.x * k, v.y * k, to.x, to.y, to.z);
      use.effect({ kick: 1, hit: 'body' });
      return;
    }
  }

  /** Someone clubbed you, ran you over, hit you with a ball, or rammed the cart you were riding in. */
  knocked(by: GolferEntity | null, kx: number, ky: number, cause: number): void {
    const { ctx } = this;
    if (this.down || this.now < this.graceUntil) return;
    if (this.cart) this.leaveCart(false);
    this.knockDown(kx, ky, cause === 2 ? 1300 : DOWN_MS);
    const who = by && by !== this.me ? by.render.name : null;
    const how = cause === 1 ? 'ran you over' : cause === 2 ? 'hit you with a ball' : cause === 3 ? 'rammed your cart' : 'clubbed you';
    ctx.hud.message(who ? `${who} ${how}!` : 'Knocked flat!');
  }

  private knockDown(kx: number, ky: number, ms: number): void {
    this.leaveAddress();
    this.downUntil = this.now + ms;
    this.graceUntil = this.downUntil + GRACE_MS;
    this.knock.x = kx;
    this.knock.y = ky;
    this.me!.state.down = true;
    this.me!.state.charge = 0;
    this.hands[0].hold(null);
    this.hands[1].hold(null);
    this.me!.state.tool = this.me!.state.ltool = NO_TOOL;
    this.body.knocked();
    this.ctx.sfx.play('oof', undefined, 1);
  }

  /** Knocked down: slide along the ground the way you were hit, then lie there. */
  private lieFlat(dt: number): void {
    const s = this.me!.state;
    const k = this.knock;
    const speed = Math.hypot(k.x, k.y);
    if (speed > 0.05) {
      const p = { x: s.x, y: s.y };
      this.move(p, k.x * dt, k.y * dt);
      this.collide(p, 0);
      this.shift(p.x - s.x, p.y - s.y);
      s.x = p.x;
      s.y = p.y;
      const slow = Math.max(0, speed - 9 * dt) / speed;
      k.x *= slow;
      k.y *= slow;
    }
    s.z = 0;
    s.charge = 0;
  }

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  /** The nearest cart nobody's driving, within reach. */
  nearestFreeCart(): CartEntity | null {
    const { world } = this.ctx;
    const s = this.me!.state;
    let best: CartEntity | null = null;
    let bestD = BOARD_REACH;
    for (const cart of world.query(s.x, s.y, BOARD_REACH + 1, Cart) as Iterable<CartEntity>) {
      const d = Math.hypot(cart.x - s.x, cart.y - s.y);
      if (d < bestD && !driverOf(this.ctx, cart)) {
        best = cart;
        bestD = d;
      }
    }
    return best;
  }

  /** Get into the nearest free cart: ask its owner for it, and sit down once it's ours (see `board`). */
  private tryBoard(): boolean {
    const { ctx } = this;
    if (this.boarding || this.now < this.boardAfter) return false;
    const cart = this.nearestFreeCart();
    if (!cart) return false;
    this.boarding = { cart, until: this.now + 1500 };
    void ctx.world.requestOwnership(cart);
    return true;
  }

  /** Waiting for a cart: sit in it once it's handed over, or give up. Checked every frame rather than when the request resolves, so the rules stay in step with frames. */
  private board(): boolean {
    const { ctx } = this;
    const pending = this.boarding!;
    const { cart } = pending;
    const free = cart.alive && !driverOf(ctx, cart);
    if (cart.alive && cart.mine && cart.held && free && !this.down) {
      this.boarding = null;
      this.sit(cart);
      return true;
    } else if (!free || this.down || this.now > pending.until) {
      this.boarding = null;
      if (cart.alive && cart.mine && cart.held && !this.cart) ctx.world.release(cart);
      if (!this.down) ctx.hud.message('Someone beat you to that cart');
    }
    return false;
  }

  private sit(cart: CartEntity): void {
    const s = this.me!.state;
    this.leaveAddress();
    this.cart = cart;
    cart.state.driver = this.me!.id;
    s.cart = cart.id;
    this.hands[0].hold(null);
    this.hands[1].hold(null);
    s.tool = s.ltool = NO_TOOL;
    this.placeInSeat();
    this.body.seated(true);
    this.ctx.sfx.play('door');
  }

  /** Get out, beside the driver's door. Hand the cart back to whoever should look after it. */
  leaveCart(standAside = true): void {
    const cart = this.cart;
    if (!cart) return;
    const { ctx } = this;
    const s = this.me!.state;
    this.cart = null;
    s.cart = 0;
    this.boardAfter = this.now + 600;
    if (cart.alive && cart.mine) {
      if (cart.state.driver === this.me!.id) cart.state.driver = 0;
      ctx.carts.drive(cart, PARKED);
      ctx.world.release(cart);
    }
    if (cart.alive) {
      const seat = seatOf(cart, tmp, true);
      const heading = cartHeading(cart, true);
      const out = standAside ? 1.2 : 0.5;
      const p = { x: seat.x + Math.sin(heading) * out, y: seat.y - Math.cos(heading) * out };
      this.collide(p, 0);
      this.heading = heading;
      this.pitch = 0;
      s.head = 1.65;
      this.teleport(p.x, p.y);
    }
    this.body.seated(false);
  }

  private drive(intent: GolfIntent): void {
    const { ctx } = this;
    const cart = this.cart!;
    const s = this.me!.state;
    if (!cart.alive || !cart.mine || cart.state.driver !== this.me!.id) {
      // lost it: the cart went, or someone else has it now
      this.cart = null;
      s.cart = 0;
      this.body.seated(false);
      return;
    }
    if (intent.interact) {
      this.leaveCart();
      return;
    }
    if (ctx.carts.sunk(cart)) {
      this.leaveCart();
      ctx.world.send(Feed, { text: `${s.name} drove a cart into the water` }, { to: 'all' });
      return;
    }
    ctx.carts.drive(cart, { throttle: clamp(intent.throttle, -1, 1), steer: clamp(intent.steer, -1, 1), brake: intent.brake });
    s.down = false;
    s.address = false;
    s.charge = 0;
    if (intent.head) {
      s.yaw = intent.head.heading;
      s.pitch = intent.head.pitch;
    }
  }

  /** Seated: the body goes wherever the seat is, facing where the cart does. */
  private placeInSeat(): void {
    const cart = this.cart!;
    const s = this.me!.state;
    if (!cart.alive) return;
    const seat = seatOf(cart, tmp, true);
    s.x = seat.x;
    s.y = seat.y;
    s.z = seat.z - this.groundAt(seat.x, seat.y) - 0.45;
    s.head = 1.2;
    this.heading = cartHeading(cart, true);
    s.yaw = this.heading;
  }

  // -------------------------------------------------------------------------
  // What others see a crosshair's club doing
  // -------------------------------------------------------------------------

  /**
   * Pose the club hand for others: carried at your side walking, down at the ball standing over it, back as the meter
   * fills, through after the shot, and across in front when swinging at someone.
   */
  private poseClub(): void {
    const s = this.me!.state;
    if (!this.inventory.current) return;
    const f = s.yaw;
    const cf = Math.cos(f);
    const sf = Math.sin(f);
    let hx: number;
    let hy: number;
    let hz: number;
    let aimYaw: number;
    let aimPitch: number;
    if (this.addressing || this.follow > 0) {
      // in the plane of the swing: along the aim line (a), toward the ball (f), and up
      const phi = this.follow > 0 ? -2.3 * (1 - this.follow / 0.55) : this.charge * 2.4;
      const ax = Math.cos(this.aimHeading);
      const ay = Math.sin(this.aimHeading);
      const along = -Math.sin(phi) * 0.55;
      const toward = 0.34 * Math.cos(phi / 2);
      const up = 1.02 - 0.42 * Math.cos(phi);
      hx = ax * along + cf * toward;
      hy = ay * along + sf * toward;
      hz = up;
      const dx = hx;
      const dy = hy;
      const dz = hz - 1.35;
      aimYaw = Math.atan2(dy, dx);
      aimPitch = Math.atan2(dz, Math.hypot(dx, dy));
    } else if (this.melee > 0) {
      const t = 1 - this.melee / 0.35;
      const yaw = f - 1.3 + t * 2.4;
      hx = Math.cos(yaw) * 0.45;
      hy = Math.sin(yaw) * 0.45;
      hz = 1.25;
      aimYaw = yaw;
      aimPitch = 0.1;
    } else {
      hx = cf * 0.12 - sf * 0.28;
      hy = sf * 0.12 + cf * 0.28;
      hz = 0.85;
      aimYaw = f;
      aimPitch = -1.05;
    }
    Object.assign(s, { hx, hy, hz, aimYaw, aimPitch });
  }
}

/** The golfer driving a cart, if they're really in it. */
export function driverOf(ctx: GolfContext, cart: CartEntity): GolferEntity | null {
  const id = cart.state.driver;
  if (!id) return null;
  const g = ctx.world.getAs(GolferDef, id);
  return g && g.state.cart === cart.id ? g : null;
}

function moving(ball: BallState): boolean {
  return ball.flight === Flight.Air || ball.flight === Flight.Rolling;
}

/** Shortest distance from a point to a segment. */
function segmentDistance(a: Vec3, b: Vec3, p: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2, 0, 1) : 0;
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y, a.z + dz * t - p.z);
}
