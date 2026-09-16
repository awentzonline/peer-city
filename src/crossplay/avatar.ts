import { t, type Infer, type NetEntity } from '@engine/index';
import { HeldTool } from './heldTool';
import { Side, type AvatarIntent, type HandIntent, type TrackedHead } from './intent';
import { Inventory } from './inventory';
import { clamp, direction, type Vec3 } from './math';
import type { Platform } from './platform';
import type { Frontend } from './role';
import { NO_TOOL, type DropReason, type Tool, type ToolUse, type Toolbox, type UseEffect } from './tool';

export const WALK = 4.2;
export const RUN = 7.2;
/** The body's collision radius. */
export const RADIUS = 0.35;
/** Eye height above the feet, standing. */
export const EYE = 1.65;
/** Crouching on a virtual head: eye height, and how fast you creep. */
export const CROUCH_EYE = 1;
export const CROUCH_WALK = 1.8;
const GRAVITY = 20;
const JUMP_SPEED = 6;
/** Tracked-head stick locomotion: one fast top speed, ~95% reached in half a second, and stopping is quicker. */
const TRACKED_SPEED = 7;
const TRACKED_ACCEL = 6;
const TRACKED_BRAKE = 12;

/**
 * The replicated body every avatar has. Spread it into a game's player entity, before that game's own fields:
 * `defineEntity({ name: 'player', fields: { ...BODY_FIELDS, hp: t.uint(8, 100) } })`. Meters, world axes.
 */
export const BODY_FIELDS = {
  x: t.fixed(0.02),
  y: t.fixed(0.02),
  z: t.fixed(0.02), // feet above the ground (jumping)
  yaw: t.angle(10), // where the head faces
  pitch: t.angle(10),
  head: t.fixed(0.02, EYE), // head height above the feet (headset players crouch for real)
  hx: t.fixed(0.02), // right hand (the crosshair tool's hand) relative to the feet, world axes
  hy: t.fixed(0.02),
  hz: t.fixed(0.02, 1.35),
  aimYaw: t.angle(10), // where the right hand points
  aimPitch: t.angle(10),
  lhx: t.fixed(0.02), // left hand, only tracked on a headset
  lhy: t.fixed(0.02),
  lhz: t.fixed(0.02, 1.35),
  laimYaw: t.angle(10),
  laimPitch: t.angle(10),
  platform: t.uint(8), // what it's played on (see platform.ts); headset players' empty hands are tracked too
  tool: t.uint(8, NO_TOOL), // tool in the right hand, by id in the game's Toolbox
  ltool: t.uint(8, NO_TOOL), // tool in the left hand
};

export type BodyState = Infer<typeof BODY_FIELDS>;

/**
 * How an avatar's rules reach back to the device playing it. The rules call these and each platform decides
 * what they mean there: a headset moves its play space when the avatar is pushed, a desktop has nothing to
 * move. A game's avatar can ask for more (Peer City's `seated`).
 */
export interface AvatarBody {
  readonly platform: Platform;
  /** The rules moved the avatar: a wall held the head back, the stick walked it, or a hit knocked it. */
  moved(dx: number, dy: number): void;
  /** The avatar was put down at (x, y): released, respawned, teleported. */
  placed(x: number, y: number): void;
  hurt(amount: number): void;
  /** The tool in a hand, or the crosshair tool (`side` null), was used: recoil, haptics, hit markers. */
  used(side: Side | null, tool: Tool<any>, effect: UseEffect): void;
  died(): void;
}

/** A platform's frontend for an avatar role. */
export interface AvatarFrontend<I extends AvatarIntent = AvatarIntent> extends Frontend<I>, AvatarBody {
  /** Whether to draw your own avatar, e.g. from a chase camera. */
  readonly showSelf: boolean;
}

export type AnyAvatar = Avatar<any, any, any>;

/**
 * What every avatar role shares, whatever the game: a body that walks with a virtual head or follows a
 * tracked one round the room, and hands that use tools, from a crosshair or wherever tracked hands point.
 * A game subclasses it with its own rules (Peer City's `AvatarSim` drives cars; Peer Wilds' `Survivor` gets
 * hungry) and says what the world is like: how the body collides (`move`, `collide`) and where the ground is.
 *
 * With a tracked head the avatar stands wherever the head is. Walking round your room walks it; when that
 * would put the head in a wall the avatar stays out and `body.moved` pushes the play space back, so you
 * can't physically walk through things.
 */
export abstract class Avatar<I extends AvatarIntent = AvatarIntent, B extends AvatarBody = AvatarBody, T extends Tool<any> = Tool<any>> {
  abstract body: B;
  /** Where a virtual head faces. */
  heading = 0;
  pitch = 0;
  readonly inventory: Inventory<T>;
  /** What each hand, by `Side`, is holding. The crosshair tool is the right hand's. */
  protected readonly hands: [HeldTool<any>, HeldTool<any>];
  protected vz = 0;
  private headTracked = false;
  /**
   * How far the rules have moved the avatar this frame. Hand poses were read before that, so they're
   * carried along by it. After `placed`, which isn't a plain shift, they're stale until the next frame.
   */
  private readonly carried = { x: 0, y: 0 };
  private posesStale = false;
  private readonly aim: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly grip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly moveVel = { x: 0, y: 0 };

  constructor(tools: Toolbox<T>) {
    this.inventory = new Inventory(tools);
    this.hands = [new HeldTool(this), new HeldTool(this)];
  }

  /** The replicated body this avatar plays, once spawned. */
  abstract get me(): NetEntity<BodyState> | null;
  /** The current frame's time, ms. */
  abstract get now(): number;
  abstract update(dt: number, intent: I): void;
  /** Move a body-sized circle by (dx, dy), sliding along whatever blocks it. */
  protected abstract move(p: { x: number; y: number }, dx: number, dy: number): void;

  /** Ground height at a point. Flat by default. */
  protected groundAt(_x: number, _y: number): number {
    return 0;
  }

  /** After moving to `p` with the feet `z` above the ground: push out of anything `move` doesn't know about. */
  protected collide(_p: { x: number; y: number }, _z: number): void {}

  /** The crosshair switched tools. */
  protected switchedTool(): void {}

  attach(body: B): void {
    this.body = body;
  }

  /** A hand, as its tool's hooks see it. */
  hand(side: Side): ToolUse<any> {
    return this.hands[side];
  }

  /** Height of the feet: the ground, plus any jump. */
  feetZ(): number {
    const s = this.me!.state;
    return this.groundAt(s.x, s.y) + s.z;
  }

  /** Start a frame of the rules: the platform, a clean slate for moves, and a turned virtual head. */
  protected begin(intent: I): void {
    this.me!.state.platform = this.body.platform;
    this.carried.x = this.carried.y = 0;
    this.posesStale = false;
    this.look(intent);
  }

  /** Turn a virtual head. Taking a headset off leaves it facing where the headset faced. */
  private look(intent: I): void {
    if (intent.head) {
      this.headTracked = true;
      return;
    }
    if (this.headTracked) {
      this.headTracked = false;
      this.heading = this.me!.state.yaw;
      this.pitch = 0;
    }
    this.heading += intent.turn;
    this.pitch = clamp(this.pitch + intent.lookUp, -1.45, 1.45);
  }

  /** Move a point relative to a heading, sliding along walls. */
  private step(p: { x: number; y: number }, strafe: number, forward: number, heading: number, speed: number, dt: number): void {
    const len = Math.hypot(strafe, forward);
    if (len === 0) return;
    const k = (Math.min(1, len) * speed * dt) / len;
    const c = Math.cos(heading);
    const sn = Math.sin(heading);
    this.move(p, (c * forward - sn * strafe) * k, (sn * forward + c * strafe) * k);
  }

  /** A virtual head: walk or run at once, crouch, and jump. */
  protected walk(dt: number, intent: I): void {
    const s = this.me!.state;
    this.step(s, intent.strafe, intent.forward, this.heading, intent.crouch ? CROUCH_WALK : intent.run ? RUN : WALK, dt);
    if (intent.jump && s.z <= 0 && !intent.crouch) this.vz = JUMP_SPEED;
    if (s.z > 0 || this.vz > 0) {
      s.z += this.vz * dt;
      this.vz -= GRAVITY * dt;
      if (s.z <= 0) s.z = this.vz = 0;
    }
    this.collide(s, s.z);
    s.yaw = this.heading;
    s.pitch = this.pitch;
    const eye = intent.crouch ? CROUCH_EYE : EYE;
    s.head = clamp(s.head + (eye - s.head) * Math.min(1, dt * 12), CROUCH_EYE, EYE);
  }

  /** A tracked head: follow it round the room, and ease the stick up to speed (sudden starts are nauseating). */
  protected walkTracked(dt: number, head: TrackedHead, intent: I, allowLocomotion: boolean): void {
    const s = this.me!.state;

    // Room-scale: follow the head, but never into walls.
    const dx = head.x - s.x;
    const dy = head.y - s.y;
    if (dx * dx + dy * dy > 9) {
      this.shift(s.x - head.x, s.y - head.y); // first frame, or tracking jumped
    } else {
      const p = { x: s.x, y: s.y };
      this.move(p, dx, dy);
      this.collide(p, 0);
      this.shift(p.x - head.x, p.y - head.y);
      s.x = p.x;
      s.y = p.y;
    }

    const vel = this.moveVel;
    if (allowLocomotion) {
      const { strafe, forward } = intent;
      const mag = Math.hypot(strafe, forward);
      const k = mag > 1 ? TRACKED_SPEED / mag : TRACKED_SPEED;
      const c = Math.cos(head.heading);
      const sn = Math.sin(head.heading);
      const blend = 1 - Math.exp(-dt * (mag ? TRACKED_ACCEL : TRACKED_BRAKE));
      vel.x += ((c * forward - sn * strafe) * k - vel.x) * blend;
      vel.y += ((sn * forward + c * strafe) * k - vel.y) * blend;
      if (dt > 0 && Math.abs(vel.x) + Math.abs(vel.y) > 0.01) {
        const p = { x: s.x, y: s.y };
        this.move(p, vel.x * dt, vel.y * dt);
        // sliding along a wall keeps only the speed along it
        vel.x = (p.x - s.x) / dt;
        vel.y = (p.y - s.y) / dt;
        this.collide(p, 0);
        this.shift(p.x - s.x, p.y - s.y);
        s.x = p.x;
        s.y = p.y;
      }
    } else {
      vel.x = vel.y = 0;
    }

    s.z = 0;
    s.yaw = head.heading;
    s.pitch = head.pitch;
    s.head = clamp(head.z - this.groundAt(s.x, s.y), 0.4, 2.3);
  }

  /** The rules moved the avatar; the device follows. */
  protected shift(dx: number, dy: number): void {
    this.carried.x += dx;
    this.carried.y += dy;
    this.body.moved(dx, dy);
  }

  protected place(x: number, y: number): void {
    this.posesStale = true;
    this.body.placed(x, y);
  }

  /** Put the avatar down somewhere else. */
  protected teleport(x: number, y: number): void {
    const s = this.me!.state;
    s.x = x;
    s.y = y;
    s.z = 0;
    this.place(x, y);
  }

  /** Where the eyes are: standing, crouching, or wherever a tracked head holds them. */
  eyePosition(out: Vec3): Vec3 {
    const s = this.me!.state;
    out.x = s.x;
    out.y = s.y;
    out.z = this.feetZ() + s.head;
    return out;
  }

  /** Knockback from a hit. */
  nudge(dx: number, dy: number): void {
    const s = this.me!.state;
    const p = { x: s.x, y: s.y };
    this.move(p, dx, dy);
    this.shift(p.x - s.x, p.y - s.y);
    s.x = p.x;
    s.y = p.y;
  }

  /** The selected tool, used from the eyes through the middle of the view, with its hand held out in front. */
  protected useCrosshair(intent: I, dt: number): void {
    const { inventory: inv } = this;
    const s = this.me!.state;
    const before = inv.current;
    if (intent.cycleTool) inv.cycle(intent.cycleTool > 0 ? 1 : -1);
    if (intent.selectTool) inv.select(intent.selectTool as T);
    if (inv.current !== before) this.switchedTool();

    const heading = intent.head?.heading ?? this.heading;
    if (intent.aim) copy(this.aim, intent.aim);
    else direction(heading, intent.head?.pitch ?? this.pitch, this.aim);
    const c = Math.cos(heading);
    const sn = Math.sin(heading);
    this.grip.x = s.x + c * 0.45 - sn * 0.22;
    this.grip.y = s.y + sn * 0.45 + c * 0.22;
    this.grip.z = this.feetZ() + s.head - 0.3;
    this.setHandFields(this.grip, this.aim, Side.Right);

    this.hands[Side.Left].hold(null);
    const hand = this.hands[Side.Right];
    hand.side = null;
    hand.hold(inv.current);
    this.eyePosition(hand.origin);
    copy(hand.aim, this.aim);
    copy(hand.tip, intent.tip ?? hand.origin);
    hand.update(intent.trigger, dt);
    s.tool = inv.current?.id ?? NO_TOOL;
    s.ltool = NO_TOOL;
  }

  /** Each tracked hand uses whatever tool it holds, wherever it points. Both replicate, holding one or not. */
  protected useHands(hands: [HandIntent, HandIntent], dt: number): void {
    const s = this.me!.state;
    for (const side of [Side.Left, Side.Right]) {
      const intent = hands[side];
      const hand = this.hands[side];
      hand.side = side;
      hand.hold(intent.tool);
      if (!intent.tracked || this.posesStale) {
        hand.lose();
        continue;
      }
      this.setHandFields(this.carry(intent.grip, this.grip), intent.pointing, side);
      this.carry(intent.tip, hand.origin);
      copy(hand.aim, intent.aim);
      copy(hand.tip, hand.origin);
      hand.update(intent.trigger, dt);
    }
    const right = hands[Side.Right].tool as T | null;
    const left = hands[Side.Left].tool as T | null;
    s.tool = right?.id ?? NO_TOOL;
    s.ltool = left?.id ?? NO_TOOL;
    this.inventory.current = right ?? left ?? this.inventory.fallback; // what you'd drop if you died now
  }

  /** Use up charges of a tool. Running out takes the kind away. */
  spend(tool: T, n = 1): void {
    if (this.inventory.spend(tool, n)) this.drop(tool, 'spent', 0);
  }

  protected drop(tool: T, reason: DropReason, charges: number, dx = 0): void {
    const s = this.me!.state;
    tool.onDrop(this, { reason, charges, x: s.x + dx, y: s.y });
  }

  /** A point read from the device before this frame's moves, moved along with the avatar. */
  private carry(p: Vec3, out: Vec3): Vec3 {
    out.x = p.x + this.carried.x;
    out.y = p.y + this.carried.y;
    out.z = p.z;
    return out;
  }

  /** Replicate where a hand is and where it points, so others see it and the tool in it. */
  private setHandFields(pos: Vec3, aim: Vec3, side: Side): void {
    const s = this.me!.state;
    const x = clamp(pos.x - s.x, -1.5, 1.5);
    const y = clamp(pos.y - s.y, -1.5, 1.5);
    const z = clamp(pos.z - this.feetZ(), 0, 2.5);
    const yaw = Math.atan2(aim.y, aim.x);
    const pitch = Math.asin(clamp(aim.z, -1, 1));
    if (side === Side.Left) Object.assign(s, { lhx: x, lhy: y, lhz: z, laimYaw: yaw, laimPitch: pitch });
    else Object.assign(s, { hx: x, hy: y, hz: z, aimYaw: yaw, aimPitch: pitch });
  }
}

function copy(out: Vec3, p: Vec3): Vec3 {
  out.x = p.x;
  out.y = p.y;
  out.z = p.z;
  return out;
}
