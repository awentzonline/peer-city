import Phaser from 'phaser';
import type { CarEntity, GameContext, PedEntity, PickupEntity, PlayerEntity } from './context';
import { Car, CarKind, CarMode, Feed, Horn, Ped, PedMode, Pickup, PickupKind, Player } from './defs';
import { moveCircle } from './peds';
import { CUFF_RANGE, isPoliceUnit, spawnOfficer } from './police';
import { PED_SKINS } from './textures';
import { carExtents, driveCar } from './vehicles';
import { fireBullet } from './weapons';

const WALK = 150;
const RUN = 245;
const GUN_RANGE = 560;
const FIRE_MS = 170;
const ARREST_MS = 3000;

type Keys = Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SHIFT' | 'SPACE' | 'F' | 'E' | 'H', Phaser.Input.Keyboard.Key>;

/** Local player input, on-foot movement, driving, shooting and life cycle. */
export class PlayerController {
  private keys: Keys;
  private nextShot = 0;
  private respawnAt = 0;
  private arrestedUntil = 0;
  private lastCrime = 0;
  private enterPending = false;
  private collecting = new Set<number>();
  aimAngle = 0;

  constructor(private readonly ctx: GameContext) {
    this.keys = ctx.scene.input.keyboard!.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SHIFT,SPACE,F,E,H') as Keys;
  }

  get me(): PlayerEntity | null {
    return this.ctx.me;
  }

  spawn(): void {
    const { world } = this.ctx;
    const spot = this.spawnPoint();
    this.ctx.me = world.spawn(Player, {
      x: spot.x,
      y: spot.y,
      name: this.ctx.playerName,
      skin: Math.floor(Math.random() * PED_SKINS),
      hp: 100,
      cash: 250,
    });
    world.setFocus(spot.x, spot.y);
  }

  private spawnPoint(): { x: number; y: number } {
    const { city } = this.ctx;
    // Everyone spawns downtown so players find each other in a big open world.
    const cx = city.pixelWidth / 2;
    const cy = city.pixelHeight / 2;
    return city.randomWalkableNear(cx, cy, 0, 1400) ?? { x: cx, y: cy };
  }

  get currentCar(): CarEntity | undefined {
    const me = this.me;
    return me && me.state.car ? this.ctx.world.getAs(Car, me.state.car) : undefined;
  }

  update(dt: number): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    const now = ctx.now;

    if (s.hp === 0) {
      if (this.respawnAt && now >= this.respawnAt) this.respawn();
      ctx.world.setFocus(s.x, s.y);
      ctx.hud.setStatus(s.cash, s.wanted, 0);
      ctx.hud.setHint('');
      return;
    }

    if (this.arrestedUntil) {
      // cuffed: stand still, then get released downtown
      s.moving = false;
      if (now >= this.arrestedUntil) {
        this.arrestedUntil = 0;
        const p = this.spawnPoint();
        s.x = p.x;
        s.y = p.y;
      }
      ctx.world.setFocus(s.x, s.y);
      ctx.hud.setStatus(s.cash, s.wanted, s.hp);
      ctx.hud.setHint('');
      return;
    }

    const pointer = ctx.scene.input.activePointer;
    const worldPt = ctx.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);

    if (s.car) {
      const car = this.currentCar;
      if (!car || !car.mine || car.state.mode === CarMode.Wrecked) {
        this.leaveCar(car);
      } else {
        const k = this.keys;
        const throttle = (k.W.isDown || k.UP.isDown ? 1 : 0) - (k.S.isDown || k.DOWN.isDown ? 1 : 0);
        const steer = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
        driveCar(ctx, car, { throttle, steer, handbrake: k.SPACE.isDown }, dt);
        s.x = car.state.x;
        s.y = car.state.y;
        s.angle = car.state.angle;
        s.moving = Math.abs(car.state.speed) > 5;
        if (Phaser.Input.Keyboard.JustDown(k.F) || Phaser.Input.Keyboard.JustDown(k.E)) this.leaveCar(car);
        if (Phaser.Input.Keyboard.JustDown(k.H)) {
          ctx.world.send(Horn, { car: car.id }, { to: 'near', x: s.x, y: s.y, radius: 900 });
        }
        ctx.hud.setHint('');
      }
    } else {
      this.walk(dt);
      this.aimAngle = Math.atan2(worldPt.y - s.y, worldPt.x - s.x);
      s.angle = this.aimAngle;
      if (pointer.isDown && now >= this.nextShot) {
        this.nextShot = now + FIRE_MS;
        this.fire();
      }
      const nearCar = this.nearestEnterableCar();
      ctx.hud.setHint(this.beingCuffed() ? 'The cops have hold of you. Run!' : nearCar ? 'Press F to take the car' : '');
      if (nearCar && (Phaser.Input.Keyboard.JustDown(this.keys.F) || Phaser.Input.Keyboard.JustDown(this.keys.E))) {
        void this.enterCar(nearCar);
      }
      this.collectPickups();
    }

    // wanted level cools off without fresh crimes
    if (s.wanted > 0 && now - this.lastCrime > 20000) {
      s.wanted--;
      this.lastCrime = now;
    }

    ctx.world.setFocus(s.x, s.y);
    ctx.hud.setStatus(s.cash, s.wanted, s.hp);
  }

  private walk(dt: number): void {
    const { ctx } = this;
    const s = this.me!.state;
    const k = this.keys;
    let mx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    let my = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
    const len = Math.hypot(mx, my);
    s.moving = len > 0;
    if (len > 0) {
      const speed = (k.SHIFT.isDown ? RUN : WALK) * dt;
      mx = (mx / len) * speed;
      my = (my / len) * speed;
      moveCircle(ctx.city, s, mx, my, 9);
    }
    // don't walk through vehicles
    for (const car of ctx.world.query(s.x, s.y, 50, Car)) {
      const { hl, hw } = carExtents(car.state.kind);
      const c = Math.cos(car.render.angle);
      const sn = Math.sin(car.render.angle);
      const rx = (s.x - car.x) * c + (s.y - car.y) * sn;
      const ry = -(s.x - car.x) * sn + (s.y - car.y) * c;
      const px = hl + 9 - Math.abs(rx);
      const py = hw + 9 - Math.abs(ry);
      if (px <= 0 || py <= 0) continue;
      let ox = 0;
      let oy = 0;
      if (px < py) ox = Math.sign(rx || 1) * px;
      else oy = Math.sign(ry || 1) * py;
      moveCircle(ctx.city, s, ox * c - oy * sn, ox * sn + oy * c, 9);
    }
  }

  private fire(): void {
    const { ctx } = this;
    const me = this.me!;
    const s = me.state;
    const a = this.aimAngle + (Math.random() - 0.5) * 0.05;
    const hit = fireBullet(ctx, me, s.x + Math.cos(a) * 14, s.y + Math.sin(a) * 14, a, {
      range: GUN_RANGE,
      damage: (e) => (e.def === Car ? 8 : 16),
    });
    // shooting at police is 2 stars; shooting anywhere near them is 1
    if (hit && isPoliceUnit(hit)) this.raiseWanted(2);
    else if (ctx.world.query(s.x, s.y, 700).some(isPoliceUnit)) this.raiseWanted(1);
  }

  private beingCuffed(): boolean {
    const me = this.me!;
    return this.ctx.world
      .query(me.state.x, me.state.y, CUFF_RANGE + 10, Ped)
      .some((c) => c.state.cop && c.state.mode === PedMode.Attack && c.state.target === me.id);
  }

  private nearestEnterableCar(): CarEntity | undefined {
    const s = this.me!.state;
    let best: CarEntity | undefined;
    let bestD = 64;
    for (const car of this.ctx.world.query(s.x, s.y, 70, Car)) {
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
    ctx.sfx.play('door', s.x, s.y);
  }

  private freeSideOf(car: CarEntity): { x: number; y: number } {
    const s = car.state;
    const { hw, hl } = carExtents(s.kind);
    const c = Math.cos(s.angle);
    const sn = Math.sin(s.angle);
    const candidates = [
      { x: s.x + sn * (hw + 16), y: s.y - c * (hw + 16) },
      { x: s.x - sn * (hw + 16), y: s.y + c * (hw + 16) },
      { x: s.x - c * (hl + 16), y: s.y - sn * (hl + 16) },
      { x: s.x + c * (hl + 16), y: s.y + sn * (hl + 16) },
    ];
    return candidates.find((p) => !this.ctx.city.circleBlocked(p.x, p.y, 9)) ?? { x: s.x, y: s.y };
  }

  leaveCar(car: CarEntity | undefined): void {
    const me = this.me!;
    if (car && car.mine) {
      car.state.driver = 0;
      if (car.state.mode === CarMode.Driven) car.state.mode = CarMode.Abandoned;
      this.ctx.world.release(car);
      const p = this.freeSideOf(car);
      me.state.x = p.x;
      me.state.y = p.y;
      this.ctx.sfx.play('door', p.x, p.y);
    }
    me.state.car = 0;
  }

  private collectPickups(): void {
    const { ctx } = this;
    const me = this.me!;
    for (const pk of ctx.world.query(me.state.x, me.state.y, 26, Pickup)) {
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
    me.state.moving = false;
    this.respawnAt = ctx.now + 4500;
    ctx.hud.showBanner('WASTED', '#e53935', 4000);
    ctx.sfx.play('wasted');
    const dropped = Math.floor(me.state.cash * 0.25);
    if (dropped > 0) {
      me.state.cash -= dropped;
      ctx.world.spawn(Pickup, { x: me.state.x + 12, y: me.state.y, kind: PickupKind.Cash, amount: Math.min(65535, dropped) });
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
    if (!cop || !cop.state.cop || Math.hypot(cop.x - me.state.x, cop.y - me.state.y) > 90) return;
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
    Object.assign(me.state, { x: p.x, y: p.y, hp: 100, wanted: 0, car: 0 });
    this.respawnAt = 0;
    this.arrestedUntil = 0;
  }
}

