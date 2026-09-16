import { Avatar, RADIUS, type AvatarBody as BodyCallbacks, type AvatarFrontend as BodyFrontend } from '../crossplay/avatar';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import { TOOLS } from './arsenal';
import { angleDiff, type CarEntity, type GameContext, type PedEntity, type PickupEntity, type PlayerEntity, type Vec3 } from './context';
import { Car, CarKind, CarMode, Feed, Horn, Ped, PedMode, Pickup, PickupKind, Player } from './defs';
import type { AvatarIntent } from './intent';
import { PedMind, moveCircle } from './peds';
import { CUFF_RANGE, spawnOfficer } from './police';
import { PED_SKINS, carExtents, carSpec } from './specs';
import type { Tool, Toolbox } from './tool';
import { driveCar } from './vehicles';

const ARREST_MS = 3000;

/** How Peer City's avatar rules reach the device: the body's callbacks (see crossplay/avatar.ts), plus sitting down to drive. */
export interface AvatarBody extends BodyCallbacks {
  /** Sat down in a driver's seat. */
  seated(): void;
}

/** A platform's frontend for Peer City's avatar. */
export interface AvatarFrontend extends BodyFrontend<AvatarIntent>, AvatarBody {}

const NO_BODY: AvatarBody = { platform: Platform.Desktop, moved() {}, placed() {}, seated() {}, hurt() {}, used() {}, died() {} };

/**
 * The avatar role in Peer City: the local player's `Player` on foot (see `Avatar` for walking and using
 * tools) and driving, pickups, wanted level, death and arrest. It only sees `AvatarIntent`s and talks back
 * through `body`, so the same rules serve every platform and run headless in tests.
 */
export class AvatarSim extends Avatar<AvatarIntent, AvatarBody, Tool> implements Role<AvatarIntent, AvatarFrontend> {
  body: AvatarBody = NO_BODY;
  /** Smoothed steering input, for the steering wheel model. */
  steer = 0;
  /** The car you could get into from where you're standing this frame. */
  nearCar: CarEntity | undefined;
  /** An officer has hold of you this frame. */
  cuffed = false;
  private respawnAt = 0;
  private arrestedUntil = 0;
  private lastCrime = 0;
  private enterPending = false;
  private readonly collecting = new Set<number>();

  constructor(
    readonly ctx: GameContext,
    tools: Toolbox<Tool> = TOOLS,
  ) {
    super(tools);
  }

  get me(): PlayerEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
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
    this.begin(intent);
    this.nearCar = undefined;
    this.cuffed = false;
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

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    moveCircle(this.ctx.city, p, dx, dy, RADIUS);
  }

  /** Don't walk through vehicles (unless you've jumped over their roofs). */
  protected override collide(p: { x: number; y: number }, z: number): void {
    if (z < 1.2) this.pushOutOfCars(p);
  }

  protected override switchedTool(): void {
    this.ctx.sfx.play('empty');
  }

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
  override eyePosition(out: Vec3): Vec3 {
    const s = this.me!.state;
    const car = s.car ? this.currentCar : undefined;
    if (!car) return super.eyePosition(out);
    const spec = carSpec(car.state.kind);
    const a = car.state.angle;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    out.x = car.state.x + spec.eye[0] * c - spec.eye[2] * sn;
    out.y = car.state.y + spec.eye[0] * sn + spec.eye[2] * c;
    out.z = spec.eye[1];
    return out;
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
        Object.assign(PedMind.of(ped), { fx: s.x, fy: s.y, fleeUntil: ctx.now + 6000 });
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

  /** Called by combat when our avatar takes damage (already applied to its hp). */
  hurt(amount: number): void {
    this.body.hurt(amount);
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
      void ctx.world
        .withLock(pk, () => {
          if (!this.me) return;
          this.applyPickup(pk);
          ctx.world.despawn(pk);
        })
        .then(() => this.collecting.delete(pk.id));
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
