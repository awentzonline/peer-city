import { TOOLS } from './arsenal';
import { angleDiff, clamp, direction, type CarEntity, type GameContext, type PedEntity, type PickupEntity, type PlayerEntity, type Vec3 } from './context';
import { Car, CarKind, CarMode, Feed, Horn, Ped, PedMode, Pickup, PickupKind, Player } from './defs';
import { HeldTool } from './heldTool';
import { Side, type AvatarIntent, type HandIntent, type TrackedHead } from './intent';
import { Inventory } from './inventory';
import { moveCircle } from './peds';
import { Platform } from './platform';
import { CUFF_RANGE, spawnOfficer } from './police';
import type { Frontend, Role } from './role';
import { PED_SKINS, carExtents, carSpec } from './specs';
import { NO_TOOL, type DropReason, type Tool, type Toolbox, type UseEffect } from './tool';
import { driveCar } from './vehicles';

const WALK = 4.2;
const RUN = 7.2;
const RADIUS = 0.35;
const EYE = 1.65;
const GRAVITY = 20;
const JUMP_SPEED = 6;
const ARREST_MS = 3000;
/** Tracked-head stick locomotion: one fast top speed, ~95% reached in half a second, and stopping is quicker. */
const TRACKED_SPEED = 7;
const TRACKED_ACCEL = 6;
const TRACKED_BRAKE = 12;

function copy(out: Vec3, p: Vec3): Vec3 {
  out.x = p.x;
  out.y = p.y;
  out.z = p.z;
  return out;
}

/**
 * How the avatar's rules reach back to the device playing it. `AvatarSim` calls these and each platform
 * decides what they mean there: a headset moves its play space when the avatar is pushed, a desktop has
 * nothing to move.
 */
export interface AvatarBody {
  readonly platform: Platform;
  /** The rules moved the avatar: a wall or car held the head back, the stick walked it, or a hit knocked it. */
  moved(dx: number, dy: number): void;
  /** The avatar was put down at (x, y): released, respawned or out of a car. */
  placed(x: number, y: number): void;
  /** Sat down in a driver's seat. */
  seated(): void;
  hurt(amount: number): void;
  /** The tool in a hand, or the crosshair tool (`side` null), was used: recoil, haptics, hit markers. */
  used(side: Side | null, tool: Tool, effect: UseEffect): void;
  died(): void;
}

/** A platform's frontend for the avatar role. */
export interface AvatarFrontend extends Frontend<AvatarIntent>, AvatarBody {
  /** Whether to draw your own avatar, e.g. from a chase camera. */
  readonly showSelf: boolean;
}

const NO_BODY: AvatarBody = { platform: Platform.Desktop, moved() {}, placed() {}, seated() {}, hurt() {}, used() {}, died() {} };

/**
 * The avatar role: the local player's `Player` on foot and driving, using tools, pickups, wanted level,
 * death and arrest. It only sees `AvatarIntent`s and talks back through `body`, so the same rules serve
 * every platform and run headless in tests.
 *
 * With a tracked head the avatar stands wherever the head is. Walking round your room walks it; when that
 * would put the head in a wall or a car the avatar stays out and `body.moved` pushes the play space back,
 * so you can't physically walk through buildings.
 */
export class AvatarSim implements Role<AvatarIntent, AvatarFrontend> {
  body: AvatarBody = NO_BODY;
  /** Where a virtual head faces. Carried round with the car while driving. */
  heading = 0;
  pitch = 0;
  /** Smoothed steering input, for the steering wheel model. */
  steer = 0;
  /** The car you could get into from where you're standing this frame. */
  nearCar: CarEntity | undefined;
  /** An officer has hold of you this frame. */
  cuffed = false;
  readonly inventory: Inventory;
  /** What each hand, by `Side`, is holding. The crosshair tool is the right hand's. */
  private readonly hands: [HeldTool, HeldTool];
  private respawnAt = 0;
  private arrestedUntil = 0;
  private lastCrime = 0;
  private enterPending = false;
  private readonly collecting = new Set<number>();
  private vz = 0;
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

  constructor(
    readonly ctx: GameContext,
    tools: Toolbox = TOOLS,
  ) {
    this.inventory = new Inventory(tools);
    this.hands = [new HeldTool(this), new HeldTool(this)];
  }

  attach(body: AvatarBody): void {
    this.body = body;
  }

  get me(): PlayerEntity | null {
    return this.ctx.me;
  }

  get currentCar(): CarEntity | undefined {
    const me = this.me;
    return me && me.state.car ? this.ctx.world.getAs(Car, me.state.car) : undefined;
  }

  /** Cuffed, waiting to be released. */
  get arrested(): boolean {
    return this.arrestedUntil !== 0;
  }

  /** Alive, free and on foot. */
  get onFoot(): boolean {
    const s = this.me?.state;
    return !!s && s.hp > 0 && s.car === 0 && !this.arrestedUntil;
  }

  /** Alive, free and in a car. */
  get driving(): boolean {
    const s = this.me?.state;
    return !!s && s.hp > 0 && s.car !== 0 && !this.arrestedUntil;
  }

  spawn(): void {
    const spot = this.spawnPoint();
    this.ctx.me = this.ctx.world.spawn(Player, {
      x: spot.x,
      y: spot.y,
      name: this.ctx.playerName,
      skin: Math.floor(Math.random() * PED_SKINS),
      hp: 100,
      cash: 250,
      head: EYE,
    });
    this.heading = Math.random() * Math.PI * 2;
    this.ctx.world.setFocus(spot.x, spot.y);
  }

  private spawnPoint(): { x: number; y: number } {
    const { city } = this.ctx;
    // Everyone spawns downtown so players find each other in a big open world.
    const c = city.size / 2;
    return city.randomWalkableNear(c, c, 0, 120) ?? city.randomWalkableNear(c, c, 0, 250) ?? { x: c, y: c };
  }

  update(dt: number, intent: AvatarIntent): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    const now = ctx.now;
    s.platform = this.body.platform;
    this.carried.x = this.carried.y = 0;
    this.posesStale = false;
    this.nearCar = undefined;
    this.cuffed = false;
    this.look(intent);
    if (!s.car) ctx.sfx.engine(false, 0);

    if (s.hp === 0) {
      if (this.respawnAt && now >= this.respawnAt) this.respawn();
      ctx.world.setFocus(s.x, s.y);
      return;
    }

    if (this.arrestedUntil) {
      // cuffed: stand still, then get released downtown
      if (intent.head) this.walkTracked(dt, intent.head, intent, false);
      if (now >= this.arrestedUntil) {
        this.arrestedUntil = 0;
        const p = this.spawnPoint();
        this.teleport(p.x, p.y);
      }
      ctx.world.setFocus(s.x, s.y);
      return;
    }

    if (s.car) {
      const car = this.currentCar;
      if (!car || !car.mine || car.state.mode === CarMode.Wrecked) this.leaveCar(car);
      else this.drive(car, dt, intent);
    } else {
      if (intent.head) this.walkTracked(dt, intent.head, intent, true);
      else this.walk(dt, intent);
      this.cuffed = this.beingCuffed();
      this.nearCar = this.nearestEnterableCar();
      if (this.nearCar && intent.interact) void this.enterCar(this.nearCar);
      this.collectPickups();
    }

    if (intent.hands) this.useHands(intent.hands, dt);
    else this.useCrosshair(intent, dt);

    // wanted level cools off without fresh crimes
    if (s.wanted > 0 && now - this.lastCrime > 20000) {
      s.wanted--;
      this.lastCrime = now;
    }

    ctx.world.setFocus(s.x, s.y);
  }

  /** Turn a virtual head. Taking a headset off leaves it facing where the headset faced. */
  private look(intent: AvatarIntent): void {
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
    moveCircle(this.ctx.city, p, (c * forward - sn * strafe) * k, (sn * forward + c * strafe) * k, RADIUS);
  }

  /** A virtual head: walk or run at once, and jump. */
  private walk(dt: number, intent: AvatarIntent): void {
    const s = this.me!.state;
    this.step(s, intent.strafe, intent.forward, this.heading, intent.run ? RUN : WALK, dt);
    if (intent.jump && s.z <= 0) this.vz = JUMP_SPEED;
    if (s.z > 0 || this.vz > 0) {
      s.z += this.vz * dt;
      this.vz -= GRAVITY * dt;
      if (s.z <= 0) s.z = this.vz = 0;
    }
    if (s.z < 1.2) this.pushOutOfCars(s);
    s.yaw = this.heading;
    s.pitch = this.pitch;
    s.head = EYE;
  }

  /** A tracked head: follow it round the room, and ease the stick up to speed (sudden starts are nauseating). */
  private walkTracked(dt: number, head: TrackedHead, intent: AvatarIntent, allowLocomotion: boolean): void {
    const s = this.me!.state;

    // Room-scale: follow the head, but never into walls or cars.
    const dx = head.x - s.x;
    const dy = head.y - s.y;
    if (dx * dx + dy * dy > 9) {
      this.shift(s.x - head.x, s.y - head.y); // first frame, or tracking jumped
    } else {
      const p = { x: s.x, y: s.y };
      moveCircle(this.ctx.city, p, dx, dy, RADIUS);
      this.pushOutOfCars(p);
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
        moveCircle(this.ctx.city, p, vel.x * dt, vel.y * dt, RADIUS);
        // sliding along a wall keeps only the speed along it
        vel.x = (p.x - s.x) / dt;
        vel.y = (p.y - s.y) / dt;
        this.pushOutOfCars(p);
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
    s.head = clamp(head.z, 0.4, 2.3);
  }

  /** The rules moved the avatar; the device follows. */
  private shift(dx: number, dy: number): void {
    this.carried.x += dx;
    this.carried.y += dy;
    this.body.moved(dx, dy);
  }

  private place(x: number, y: number): void {
    this.posesStale = true;
    this.body.placed(x, y);
  }

  /** Don't walk through vehicles. */
  private pushOutOfCars(p: { x: number; y: number }): void {
    for (const car of this.ctx.world.query(p.x, p.y, 4, Car)) {
      const { hl, hw } = carExtents(car.state.kind);
      const c = Math.cos(car.render.angle);
      const sn = Math.sin(car.render.angle);
      const rx = (p.x - car.x) * c + (p.y - car.y) * sn;
      const ry = -(p.x - car.x) * sn + (p.y - car.y) * c;
      const px = hl + RADIUS - Math.abs(rx);
      const py = hw + RADIUS - Math.abs(ry);
      if (px <= 0 || py <= 0) continue;
      let ox = 0;
      let oy = 0;
      if (px < py) ox = Math.sign(rx || 1) * px;
      else oy = Math.sign(ry || 1) * py;
      moveCircle(this.ctx.city, p, ox * c - oy * sn, ox * sn + oy * c, RADIUS);
    }
  }

  private drive(car: CarEntity, dt: number, intent: AvatarIntent): void {
    const { ctx } = this;
    const s = this.me!.state;
    const before = car.state.angle;
    driveCar(ctx, car, { throttle: intent.forward, steer: intent.strafe, handbrake: intent.brake }, dt);
    this.steer += (intent.strafe - this.steer) * Math.min(1, dt * 10);
    this.heading += angleDiff(before, car.state.angle);
    s.x = car.state.x;
    s.y = car.state.y;
    s.z = 0;
    s.yaw = intent.head ? intent.head.heading : this.heading;
    s.pitch = intent.head ? intent.head.pitch : this.pitch;
    s.head = 1.2;
    ctx.sfx.engine(true, car.state.speed);
    if (intent.horn) ctx.world.send(Horn, { car: car.id }, { to: 'near', x: s.x, y: s.y, radius: 120 });
    if (intent.interact) this.leaveCar(car);
  }

  /** Where the eyes are: standing height, or the driver's seat. */
  eyePosition(out: Vec3): Vec3 {
    const s = this.me!.state;
    const car = s.car ? this.currentCar : undefined;
    if (car) {
      const spec = carSpec(car.state.kind);
      const a = car.state.angle;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      out.x = car.state.x + spec.eye[0] * c - spec.eye[2] * sn;
      out.y = car.state.y + spec.eye[0] * sn + spec.eye[2] * c;
      out.z = spec.eye[1];
    } else {
      out.x = s.x;
      out.y = s.y;
      out.z = s.z + EYE;
    }
    return out;
  }

  /** The selected tool, used from the eyes through the middle of the view, with its hand held out in front. */
  private useCrosshair(intent: AvatarIntent, dt: number): void {
    const { inventory: inv } = this;
    const s = this.me!.state;
    const before = inv.current;
    if (intent.cycleTool) inv.cycle(intent.cycleTool > 0 ? 1 : -1);
    if (intent.selectTool) inv.select(intent.selectTool);
    if (inv.current !== before) this.ctx.sfx.play('empty');

    const heading = intent.head?.heading ?? this.heading;
    direction(heading, intent.head?.pitch ?? this.pitch, this.aim);
    const c = Math.cos(heading);
    const sn = Math.sin(heading);
    this.grip.x = s.x + c * 0.45 - sn * 0.22;
    this.grip.y = s.y + sn * 0.45 + c * 0.22;
    this.grip.z = s.z + EYE - 0.3;
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
  private useHands(hands: [HandIntent, HandIntent], dt: number): void {
    const s = this.me!.state;
    for (const side of [Side.Left, Side.Right]) {
      const intent = hands[side];
      const hand = this.hands[side];
      hand.side = side;
      hand.hold(intent.tool);
      if (!intent.tracked || this.posesStale) continue;
      this.setHandFields(this.carry(intent.grip, this.grip), intent.pointing, side);
      this.carry(intent.tip, hand.origin);
      copy(hand.aim, intent.aim);
      copy(hand.tip, hand.origin);
      hand.update(intent.trigger, dt);
    }
    const right = hands[Side.Right].tool;
    const left = hands[Side.Left].tool;
    s.tool = right?.id ?? NO_TOOL;
    s.ltool = left?.id ?? NO_TOOL;
    this.inventory.current = right ?? left ?? this.inventory.fallback; // what you'd drop if you died now
  }

  /** Use up charges of a tool. Running out takes the kind away. */
  spend(tool: Tool, n = 1): void {
    if (this.inventory.spend(tool, n)) this.drop(tool, 'spent', 0);
  }

  private drop(tool: Tool, reason: DropReason, charges: number, dx = 0): void {
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
    const z = clamp(pos.z - s.z, 0, 2.5);
    const yaw = Math.atan2(aim.y, aim.x);
    const pitch = Math.asin(clamp(aim.z, -1, 1));
    if (side === Side.Left) Object.assign(s, { lhx: x, lhy: y, lhz: z, laimYaw: yaw, laimPitch: pitch });
    else Object.assign(s, { hx: x, hy: y, hz: z, aimYaw: yaw, aimPitch: pitch });
  }

  private beingCuffed(): boolean {
    const me = this.me!;
    return this.ctx.world
      .query(me.state.x, me.state.y, CUFF_RANGE + 1, Ped)
      .some((c) => c.state.cop && c.state.mode === PedMode.Attack && c.state.target === me.id);
  }

  private nearestEnterableCar(): CarEntity | undefined {
    const s = this.me!.state;
    let best: CarEntity | undefined;
    let bestD = 4.5;
    for (const car of this.ctx.world.query(s.x, s.y, 6, Car)) {
      if (car.state.mode === CarMode.Wrecked) continue;
      if (car.state.mode === CarMode.Driven && car.state.driver !== 0) continue;
      const d = Math.hypot(car.x - s.x, car.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = car;
      }
    }
    return best;
  }

  private async enterCar(car: CarEntity): Promise<void> {
    const { ctx } = this;
    if (this.enterPending) return;
    this.enterPending = true;
    const ok = await ctx.world.requestOwnership(car);
    this.enterPending = false;
    const me = this.me;
    if (!me || me.state.hp === 0 || me.state.car) {
      if (ok) ctx.world.release(car);
      return;
    }
    if (!ok || !car.alive || car.state.mode === CarMode.Wrecked) {
      ctx.hud.message("Couldn't get in");
      return;
    }
    const s = car.state;
    if (s.mode === CarMode.Traffic || s.mode === CarMode.Chase) {
      // drag the NPC driver out; civilians run for it, officers come after you
      const side = this.freeSideOf(car);
      if (s.kind === CarKind.Police) {
        this.crime(2);
        spawnOfficer(ctx, side.x, side.y, me.id);
      } else {
        const ped = ctx.world.spawn(Ped, { x: side.x, y: side.y, skin: Math.floor(Math.random() * PED_SKINS), mode: PedMode.Flee });
        Object.assign(ped.local, { fx: s.x, fy: s.y, fleeUntil: ctx.now + 6000 });
      }
    }
    s.mode = CarMode.Driven;
    s.driver = me.id;
    s.siren = false;
    s.target = 0;
    me.state.car = car.id;
    this.steer = 0;
    this.body.seated();
    ctx.sfx.play('door');
  }

  private freeSideOf(car: CarEntity): { x: number; y: number } {
    const s = car.state;
    const { hw, hl } = carExtents(s.kind);
    const c = Math.cos(s.angle);
    const sn = Math.sin(s.angle);
    const candidates = [
      { x: s.x + sn * (hw + 0.9), y: s.y - c * (hw + 0.9) },
      { x: s.x - sn * (hw + 0.9), y: s.y + c * (hw + 0.9) },
      { x: s.x - c * (hl + 0.9), y: s.y - sn * (hl + 0.9) },
      { x: s.x + c * (hl + 0.9), y: s.y + sn * (hl + 0.9) },
    ];
    return candidates.find((p) => !this.ctx.city.circleBlocked(p.x, p.y, RADIUS)) ?? { x: s.x, y: s.y };
  }

  leaveCar(car: CarEntity | undefined): void {
    const { ctx } = this;
    const me = this.me!;
    if (car && car.mine) {
      car.state.driver = 0;
      if (car.state.mode === CarMode.Driven) car.state.mode = CarMode.Abandoned;
      ctx.world.release(car);
      const p = this.freeSideOf(car);
      me.state.x = p.x;
      me.state.y = p.y;
      ctx.sfx.play('door');
    }
    me.state.car = 0;
    ctx.sfx.engine(false, 0);
    this.place(me.state.x, me.state.y);
  }

  /** Knockback from a hit. */
  nudge(dx: number, dy: number): void {
    const s = this.me!.state;
    const p = { x: s.x, y: s.y };
    moveCircle(this.ctx.city, p, dx, dy, RADIUS);
    this.shift(p.x - s.x, p.y - s.y);
    s.x = p.x;
    s.y = p.y;
  }

  /** Called by combat when our avatar takes damage (already applied to its hp). */
  hurt(amount: number): void {
    this.body.hurt(amount);
  }

  private teleport(x: number, y: number): void {
    const s = this.me!.state;
    s.x = x;
    s.y = y;
    s.z = 0;
    this.place(x, y);
  }

  private collectPickups(): void {
    const { ctx } = this;
    const me = this.me!;
    for (const pk of ctx.world.query(me.state.x, me.state.y, 1.3, Pickup)) {
      if (this.collecting.has(pk.id)) continue;
      // leave tools you have no room for, or for more of their charges
      if (pk.state.kind === PickupKind.Tool) {
        const tool = this.inventory.tools.get(pk.state.tool);
        if (!tool || !this.inventory.wants(tool)) continue;
      }
      this.collecting.add(pk.id);
      // Ownership doubles as a lock: only one player can win the pickup.
      void ctx.world.requestOwnership(pk).then((ok) => {
        this.collecting.delete(pk.id);
        if (!ok || !pk.alive || !this.me) return;
        this.applyPickup(pk);
        ctx.world.despawn(pk);
      });
    }
  }

  private applyPickup(pk: PickupEntity): void {
    const s = this.me!.state;
    const { kind, amount } = pk.state;
    if (kind === PickupKind.Cash) {
      s.cash += amount;
    } else if (kind === PickupKind.Tool) {
      const tool = this.inventory.tools.get(pk.state.tool);
      if (tool) tool.onPickup(this, this.inventory.add(tool, amount));
    } else {
      s.hp = Math.min(100, s.hp + amount);
    }
    this.ctx.sfx.play('pickup');
  }

  crime(stars: number): void {
    const s = this.me?.state;
    if (!s) return;
    s.wanted = Math.min(5, s.wanted + stars);
    this.lastCrime = this.ctx.now;
  }

  /** Raise the wanted level to at least `level` and restart the cool-off. */
  raiseWanted(level: number): void {
    const s = this.me!.state;
    s.wanted = Math.max(s.wanted, level);
    this.lastCrime = this.ctx.now;
  }

  /** Called by combat when our avatar's hp reaches zero. */
  die(killerName: string | null): void {
    const { ctx } = this;
    const me = this.me!;
    if (me.state.car) this.leaveCar(this.currentCar);
    me.state.hp = 0;
    this.respawnAt = ctx.now + 4500;
    this.body.died();
    ctx.hud.showBanner('WASTED', '#e53935', 4000);
    ctx.sfx.play('wasted');
    // the tool in your hand falls where you died; the rest of your things are lost
    const held = this.inventory.takeCurrent();
    for (const lost of this.inventory.clear()) this.drop(lost.tool, 'lost', lost.charges);
    if (held) this.drop(held.tool, 'dropped', held.charges, -1);
    const dropped = Math.floor(me.state.cash * 0.25);
    if (dropped > 0) {
      me.state.cash -= dropped;
      ctx.world.spawn(Pickup, { x: me.state.x + 1, y: me.state.y, kind: PickupKind.Cash, amount: Math.min(65535, dropped) });
    }
    const text = killerName ? `${killerName} wasted ${me.state.name}` : `${me.state.name} got wasted`;
    ctx.world.send(Feed, { text }, { to: 'all' });
  }

  /**
   * An officer's owner says they finished cuffing us. We own our avatar, so we
   * make the call: only if we're still on foot and that officer is really next to us.
   */
  busted(cop: PedEntity | undefined): void {
    const { ctx } = this;
    const me = this.me!;
    if (me.state.hp === 0 || me.state.car || this.arrestedUntil) return;
    if (!cop || !cop.state.cop || Math.hypot(cop.x - me.state.x, cop.y - me.state.y) > 8) return;
    this.arrestedUntil = ctx.now + ARREST_MS;
    ctx.hud.showBanner('BUSTED', '#4fc3ff', ARREST_MS);
    ctx.sfx.play('busted');
    me.state.cash = Math.floor(me.state.cash / 2);
    for (const lost of this.inventory.clear()) this.drop(lost.tool, 'lost', lost.charges); // confiscated
    me.state.wanted = 0; // every officer on the case stands down
    ctx.world.send(Feed, { text: `${me.state.name} got busted` }, { to: 'all' });
  }

  private respawn(): void {
    const me = this.me!;
    const p = this.spawnPoint();
    Object.assign(me.state, { hp: 100, wanted: 0, car: 0 });
    this.teleport(p.x, p.y);
    this.respawnAt = 0;
    this.arrestedUntil = 0;
  }
}
