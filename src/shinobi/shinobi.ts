import { Avatar, CROUCH_EYE, EYE, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { HandClimb } from '../crossplay/climb';
import type { Side, TrackedHead } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import { NO_TOOL } from '../crossplay/tool';
import { START } from './castle';
import { angleDiff, clamp, type BladeEntity, type GuardEntity, type ShinobiContext, type ShinobiEntity, type Vec3 } from './context';
import { Beacon, Blade, Feed, Guard, GuardKind, GuardMode, Noise, Phase, Revive, Shinobi as ShinobiDef, ShinobiMode, Sound, Strike, Weapon } from './defs';
import { GUARDS } from './guards';
import type { ShinobiIntent } from './intent';
import { KUNAI, LOADOUT, SHURIKEN, STAB_REACH, TANTO, TOOLS, thrownTool, type NinjaTool, type Thrown, type Use } from './kit';

/** How the shinobi's rules reach back to the device playing it. */
export interface ShinobiBody extends AvatarBody {
  /** Took hold of a wall, or pulled up over the top of it. */
  climbed(over: boolean): void;
  /** A tracked hand took hold of something to climb. */
  gripped(side: Side): void;
  /** Landed from a fall, `hard` if it was a long one and loud with it. */
  landed(hard: boolean): void;
  /** A guard went down to a blow or blade of yours. */
  tookDown(kind: GuardKind): void;
  /** Picked up a blade. */
  picked(tool: NinjaTool): void;
  downed(): void;
  helpedUp(): void;
  escaped(): void;
  /** A new night: back in the forest. */
  restarted(): void;
}

export type ShinobiFrontend = AvatarFrontend<ShinobiIntent> & ShinobiBody;

const NO_BODY: ShinobiBody = {
  platform: Platform.Desktop,
  moved() {},
  placed() {},
  hurt() {},
  used() {},
  died() {},
  climbed() {},
  gripped() {},
  landed() {},
  tookDown() {},
  picked() {},
  downed() {},
  helpedUp() {},
  escaped() {},
  restarted() {},
};

export const MAX_HP = 3;
/** How fast a shinobi moves, m/s: walking, running, creeping. */
export const WALK = 3.6;
export const RUN = 6.4;
export const CREEP = 1.9;
/** Climbing up and down a wall, and along it, m/s. */
export const CLIMB_UP = 2.4;
const CLIMB_DOWN = 3;
const SHIMMY = 1.4;
const GRAVITY = 20;
const JUMP = 6.2;
/** A fall at least this far lands loudly, unless you land crouching and it's less than `ROLL`. */
const HARD_FALL = 2.2;
const ROLL = 5;
/** How long a downed shinobi has, s, and how long it takes to help one up. */
export const BLEED_SECONDS = 40;
export const REVIVE_SECONDS = 3;
export const HELP_REACH = 1.8;
/** How near a blade has to be to pick it up, m. */
export const PICKUP_REACH = 1.2;
/** A hand swinging a tanto this fast cuts, m/s. */
const SLASH_SPEED = 2.4;
/** A hand has to be going this fast to throw what's in it at all, m/s. */
const THROW_MIN = 3;
/** How much of a tracked throw's direction comes from where the blade points, rather than how the hand moved. */
const THROW_AIM = 0.3;
/** Running this fast makes footsteps guards can hear. */
const LOUD_PACE = 4.8;
const STEP_MS = 330;
const HURT_GRACE_MS = 600;
/** How far a guard's lantern and a brazier light the ground, m. */
export const HAND_LANTERN = 5;
export const BRAZIER_REACH = 11;

/** A climbable face a virtual head is on: its top, and which way it looks. */
interface Hold {
  top: number;
  nx: number;
  ny: number;
}

/**
 * The player as a shinobi: an avatar who can climb anything built, walk the roofs and the top of the wall, and fall off
 * them. Only sees an intent and reaches the device through `body`. Every frame it works out how visible it is (light,
 * stance, movement, bushes) for the guards to read, and runs make noise they can hear. The tanto kills quietly from
 * behind; kunai and shuriken fly and can be picked up again. Wounded by guards (`wound`), downed at no health and helped
 * up by others, and out over the wall once the lord's dead.
 */
export class ShinobiRole extends Avatar<ShinobiIntent, ShinobiBody, NinjaTool> implements Role<ShinobiIntent, ShinobiFrontend> {
  body: ShinobiBody = NO_BODY;
  /** Who you're helping up right now, for the HUD. */
  helping: ShinobiEntity | null = null;
  /** The climbable face ahead, for a hint: null when there's nothing to climb. */
  wallAhead = false;
  /** How visible you are, unrounded, and whether that's thanks to a bush. */
  exposure = 0.3;
  hidden = false;
  /** Absolute height of the feet. The replicated `z` is the same thing. */
  private feet = 0;
  private peak = 0;
  private hold: Hold | null = null;
  private wasHolding = false;
  private readonly hands2 = new HandClimb();
  private readonly pull: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly head2: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private readonly last = { x: 0, y: 0, speed: 0 };
  private nextStep = 0;
  private nextPickup = 0;
  private readonly asking = new Set<number>();
  private bleed = 0;
  private hurtUntil = 0;
  private helpedAt = -1e9;
  private helper = 0;
  private nextHelp = 0;
  private readonly swings = new WeakMap<Use, { v: Vec3[]; next: number }>();

  constructor(readonly ctx: ShinobiContext) {
    super(TOOLS);
  }

  get me(): ShinobiEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  get mode(): ShinobiMode {
    return this.me?.state.mode ?? ShinobiMode.Alive;
  }

  /** On a wall, by virtual head or tracked hands. */
  get climbing(): boolean {
    return !!this.hold || this.hands2.holding;
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    this.ctx.castle.move(p, dx, dy, RADIUS, this.feet);
  }

  protected override collide(p: { x: number; y: number }): void {
    this.ctx.castle.pushOut(p, RADIUS, this.feet);
  }

  /** Into the forest south of the gate, with a full kit. */
  spawn(): void {
    const { ctx } = this;
    const at = startSpot(ctx);
    ctx.me = ctx.world.spawn(ShinobiDef, { x: at.x, y: at.y, name: ctx.playerName, skin: Math.floor(Math.random() * 30), mode: ShinobiMode.Alive, hp: MAX_HP });
    this.heading = Math.PI / 2;
    this.restock();
    ctx.world.setFocus(at.x, at.y);
  }

  private restock(): void {
    this.inventory.clear();
    this.inventory.add(KUNAI, LOADOUT.kunai);
    this.inventory.add(SHURIKEN, LOADOUT.shuriken);
    this.inventory.select(TANTO);
  }

  update(dt: number, intent: ShinobiIntent): void {
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    this.nightly();

    switch (s.mode) {
      case ShinobiMode.Dead:
        this.putAway();
        this.letGo();
        if (intent.head) this.moveTracked(dt, intent, false);
        break;
      case ShinobiMode.Escaped:
        this.putAway();
        this.letGo();
        this.moveBody(dt, intent, true);
        break;
      case ShinobiMode.Downed:
        this.letGo();
        intent.run = intent.jump = intent.climb = false;
        intent.strafe *= 0.25;
        intent.forward *= 0.25;
        if (!intent.head) intent.crouch = true;
        this.moveBody(dt, intent, false);
        if (!intent.head) s.head = 0.5;
        this.bleedOut(dt);
        this.putAway();
        break;
      default:
        this.moveBody(dt, intent, true);
        this.useTools(dt, intent);
        this.pickUp();
        this.help(intent);
        this.escape();
    }
    s.climbing = this.climbing;
    this.see(dt);
    this.ctx.world.setFocus(s.x, s.y);
  }

  // -------------------------------------------------------------------------
  // Moving: walking, climbing, falling
  // -------------------------------------------------------------------------

  private moveBody(dt: number, intent: ShinobiIntent, canClimb: boolean): void {
    if (intent.head) this.moveTracked(dt, intent, canClimb);
    else this.moveVirtual(dt, intent, canClimb);
  }

  /** A virtual head: walk, run and creep, jump, climb what's in front while `climb` is held, and fall off edges. */
  private moveVirtual(dt: number, intent: ShinobiIntent, canClimb: boolean): void {
    const { castle } = this.ctx;
    const s = this.me!.state;
    const support = castle.support(s.x, s.y, this.feet);
    const grounded = this.feet <= support + 0.02 && this.vz <= 0;
    const face = canClimb ? castle.faceAhead(s.x, s.y, this.heading, this.feet) : null;
    this.wallAhead = !!face && !this.hold;

    if (this.hold) {
      this.climbVirtual(dt, intent);
    } else if (face && intent.climb && intent.forward >= 0) {
      this.hold = { top: face.top, nx: face.nx, ny: face.ny };
      this.vz = 0;
      this.body.climbed(false);
    } else {
      const speed = intent.crouch ? CREEP : intent.run ? RUN : WALK;
      this.step(s, intent.strafe, intent.forward, this.heading, speed, dt);
      if (intent.jump && grounded && !intent.crouch) this.vz = JUMP;
      this.fall(dt, intent.crouch);
    }
    s.x = clamp(s.x, 1.5, 94.5);
    s.y = clamp(s.y, 1.5, 94.5);
    s.z = this.feet;
    s.yaw = this.heading;
    s.pitch = this.pitch;
    const eye = intent.crouch || this.hold ? CROUCH_EYE + 0.25 : EYE;
    s.head = clamp(s.head + (eye - s.head) * Math.min(1, dt * 12), CROUCH_EYE, EYE);
  }

  /** On a wall: up or down it, along it, off it, or over the top. */
  private climbVirtual(dt: number, intent: ShinobiIntent): void {
    const { castle } = this.ctx;
    const s = this.me!.state;
    const hold = this.hold!;
    if (intent.crouch || intent.jump) {
      // let go, kicking off a little
      this.hold = null;
      this.move(s, hold.nx * 0.2, hold.ny * 0.2);
      return;
    }
    const up = intent.climb || intent.forward > 0.3 ? CLIMB_UP : intent.forward < -0.3 ? -CLIMB_DOWN : 0;
    this.feet += up * dt;
    // along the wall, while there's wall to hold
    if (Math.abs(intent.strafe) > 0.3) {
      const along = Math.atan2(hold.ny, hold.nx) - Math.PI / 2;
      const facing = angleDiff(this.heading, Math.atan2(-hold.ny, -hold.nx));
      const sign = Math.abs(facing) < Math.PI / 2 ? 1 : -1;
      const p = { x: s.x, y: s.y };
      this.move(p, Math.cos(along) * intent.strafe * sign * SHIMMY * dt, Math.sin(along) * intent.strafe * sign * SHIMMY * dt);
      const still = castle.faceAhead(p.x, p.y, Math.atan2(-hold.ny, -hold.nx), this.feet, 0.7);
      if (still) {
        s.x = p.x;
        s.y = p.y;
        hold.top = still.top;
      }
    }
    const ground = castle.support(s.x, s.y, this.feet);
    if (this.feet <= ground) {
      this.feet = ground;
      this.hold = null;
      return;
    }
    if (this.feet >= hold.top - 0.35) {
      // over the top
      this.feet = hold.top;
      this.hold = null;
      this.peak = this.feet;
      const p = { x: s.x, y: s.y };
      this.move(p, -hold.nx * 0.8, -hold.ny * 0.8);
      s.x = p.x;
      s.y = p.y;
      this.body.climbed(true);
    }
  }

  /** Gravity, and landing: quietly if it's short or you land crouching, loudly if not. */
  private fall(dt: number, crouch: boolean): void {
    const { castle } = this.ctx;
    const s = this.me!.state;
    const support = castle.support(s.x, s.y, this.feet);
    if (this.feet > support + 0.01 || this.vz > 0) {
      this.vz -= GRAVITY * dt;
      this.feet += this.vz * dt;
      this.peak = Math.max(this.peak, this.feet);
      if (this.feet <= support) {
        const drop = this.peak - support;
        this.feet = support;
        this.vz = 0;
        this.landed(drop, crouch);
      }
    } else {
      this.feet = support;
      this.vz = 0;
      this.peak = this.feet;
    }
  }

  private landed(drop: number, crouch: boolean): void {
    this.peak = this.feet;
    if (drop < HARD_FALL) return;
    const hard = !crouch || drop >= ROLL;
    const s = this.me!.state;
    if (hard) this.ctx.world.send(Noise, { kind: Sound.Land, x: s.x, y: s.y, z: this.feet, a: 0 }, { to: 'all' });
    this.body.landed(hard);
  }

  /**
   * A tracked head: follow it round the room, walk with the stick, and climb by gripping what's climbable and pulling.
   * Holding on stops the fall; letting go of everything starts it.
   */
  private moveTracked(dt: number, intent: ShinobiIntent, canClimb: boolean): void {
    const { castle } = this.ctx;
    const s = this.me!.state;
    const head = this.head2;
    Object.assign(head, intent.head!);
    const pull = this.pull;
    const holding =
      canClimb &&
      this.hands2.update(intent.hands, (p) => castle.holdable(p), pull, (side) => {
        this.vz = 0;
        this.body.gripped(side);
      });
    this.wallAhead = false;
    if (holding) {
      // the body moves round the hands: the play space with it, so the head's where it was in the room
      head.x += pull.x;
      head.y += pull.y;
      this.shift(pull.x, pull.y);
    }
    const before = { x: s.x, y: s.y };
    this.walkTracked(dt, head, intent, !holding);
    if (holding) {
      const wantZ = this.feet + pull.z;
      const ground = castle.support(s.x, s.y, this.feet);
      this.feet = Math.max(ground, wantZ);
      // what the wall and the ground didn't let the pull do
      this.hands2.slip(s.x - before.x - pull.x, s.y - before.y - pull.y, this.feet - wantZ);
      this.vz = 0;
      this.peak = this.feet;
      if (!this.wasHolding) this.body.climbed(false);
    } else {
      if (this.wasHolding && castle.support(s.x, s.y, this.feet) >= this.feet - 0.05) this.body.climbed(true);
      this.fall(dt, head.z - this.feet < 1.2);
    }
    this.wasHolding = holding;
    s.z = this.feet;
    s.head = clamp(head.z + (holding ? pull.z : 0) - this.feet, 0.4, 2.3);
  }

  private letGo(): void {
    this.hold = null;
    this.hands2.release();
    this.wasHolding = false;
  }

  /** Put down somewhere else, on the ground. */
  protected override teleport(x: number, y: number): void {
    super.teleport(x, y);
    this.feet = this.peak = this.vz = 0;
    this.letGo();
  }

  // -------------------------------------------------------------------------
  // Being seen, and heard
  // -------------------------------------------------------------------------

  /**
   * How visible you are, for guards to read off the replicated body: the light you stand in (the moon, stone lanterns,
   * guards' lanterns and braziers), times how you're moving (creeping, running, still, clinging to a wall), and much less
   * crouched in a bush. And running feet make noise.
   */
  private see(dt: number): void {
    const { world, castle, now } = this.ctx;
    const s = this.me!.state;
    const moved = Math.hypot(s.x - this.last.x, s.y - this.last.y) / Math.max(dt, 1e-3);
    this.last.x = s.x;
    this.last.y = s.y;
    this.last.speed += (Math.min(moved, 12) - this.last.speed) * Math.min(1, dt * 8);
    const speed = this.last.speed;

    let light = castle.staticLight(s.x, s.y);
    for (const b of world.query(s.x, s.y, BRAZIER_REACH, Beacon)) light = Math.max(light, 1 - (Math.hypot(b.x - s.x, b.y - s.y) / BRAZIER_REACH) * 0.5);
    for (const g of world.query(s.x, s.y, HAND_LANTERN, Guard) as GuardEntity[]) {
      if (g.render.lantern) light = Math.max(light, 1 - (Math.hypot(g.x - s.x, g.y - s.y) / HAND_LANTERN) * 0.6);
    }
    const low = s.head < 1.25;
    let k = low ? 0.5 : 1;
    k *= speed > LOUD_PACE ? 1.35 : speed < 0.3 ? 0.8 : 1;
    if (this.climbing) k *= 0.85;
    this.hidden = low && this.feet < 0.3 && castle.bushAt(s.x, s.y);
    if (this.hidden) k *= 0.1;
    else if (castle.bushAt(s.x, s.y) && this.feet < 0.3) k *= 0.6;
    this.exposure = s.mode === ShinobiMode.Downed ? 1 : clamp(light * k, 0.03, 1);
    s.exposure = this.exposure;

    const quiet = s.mode !== ShinobiMode.Alive || this.climbing || this.feet > this.peak + 0.05;
    if (!quiet && speed > LOUD_PACE && now >= this.nextStep && !low) {
      this.nextStep = now + STEP_MS;
      world.send(Noise, { kind: Sound.Steps, x: s.x, y: s.y, z: this.feet, a: 0 }, { to: 'all' });
    }
  }

  // -------------------------------------------------------------------------
  // Tools: the tanto, kunai and shuriken
  // -------------------------------------------------------------------------

  private useTools(dt: number, intent: ShinobiIntent): void {
    if (intent.hands) this.useHands(intent.hands, dt);
    else if (this.climbing) this.useCrosshair({ ...intent, trigger: false }, dt);
    else this.useCrosshair(intent, dt);
  }

  /** Nothing in hand: out of the night. */
  private putAway(): void {
    const s = this.me!.state;
    this.hands[0].hold(null);
    this.hands[1].hold(null);
    s.tool = s.ltool = NO_TOOL;
  }

  /** The tanto on a crosshair: strike whoever's right in front. */
  stab(use: Use): void {
    const target = this.inReach(use.origin, use.aim);
    if (!target) {
      use.effect({ kick: 0.4, hit: 'miss' });
      this.ctx.sfx.play('swish', use.origin, 0.5);
      return;
    }
    this.strike(target, Weapon.Tanto, 2);
    use.effect({ kick: 0.8, hit: 'body' });
  }

  /** The tanto in a tracked hand: swung fast through someone, it cuts. */
  slash(use: Use): void {
    const v = use.velocity;
    if (Math.hypot(v.x, v.y, v.z) < SLASH_SPEED) return;
    const swing = this.swingOf(use);
    if (this.now < swing.next) return;
    const tip = use.origin;
    for (const g of this.ctx.world.query(tip.x, tip.y, 1.5, Guard) as GuardEntity[]) {
      const gs = g.render;
      if (gs.mode === GuardMode.Dead) continue;
      const spec = GUARDS[gs.kind];
      if (Math.hypot(g.x - tip.x, g.y - tip.y) > spec.radius + 0.18 || tip.z < gs.z || tip.z > gs.z + spec.height + 0.1) continue;
      swing.next = this.now + TANTO.cooldownMs;
      this.strike(g, Weapon.Tanto, 2);
      use.effect({ kick: 0.9, hit: 'body' });
      return;
    }
  }

  /** The guard nearest the middle of the view within a tanto's reach. */
  private inReach(o: Vec3, a: Vec3): GuardEntity | null {
    const { world, castle } = this.ctx;
    let best: GuardEntity | null = null;
    let bestScore = Infinity;
    for (const g of world.query(o.x, o.y, STAB_REACH + 0.6, Guard) as GuardEntity[]) {
      const gs = g.render;
      if (gs.mode === GuardMode.Dead) continue;
      const spec = GUARDS[gs.kind];
      const cz = clamp(o.z, gs.z + 0.4, gs.z + spec.height - 0.1);
      const dx = g.x - o.x;
      const dy = g.y - o.y;
      const dz = cz - o.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > STAB_REACH + spec.radius) continue;
      const cos = d > 1e-3 ? (dx * a.x + dy * a.y + dz * a.z) / d : 1;
      if (cos < 0.75 && d > spec.radius + 0.4) continue;
      if (!castle.sees(o.x, o.y, o.z, g.x, g.y, cz)) continue;
      const score = d * (2 - cos);
      if (score < bestScore) {
        bestScore = score;
        best = g;
      }
    }
    return best;
  }

  private strike(g: GuardEntity, weapon: Weapon, amount: number): void {
    const s = this.me!.state;
    this.ctx.world.command(Strike, { target: g.id, by: this.me!.id, weapon, amount, x: s.x, y: s.y });
    this.ctx.world.send(Noise, { kind: Sound.Stab, x: g.x, y: g.y, z: g.render.z + 1.2, a: weapon }, { to: 'all' });
  }

  /** A kunai or shuriken from a crosshair: thrown straight out along the view. */
  hurl(use: Use, tool: Thrown): void {
    if (this.inventory.charges(tool) <= 0) return;
    const a = use.aim;
    const from = { x: use.origin.x + a.x * 0.35, y: use.origin.y + a.y * 0.35, z: use.origin.z + a.z * 0.35 - 0.08 };
    const speed = tool.flight.speed;
    this.ctx.flights.launch(tool.weapon, this.me!.id, from, { x: a.x * speed, y: a.y * speed, z: a.z * speed + 0.6 });
    use.effect({ kick: 0.3 });
    this.spend(tool);
  }

  /** Holding the trigger on a blade in a tracked hand: remember how the hand's moving, to throw it that way. */
  windUp(use: Use): void {
    const swing = this.swingOf(use);
    swing.v.push({ ...use.velocity });
    if (swing.v.length > 6) swing.v.shift();
  }

  /** Let go of the trigger: the blade flies from the hand as fast as the hand was going, if it was going at all. */
  letFly(use: Use, tool: Thrown): void {
    const swing = this.swingOf(use);
    const samples = swing.v;
    swing.v = [];
    let v: Vec3 | null = null;
    for (const sample of samples) if (!v || Math.hypot(sample.x, sample.y, sample.z) > Math.hypot(v.x, v.y, v.z)) v = sample;
    const hand = v ? Math.hypot(v.x, v.y, v.z) : 0;
    if (!v || hand < THROW_MIN || this.inventory.charges(tool) <= 0) return;
    const speed = Math.min(tool.flight.maxSpeed, hand * 3.2);
    const a = use.aim;
    const dx = (v.x / hand) * (1 - THROW_AIM) + a.x * THROW_AIM;
    const dy = (v.y / hand) * (1 - THROW_AIM) + a.y * THROW_AIM;
    const dz = (v.z / hand) * (1 - THROW_AIM) + a.z * THROW_AIM;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.ctx.flights.launch(tool.weapon, this.me!.id, use.origin, { x: (dx / len) * speed, y: (dy / len) * speed, z: (dz / len) * speed });
    use.effect({ kick: 0.25 });
    this.spend(tool);
  }

  private swingOf(use: Use): { v: Vec3[]; next: number } {
    let swing = this.swings.get(use);
    if (!swing) this.swings.set(use, (swing = { v: [], next: 0 }));
    return swing;
  }

  /** Walk over a kunai or shuriken lying about to take it back: its owner hands it over, and it's yours. */
  private pickUp(): void {
    const { world, now } = this.ctx;
    if (now < this.nextPickup) return;
    this.nextPickup = now + 200;
    const s = this.me!.state;
    const round = this.ctx.round()?.state.round ?? 0;
    for (const blade of world.query(s.x, s.y, PICKUP_REACH, Blade) as BladeEntity[]) {
      const b = blade.render;
      const tool = thrownTool(b.kind);
      if (!tool || b.round !== round || Math.abs(b.z - this.feet - 0.5) > 1.4 || this.asking.has(blade.id) || !this.inventory.wants(tool)) continue;
      this.asking.add(blade.id);
      void world
        .withLock(blade, (e) => {
          world.despawn(e);
          return true;
        })
        .then((got) => {
          this.asking.delete(blade.id);
          if (!got || !this.me) return;
          this.inventory.add(tool, 1);
          world.send(Noise, { kind: Sound.Pickup, x: s.x, y: s.y, z: this.feet, a: b.kind }, { to: 'near', x: s.x, y: s.y, radius: 20 });
          this.body.picked(tool);
        });
    }
  }

  /** A guard went down to one of yours. */
  tally(kind: GuardKind): void {
    const s = this.me?.state;
    if (!s) return;
    s.kills = Math.min(255, s.kills + 1);
    this.body.tookDown(kind);
  }

  // -------------------------------------------------------------------------
  // The night, wounds, and helping each other up
  // -------------------------------------------------------------------------

  /** Over the wall and away, once the lord's dead. */
  private escape(): void {
    const round = this.ctx.round()?.state;
    const s = this.me!.state;
    if (round?.phase !== Phase.Escape || !this.ctx.castle.outside(s.x, s.y)) return;
    s.mode = ShinobiMode.Escaped;
    this.letGo();
    this.ctx.world.send(Feed, { text: `${s.name} got away over the wall` }, { to: 'all' });
    this.body.escaped();
  }

  /** A new night started without you: back to the forest, whole, with a full kit. */
  private nightly(): void {
    const round = this.ctx.round()?.state;
    const s = this.me!.state;
    if (!round || s.round === round.round || round.phase === Phase.Over) return;
    const first = s.round === 0;
    s.round = round.round;
    s.mode = ShinobiMode.Alive;
    s.hp = MAX_HP;
    s.revive = s.bleed = s.kills = 0;
    this.restock();
    if (first && this.ctx.castle.outside(s.x, s.y)) return;
    const at = startSpot(this.ctx);
    this.heading = Math.PI / 2;
    this.pitch = 0;
    s.head = EYE;
    this.teleport(at.x, at.y);
    this.body.restarted();
  }

  /** Hold `interact` over a downed shinobi to help them up. */
  private help(intent: ShinobiIntent): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    this.helping = null;
    if (!intent.interact) return;
    let best: ShinobiEntity | null = null;
    let bestD = HELP_REACH;
    for (const sv of world.query(s.x, s.y, HELP_REACH, ShinobiDef) as ShinobiEntity[]) {
      if (sv === this.me || sv.render.mode !== ShinobiMode.Downed || Math.abs(sv.render.z - this.feet) > 1) continue;
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

  helpedBy(by: number): void {
    if (this.mode !== ShinobiMode.Downed) return;
    this.helpedAt = this.now;
    this.helper = by;
  }

  private bleedOut(dt: number): void {
    const s = this.me!.state;
    if (this.now - this.helpedAt < 450) {
      s.revive = Math.min(1, s.revive + dt / REVIVE_SECONDS);
      if (s.revive >= 1) this.getUp();
      return;
    }
    s.revive = Math.max(0, s.revive - dt * 0.5);
    this.bleed -= dt;
    s.bleed = Math.max(0, Math.ceil(this.bleed));
    if (this.bleed <= 0) this.die();
  }

  /** A guard's spear or arrow found you. */
  wound(amount: number, kx: number, ky: number): void {
    const s = this.me!.state;
    if (s.mode !== ShinobiMode.Alive || this.now < this.hurtUntil) return;
    this.hurtUntil = this.now + HURT_GRACE_MS;
    s.hp = Math.max(0, s.hp - amount);
    if (!this.climbing) this.nudge(kx * 0.15, ky * 0.15);
    this.body.hurt(amount);
    if (s.hp <= 0) this.goDown();
  }

  private goDown(): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    this.letGo();
    s.mode = ShinobiMode.Downed;
    s.revive = 0;
    this.bleed = BLEED_SECONDS;
    s.bleed = BLEED_SECONDS;
    world.send(Noise, { kind: Sound.Cry, x: s.x, y: s.y, z: this.feet + 0.6, a: 0 }, { to: 'all' });
    world.send(Feed, { text: `${s.name} is down!` }, { to: 'all' });
    this.body.downed();
  }

  private getUp(): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    s.mode = ShinobiMode.Alive;
    s.hp = 2;
    s.revive = s.bleed = 0;
    s.head = EYE;
    this.hurtUntil = this.now + 2000;
    const helper = world.getAs(ShinobiDef, this.helper);
    world.send(Feed, { text: helper ? `${helper.render.name} helped ${s.name} up` : `${s.name} got up` }, { to: 'all' });
    this.body.helpedUp();
  }

  private die(): void {
    const { world } = this.ctx;
    const s = this.me!.state;
    s.mode = ShinobiMode.Dead;
    s.revive = s.bleed = 0;
    this.putAway();
    world.send(Feed, { text: `The watch has taken ${s.name}` }, { to: 'all' });
    this.body.died();
  }
}

/** Somewhere in the clearing south of the gate. */
function startSpot(ctx: ShinobiContext): { x: number; y: number } {
  return ctx.castle.nearestOpen(START.x + (Math.random() - 0.5) * 10, START.y + (Math.random() - 0.5) * 4);
}
