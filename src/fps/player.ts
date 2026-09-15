import { angleDiff, clamp, direction, type CarEntity, type GameContext, type PedEntity, type PickupEntity, type PlayerEntity, type Vec3 } from './context';
import { Car, CarKind, CarMode, Feed, Horn, Ped, PedMode, Pickup, PickupKind, Player } from './defs';
import { HAND_MUZZLE, type Hands } from './hands';
import type { DesktopInput } from './input';
import { moveCircle } from './peds';
import { CUFF_RANGE, isPoliceUnit, spawnOfficer } from './police';
import { Btn, type XRHand } from './rig';
import { PED_SKINS, carExtents, carSpec } from './specs';
import { driveCar } from './vehicles';
import { fireBullet } from './weapons';

const WALK = 4.2;
const RUN = 7.2;
const RADIUS = 0.35;
const EYE = 1.65;
const GRAVITY = 20;
const JUMP_SPEED = 6;
const GUN_RANGE = 160;
const FIRE_MS = 160;
const ARREST_MS = 3000;
const MOUSE_SENSITIVITY = 0.0022;
const SNAP_TURN = Math.PI / 6;

const deadzone = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);

/**
 * Local player: input (desktop or headset), on-foot movement, driving,
 * shooting and life cycle.
 *
 * In VR the avatar's position is the head's position on the ground. Walking
 * around your room moves the head; when that would put it inside a wall the
 * play space is pushed back instead, so you can't physically walk through
 * buildings. The thumbstick and snap turn move the play space itself.
 */
export class PlayerController {
  /** Desktop look direction. Absolute, and carried round with the car while driving. */
  heading = 0;
  pitch = 0;
  thirdPerson = false;
  /** Smoothed steering input, for the steering wheel model. */
  steer = 0;
  private nextShot = 0;
  private nextShotLeft = 0;
  private respawnAt = 0;
  private arrestedUntil = 0;
  private lastCrime = 0;
  private enterPending = false;
  private readonly collecting = new Set<number>();
  private vz = 0;
  private turnArmed = true;
  private deathOrbit = 0;
  private readonly muzzle: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly aim: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly eye: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: GameContext,
    private readonly input: DesktopInput,
    private readonly hands: Hands,
  ) {}

  get me(): PlayerEntity | null {
    return this.ctx.me;
  }

  get currentCar(): CarEntity | undefined {
    const me = this.me;
    return me && me.state.car ? this.ctx.world.getAs(Car, me.state.car) : undefined;
  }

  /** Which way the view faces, for the minimap. */
  get viewHeading(): number {
    return this.ctx.rig.xr ? this.ctx.rig.headHeading() : this.heading;
  }

  /** Whether the local avatar should be drawn (desktop death cam and chase cam). */
  get showSelf(): boolean {
    const s = this.me?.state;
    return !!s && !this.ctx.rig.xr && (s.hp === 0 || (s.car !== 0 && this.thirdPerson));
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

  update(dt: number): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    const now = ctx.now;
    const vr = ctx.rig.xr;
    s.vr = vr;
    if (!vr) this.mouseLook();
    if (!s.car) ctx.sfx.engine(false, 0);

    if (s.hp === 0) {
      if (this.respawnAt && now >= this.respawnAt) this.respawn();
      ctx.world.setFocus(s.x, s.y);
      ctx.hud.setStatus(s.cash, s.wanted, 0);
      ctx.hud.setHint('');
      return;
    }

    if (this.arrestedUntil) {
      // cuffed: stand still, then get released downtown
      if (vr) this.walkVR(dt, false);
      if (now >= this.arrestedUntil) {
        this.arrestedUntil = 0;
        const p = this.spawnPoint();
        this.teleport(p.x, p.y);
      }
      ctx.world.setFocus(s.x, s.y);
      ctx.hud.setStatus(s.cash, s.wanted, s.hp);
      ctx.hud.setHint('');
      return;
    }

    if (s.car) {
      const car = this.currentCar;
      if (!car || !car.mine || car.state.mode === CarMode.Wrecked) this.leaveCar(car);
      else this.drive(car, dt);
    } else {
      if (vr) this.walkVR(dt, true);
      else this.walkDesktop(dt);
      const nearCar = this.nearestEnterableCar();
      ctx.hud.setHint(this.beingCuffed() ? 'The cops have hold of you. Run!' : nearCar ? `Press ${vr ? 'A' : 'F'} to take the car` : '');
      if (nearCar && this.interactPressed()) void this.enterCar(nearCar);
      this.collectPickups();
    }

    this.aimAndFire();

    // wanted level cools off without fresh crimes
    if (s.wanted > 0 && now - this.lastCrime > 20000) {
      s.wanted--;
      this.lastCrime = now;
    }

    ctx.world.setFocus(s.x, s.y);
    ctx.hud.setStatus(s.cash, s.wanted, s.hp);
  }

  private interactPressed(): boolean {
    const { rig } = this.ctx;
    if (rig.xr) return rig.right.pressed(Btn.A) || rig.left.pressed(Btn.A);
    return this.input.pressed('KeyF') || this.input.pressed('KeyE');
  }

  private mouseLook(): void {
    const [dx, dy] = this.input.consumeMouse();
    this.heading += dx * MOUSE_SENSITIVITY;
    this.pitch = clamp(this.pitch - dy * MOUSE_SENSITIVITY, -1.45, 1.45);
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

  private walkDesktop(dt: number): void {
    const s = this.me!.state;
    const k = this.input;
    const strafe = (k.down('KeyD') ? 1 : 0) - (k.down('KeyA') ? 1 : 0);
    const forward = (k.down('KeyW') ? 1 : 0) - (k.down('KeyS') ? 1 : 0);
    const run = k.down('ShiftLeft') || k.down('ShiftRight');
    this.step(s, strafe, forward, this.heading, run ? RUN : WALK, dt);
    if (k.pressed('Space') && s.z <= 0) this.vz = JUMP_SPEED;
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

  private walkVR(dt: number, allowLocomotion: boolean): void {
    const { rig } = this.ctx;
    const s = this.me!.state;

    // Room-scale: follow the head, but never into walls or cars.
    const head = rig.head(this.tmp);
    const dx = head.x - s.x;
    const dy = head.y - s.y;
    if (dx * dx + dy * dy > 9) {
      rig.placeHeadAt(s.x, s.y); // first frame, or tracking jumped
    } else {
      const p = { x: s.x, y: s.y };
      moveCircle(this.ctx.city, p, dx, dy, RADIUS);
      this.pushOutOfCars(p);
      rig.shift(p.x - head.x, p.y - head.y);
      s.x = p.x;
      s.y = p.y;
    }

    if (allowLocomotion) {
      const L = rig.left;
      const strafe = deadzone(L.stickX);
      const forward = -deadzone(L.stickY);
      if (strafe || forward) {
        const run = L.squeeze > 0.5 || L.down(Btn.Stick);
        const p = { x: s.x, y: s.y };
        this.step(p, strafe, forward, rig.headHeading(), run ? RUN : WALK, dt);
        this.pushOutOfCars(p);
        rig.shift(p.x - s.x, p.y - s.y);
        s.x = p.x;
        s.y = p.y;
      }
      const turn = rig.right.stickX;
      if (this.turnArmed && Math.abs(turn) > 0.7) {
        rig.rotateAroundHead(turn > 0 ? -SNAP_TURN : SNAP_TURN);
        this.turnArmed = false;
      } else if (Math.abs(turn) < 0.3) {
        this.turnArmed = true;
      }
    }

    s.z = 0;
    s.yaw = rig.headHeading();
    s.pitch = rig.headPitch();
    s.head = clamp(rig.headLocal.y + rig.root.position.y, 0.4, 2.3);
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

  private drive(car: CarEntity, dt: number): void {
    const { ctx } = this;
    const { rig } = ctx;
    const s = this.me!.state;
    let throttle: number;
    let steer: number;
    let handbrake: boolean;
    let exit: boolean;
    let horn: boolean;
    if (rig.xr) {
      throttle = -deadzone(rig.left.stickY);
      steer = deadzone(rig.left.stickX);
      handbrake = rig.right.squeeze > 0.5;
      exit = rig.right.pressed(Btn.A) || rig.left.pressed(Btn.A);
      horn = rig.right.pressed(Btn.B);
      if (rig.left.pressed(Btn.B)) {
        rig.recenter();
        ctx.hud.message('Seat recentered');
      }
    } else {
      const k = this.input;
      throttle = (k.down('KeyW') ? 1 : 0) - (k.down('KeyS') ? 1 : 0);
      steer = (k.down('KeyD') ? 1 : 0) - (k.down('KeyA') ? 1 : 0);
      handbrake = k.down('Space');
      exit = k.pressed('KeyF') || k.pressed('KeyE');
      horn = k.pressed('KeyH');
      if (k.pressed('KeyV')) this.thirdPerson = !this.thirdPerson;
    }
    const before = car.state.angle;
    driveCar(ctx, car, { throttle, steer, handbrake }, dt);
    this.steer += (steer - this.steer) * Math.min(1, dt * 10);
    this.heading += angleDiff(before, car.state.angle);
    s.x = car.state.x;
    s.y = car.state.y;
    s.z = 0;
    s.yaw = rig.xr ? rig.headHeading() : this.heading;
    s.pitch = rig.xr ? rig.headPitch() : this.pitch;
    s.head = 1.2;
    ctx.sfx.engine(true, car.state.speed);
    ctx.hud.setHint('');
    if (horn) ctx.world.send(Horn, { car: car.id }, { to: 'near', x: s.x, y: s.y, radius: 120 });
    if (exit) this.leaveCar(car);
  }

  /** Where the eyes are: standing height, or the driver's seat. */
  private eyePosition(out: Vec3): Vec3 {
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

  private aimAndFire(): void {
    const { ctx } = this;
    const { rig } = ctx;
    const s = this.me!.state;
    if (rig.xr) {
      // Each hand holds a pistol; aim is wherever the controller points.
      for (const hand of [rig.left, rig.right]) {
        if (!hand.connected) continue;
        rig.handPose(hand, HAND_MUZZLE, this.muzzle, this.aim);
        const right = hand === rig.right;
        if (right) this.setHandFields(this.muzzle, this.aim);
        if (hand.trigger < 0.6 || ctx.now < (right ? this.nextShot : this.nextShotLeft)) continue;
        if (right) this.nextShot = ctx.now + FIRE_MS;
        else this.nextShotLeft = ctx.now + FIRE_MS;
        this.fire(this.muzzle, this.aim, undefined, hand);
        this.setHandFields(this.muzzle, this.aim);
      }
      return;
    }

    // Desktop: aim from the eye through the crosshair; the tracer leaves the gun.
    direction(this.heading, this.pitch, this.aim);
    const c = Math.cos(this.heading);
    const sn = Math.sin(this.heading);
    this.muzzle.x = s.x + c * 0.45 - sn * 0.22;
    this.muzzle.y = s.y + sn * 0.45 + c * 0.22;
    this.muzzle.z = s.z + EYE - 0.3;
    this.setHandFields(this.muzzle, this.aim);
    if (this.input.locked && this.input.mouse(0) && ctx.now >= this.nextShot) {
      this.nextShot = ctx.now + FIRE_MS;
      const from = this.thirdPerson && s.car ? undefined : this.hands.desktopMuzzle(this.tmp);
      this.fire(this.eyePosition(this.eye), this.aim, from, undefined);
    }
  }

  private fire(origin: Vec3, aim: Vec3, from: Vec3 | undefined, hand: XRHand | undefined): void {
    const { ctx } = this;
    const me = this.me!;
    const hit = fireBullet(ctx, me, origin, aim, {
      range: GUN_RANGE,
      ignore: me.state.car || undefined,
      from,
      damage: (e, head) => (e.def === Car ? 8 : head ? 60 : 22),
    });
    this.hands.recoil(hand);
    hand?.pulse(0.6, 35);
    if (hit.entity) {
      ctx.hud.hitMarker(hit.head);
      ctx.sfx.play(hit.head ? 'headshot' : 'hit');
      hand?.pulse(1, 60);
    }
    // shooting at police is 2 stars; shooting anywhere near them is 1
    if (hit.entity && isPoliceUnit(hit.entity)) this.raiseWanted(2);
    else if (ctx.world.query(me.state.x, me.state.y, 65).some(isPoliceUnit)) this.raiseWanted(1);
  }

  /** Replicate where the gun is, so others see it in your hand. */
  private setHandFields(pos: Vec3, aim: Vec3): void {
    const s = this.me!.state;
    s.hx = clamp(pos.x - s.x, -1.5, 1.5);
    s.hy = clamp(pos.y - s.y, -1.5, 1.5);
    s.hz = clamp(pos.z - s.z, 0, 2.5);
    s.aimYaw = Math.atan2(aim.y, aim.x);
    s.aimPitch = Math.asin(clamp(aim.z, -1, 1));
  }

  /** Position the camera (desktop) or the play space (VR, while seated). Runs after simulation. */
  updateView(dt: number): void {
    const { ctx } = this;
    const { rig } = ctx;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    const car = s.car ? this.currentCar : undefined;
    const alive = s.hp > 0;

    if (rig.xr) {
      if (car && alive) {
        const e = this.eyePosition(this.eye);
        rig.seatIn(e.x, e.y, e.z, car.state.angle);
      }
      rig.setTint(this.arrestedUntil ? 0x0a1a55 : 0x550000, !alive ? 0.6 : this.arrestedUntil ? 0.3 : 0);
    } else {
      if (!alive) {
        this.deathOrbit += dt * 0.4;
        rig.setDesktopChase({ x: s.x + Math.cos(this.deathOrbit) * 4, y: s.y + Math.sin(this.deathOrbit) * 4, z: 3.5 }, { x: s.x, y: s.y, z: 0.3 });
      } else if (car && this.thirdPerson) {
        const a = car.state.angle;
        const back = Math.max(2, Math.min(8, ctx.city.raycast(car.state.x, car.state.y, a + Math.PI, 8) - 0.6));
        rig.setDesktopChase(
          { x: car.state.x - Math.cos(a) * back, y: car.state.y - Math.sin(a) * back, z: 3.2 },
          { x: car.state.x + Math.cos(a) * 4, y: car.state.y + Math.sin(a) * 4, z: 1.2 },
        );
      } else {
        const e = this.eyePosition(this.eye);
        rig.setDesktopView(e.x, e.y, e.z, this.heading, this.pitch);
      }
      rig.setTint(0x550000, alive ? 0 : 0.3);
    }
    this.hands.update(dt, !rig.xr && alive && !(car && this.thirdPerson), rig.xr && alive);

    const head = rig.head(this.tmp);
    ctx.sfx.setListener(head, direction(this.viewHeading, rig.xr ? rig.headPitch() : this.pitch, this.aim));
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
    ctx.rig.recenter();
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
    if (ctx.rig.xr) {
      ctx.rig.leaveSeat();
      ctx.rig.placeHeadAt(me.state.x, me.state.y);
    }
  }

  /** Knockback from a hit. In VR the play space moves with you. */
  nudge(dx: number, dy: number): void {
    const s = this.me!.state;
    const p = { x: s.x, y: s.y };
    moveCircle(this.ctx.city, p, dx, dy, RADIUS);
    if (this.ctx.rig.xr) this.ctx.rig.shift(p.x - s.x, p.y - s.y);
    s.x = p.x;
    s.y = p.y;
  }

  private teleport(x: number, y: number): void {
    const s = this.me!.state;
    s.x = x;
    s.y = y;
    s.z = 0;
    if (this.ctx.rig.xr) this.ctx.rig.placeHeadAt(x, y);
  }

  /** Called when a VR session ends: keep facing where the headset faced. */
  onLeaveVR(): void {
    this.heading = this.me?.state.yaw ?? 0;
    this.pitch = 0;
  }

  private collectPickups(): void {
    const { ctx } = this;
    const me = this.me!;
    for (const pk of ctx.world.query(me.state.x, me.state.y, 1.3, Pickup)) {
      if (this.collecting.has(pk.id)) continue;
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
    if (pk.state.kind === PickupKind.Cash) s.cash += pk.state.amount;
    else s.hp = Math.min(100, s.hp + pk.state.amount);
    this.ctx.sfx.play('pickup');
  }

  crime(stars: number): void {
    const s = this.me?.state;
    if (!s) return;
    s.wanted = Math.min(5, s.wanted + stars);
    this.lastCrime = this.ctx.now;
  }

  /** Raise the wanted level to at least `level` and restart the cool-off. */
  private raiseWanted(level: number): void {
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
    this.deathOrbit = this.heading + Math.PI;
    ctx.hud.showBanner('WASTED', '#e53935', 4000);
    ctx.sfx.play('wasted');
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
