import { DIR_X, DIR_Y, TILE, type City } from './city';
import { angleDiff, clamp, type CarEntity, type GameContext, type PlayerEntity } from './context';
import { Car, CarKind, CarMode, Damage, DamageCause, Explosion, Horn, Ped, PedMode, Player } from './defs';
import { deployOfficers } from './police';
import { carExtents, carSpec } from './specs';

export interface DriveInput {
  throttle: number; // -1..1
  steer: number; // -1..1
  handbrake: boolean;
}

interface CarLocal {
  vx?: number;
  vy?: number;
  hits?: Map<number, number>;
  stuck?: number;
  pushUntil?: number;
  wreckedAt?: number;
  lastAttacker?: number;
  nextHonk?: number;
  avoid?: number;
  avoidUntil?: number;
}

const L = (car: CarEntity) => car.local as CarLocal;

const PROBES: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

export function carBlocked(city: City, x: number, y: number, angle: number, kind: number): boolean {
  const { hl, hw } = carExtents(kind);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (const [px, py] of PROBES) {
    const lx = px * hl;
    const ly = py * hw;
    if (city.isSolidAt(x + lx * c - ly * s, y + lx * s + ly * c)) return true;
  }
  return false;
}

function ensureVelocity(car: CarEntity): CarLocal {
  const l = L(car);
  if (l.vx === undefined || l.vy === undefined) {
    l.vx = Math.cos(car.state.angle) * car.state.speed;
    l.vy = Math.sin(car.state.angle) * car.state.speed;
  }
  return l;
}

/** Arcade car handling for a player-driven vehicle. Meters and seconds. */
export function driveCar(ctx: GameContext, car: CarEntity, input: DriveInput, dt: number): void {
  const s = car.state;
  const l = ensureVelocity(car);
  const a = s.angle;
  let fwd = l.vx! * Math.cos(a) + l.vy! * Math.sin(a);
  let lat = -l.vx! * Math.sin(a) + l.vy! * Math.cos(a);
  const top = carSpec(s.kind).maxSpeed * (s.hp < 30 ? 0.6 : 1);

  if (input.throttle > 0) fwd += (fwd < -0.5 ? 24 : 11) * input.throttle * dt;
  else if (input.throttle < 0) fwd -= (fwd > 0.5 ? 24 : 7) * -input.throttle * dt;
  else fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), 3 * dt);
  if (input.handbrake) fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), 9 * dt);
  fwd = clamp(fwd, -9, top);

  // full steering from walking pace, gentler at speed (first person is twitchy otherwise)
  const authority = clamp(Math.abs(fwd) / 6, 0, 1) * Math.sign(fwd);
  const rate = 2.3 / (1 + Math.abs(fwd) / 30);
  const newAngle = a + input.steer * rate * authority * dt * (input.handbrake ? 1.6 : 1);
  if (!carBlocked(ctx.city, s.x, s.y, newAngle, s.kind)) s.angle = newAngle;

  const grip = input.handbrake ? 1.2 : 8;
  if (((input.handbrake && Math.abs(fwd) > 8) || Math.abs(lat) > 6) && Math.random() < 0.35) {
    ctx.fx.smoke(s.x - Math.cos(s.angle) * 1.6, s.y - Math.sin(s.angle) * 1.6, 0.3);
  }
  lat *= Math.max(0, 1 - grip * dt);

  const c = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  l.vx = c * fwd - sn * lat;
  l.vy = sn * fwd + c * lat;
  moveCar(ctx, car, dt);
}

/** Integrate velocity with tile collisions and entity impacts. */
export function moveCar(ctx: GameContext, car: CarEntity, dt: number): void {
  const s = car.state;
  const l = ensureVelocity(car);
  const city = ctx.city;
  const nx = s.x + l.vx! * dt;
  const ny = s.y + l.vy! * dt;
  let impact = 0;
  if (!carBlocked(city, nx, ny, s.angle, s.kind)) {
    s.x = nx;
    s.y = ny;
  } else if (!carBlocked(city, nx, s.y, s.angle, s.kind)) {
    s.x = nx;
    impact = Math.abs(l.vy!);
    l.vy! *= -0.25;
    l.vx! *= 0.9;
  } else if (!carBlocked(city, s.x, ny, s.angle, s.kind)) {
    s.y = ny;
    impact = Math.abs(l.vx!);
    l.vx! *= -0.25;
    l.vy! *= 0.9;
  } else {
    impact = Math.hypot(l.vx!, l.vy!);
    l.vx! *= -0.3;
    l.vy! *= -0.3;
  }
  if (impact > 13) {
    s.hp = Math.max(0, s.hp - Math.round((impact - 11) * 0.9));
    const hl = carExtents(s.kind).hl;
    ctx.sfx.play('crash', { x: s.x, y: s.y, z: 0.8 });
    ctx.fx.sparks(s.x + Math.cos(s.angle) * hl, s.y + Math.sin(s.angle) * hl, 0.6);
  }
  collideWithEntities(ctx, car);
  s.speed = l.vx! * Math.cos(s.angle) + l.vy! * Math.sin(s.angle);
}

function cooldownOk(car: CarEntity, id: number, now: number, ms: number): boolean {
  const l = L(car);
  l.hits ??= new Map();
  const last = l.hits.get(id) ?? 0;
  if (now - last < ms) return false;
  l.hits.set(id, now);
  return true;
}

function collideWithEntities(ctx: GameContext, car: CarEntity): void {
  const s = car.state;
  const l = L(car);
  const { hl, hw } = carExtents(s.kind);
  const c = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  const attacker = s.mode === CarMode.Driven ? s.driver : 0;

  for (const e of ctx.world.query(s.x, s.y, 8)) {
    if (e === car) continue;
    if (e.def === Car) {
      const other = e as CarEntity;
      const dx = s.x - other.x;
      const dy = s.y - other.y;
      const d = Math.hypot(dx, dy);
      const minD = hw + carExtents(other.state.kind).hw + 1;
      if (d >= minD || d < 0.01) continue;
      const nxn = dx / d;
      const nyn = dy / d;
      const ovx = Math.cos(other.render.angle) * other.state.speed;
      const ovy = Math.sin(other.render.angle) * other.state.speed;
      const closing = (l.vx! - ovx) * -nxn + (l.vy! - ovy) * -nyn;
      const push = (minD - d) * 0.5;
      if (!carBlocked(ctx.city, s.x + nxn * push, s.y + nyn * push, s.angle, s.kind)) {
        s.x += nxn * push;
        s.y += nyn * push;
      }
      if (closing > 0) {
        l.vx! += nxn * closing * 0.7;
        l.vy! += nyn * closing * 0.7;
      }
      if (closing > 12 && cooldownOk(car, other.id, ctx.now, 700)) {
        const dmg = Math.min(80, Math.round(closing * 0.8));
        s.hp = Math.max(0, s.hp - Math.round(dmg * 0.5));
        ctx.sfx.play('crash', { x: s.x, y: s.y, z: 0.8 });
        ctx.fx.sparks((s.x + other.x) / 2, (s.y + other.y) / 2, 0.7);
        ctx.world.send(
          Damage,
          { target: other.id, amount: dmg, attacker, cause: DamageCause.Vehicle, kx: -nxn * closing * 0.5, ky: -nyn * closing * 0.5, head: false },
          { to: 'owner', entity: other },
        );
      }
      continue;
    }

    const isPed = e.def === Ped;
    const isPlayer = e.def === Player;
    if (!isPed && !isPlayer) continue;
    if (isPlayer) {
      const p = e as PlayerEntity;
      if (p.state.car !== 0 || p.state.hp === 0 || p.id === s.driver || p.render.z > 1.2) continue;
    } else if ((e.state as { mode: number }).mode === PedMode.Dead) {
      continue;
    }
    const rx = (e.x - s.x) * c + (e.y - s.y) * sn;
    const ry = -(e.x - s.x) * sn + (e.y - s.y) * c;
    if (Math.abs(rx) > hl + 0.4 || Math.abs(ry) > hw + 0.4) continue;
    const sp = Math.abs(s.speed);
    if (sp > 6 && cooldownOk(car, e.id, ctx.now, 700)) {
      ctx.world.send(
        Damage,
        { target: e.id, amount: Math.min(255, Math.round(sp * 4.5)), attacker, cause: DamageCause.Vehicle, kx: l.vx! * 0.8, ky: l.vy! * 0.8, head: false },
        { to: 'owner', entity: e },
      );
      ctx.sfx.play('hit', { x: e.x, y: e.y, z: 1 });
      l.vx! *= 0.85;
      l.vy! *= 0.85;
    }
  }
}

export function wreckCar(ctx: GameContext, car: CarEntity): void {
  const s = car.state;
  const l = L(car);
  s.mode = CarMode.Wrecked;
  s.siren = false;
  s.speed = 0;
  l.vx = l.vy = 0;
  l.wreckedAt = ctx.now;
  ctx.world.send(Explosion, { x: s.x, y: s.y }, { to: 'near', x: s.x, y: s.y, radius: 400 });
  for (const e of ctx.world.query(s.x, s.y, 11)) {
    if (e === car) continue;
    const alive =
      e.def === Car
        ? (e.state as { mode: number }).mode !== CarMode.Wrecked
        : e.def === Ped
          ? (e.state as { mode: number }).mode !== PedMode.Dead
          : e.def === Player && (e.state as { hp: number }).hp > 0;
    if (!alive) continue;
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const d = Math.max(0.1, Math.hypot(dx, dy));
    ctx.world.send(
      Damage,
      {
        target: e.id,
        amount: e.def === Car ? 45 : Math.round(150 * Math.min(1, 1.4 - d / 11)),
        attacker: l.lastAttacker ?? 0,
        cause: DamageCause.Explosion,
        kx: (dx / d) * 28,
        ky: (dy / d) * 28,
        head: false,
      },
      { to: 'owner', entity: e },
    );
  }
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export function updateOwnedCars(ctx: GameContext, dt: number): void {
  const { world } = ctx;
  for (const car of world.all(Car)) {
    if (!car.mine) continue;
    const s = car.state;
    const l = ensureVelocity(car);
    if (s.hp <= 0 && s.mode !== CarMode.Wrecked) wreckCar(ctx, car);

    switch (s.mode) {
      case CarMode.Driven: {
        const me = ctx.me;
        if (!me || s.driver !== me.id || me.state.car !== car.id) {
          s.mode = CarMode.Abandoned;
          s.driver = 0;
          world.release(car);
        }
        break; // the player controller drives it
      }
      case CarMode.Traffic:
        trafficAI(ctx, car, dt);
        break;
      case CarMode.Chase:
        chaseAI(ctx, car, dt);
        break;
      case CarMode.Parked:
        l.vx = l.vy = 0;
        s.speed = 0;
        break;
      case CarMode.Abandoned:
      case CarMode.Wrecked: {
        const decay = Math.max(0, 1 - 2.5 * dt);
        l.vx! *= decay;
        l.vy! *= decay;
        if (Math.abs(l.vx!) + Math.abs(l.vy!) > 0.2) moveCar(ctx, car, dt);
        else s.speed = 0;
        if (s.mode === CarMode.Wrecked) {
          l.wreckedAt ??= ctx.now;
          if (ctx.now - l.wreckedAt > 18000 && !car.held) world.despawn(car);
        }
        break;
      }
    }
  }
}

/** Free distance ahead of the car (<= range). */
function clearanceAhead(ctx: GameContext, car: CarEntity, range: number): number {
  const s = car.state;
  const c = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  let free = range;
  for (const e of ctx.world.query(s.x + c * range * 0.5, s.y + sn * range * 0.5, range * 0.5 + 3)) {
    if (e === car) continue;
    if (e.def === Ped && (e.state as { mode: number }).mode === PedMode.Dead) continue;
    if (e.def === Player && ((e.state as { car: number }).car !== 0 || (e.state as { hp: number }).hp === 0)) continue;
    if (e.def !== Car && e.def !== Ped && e.def !== Player) continue;
    const rx = (e.x - s.x) * c + (e.y - s.y) * sn;
    const ry = -(e.x - s.x) * sn + (e.y - s.y) * c;
    if (rx > 0 && Math.abs(ry) < (e.def === Car ? 2.2 : 1.4)) free = Math.min(free, rx);
  }
  return free;
}

function steerTowards(car: CarEntity, targetAngle: number, rate: number, dt: number): void {
  const d = angleDiff(car.state.angle, targetAngle);
  car.state.angle += clamp(d, -rate * dt, rate * dt);
}

function trafficAI(ctx: GameContext, car: CarEntity, dt: number): void {
  const { city } = ctx;
  const s = car.state;
  const l = L(car);
  const forwardSign = s.dir === 0 || s.dir === 1 ? 1 : -1;
  const cross = city.crossRoads(s.dir);
  const roads = city.roadsFor(s.dir);
  if (s.ri >= roads.length || s.ni >= cross.length) {
    s.mode = CarMode.Abandoned;
    return;
  }
  const along = s.dir % 2 === 0 ? s.x : s.y;
  const center = (cross[s.ni] + 2) * TILE;
  const toCenter = (center - along) * forwardSign;

  if (s.nd === 255 && toCenter < 24) {
    const exits = city.exits(s.dir, s.ri, s.ni);
    if (exits.length === 0) {
      s.mode = CarMode.Abandoned;
      return;
    }
    const straight = exits.includes(s.dir);
    s.nd = straight && Math.random() < 0.55 ? s.dir : exits[Math.floor(Math.random() * exits.length)];
  }

  let slowForTurn = false;
  if (s.nd !== 255 && s.nd !== s.dir) {
    const turnAt = city.laneCoord(s.nd, s.ni);
    const toTurn = (turnAt - along) * forwardSign;
    slowForTurn = toTurn < 8.5;
    if (toTurn <= 0.6) {
      const oldRi = s.ri;
      s.ri = s.ni;
      s.ni = s.nd === 0 || s.nd === 1 ? oldRi + 1 : oldRi - 1;
      s.dir = s.nd;
      s.nd = 255;
    }
  } else if (s.nd === s.dir && toCenter < -2.5 * TILE) {
    s.ni += forwardSign;
    s.nd = 255;
  }

  const lane = city.laneCoord(s.dir, s.ri);
  const look = 4.5;
  const tx = s.dir % 2 === 0 ? s.x + DIR_X[s.dir] * look : lane;
  const ty = s.dir % 2 === 0 ? lane : s.y + DIR_Y[s.dir] * look;
  steerTowards(car, Math.atan2(ty - s.y, tx - s.x), 3.2, dt);

  let target = s.kind === CarKind.Sport ? 16 : 13;
  if (slowForTurn) target = 6.5;
  const pushing = ctx.now < (l.pushUntil ?? 0);
  if (!pushing) {
    const free = clearanceAhead(ctx, car, 11);
    if (free < 11) target = Math.min(target, Math.max(0, (free - 4.5) * 3));
  }
  if (target < 0.5 && Math.abs(s.speed) < 1) {
    l.stuck = (l.stuck ?? 0) + dt;
    if (l.stuck > 2.5 && ctx.now > (l.nextHonk ?? 0)) {
      l.nextHonk = ctx.now + 4000 + Math.random() * 4000;
      ctx.world.send(Horn, { car: car.id }, { to: 'near', x: s.x, y: s.y, radius: 120 });
    }
    if (l.stuck > 5) {
      l.pushUntil = ctx.now + 1500;
      l.stuck = 0;
    }
  } else {
    l.stuck = 0;
  }

  const speed = s.speed + clamp(target - s.speed, -38 * dt, 13 * dt);
  l.vx = Math.cos(s.angle) * speed;
  l.vy = Math.sin(s.angle) * speed;
  moveCar(ctx, car, dt);
}

function chaseAI(ctx: GameContext, car: CarEntity, dt: number): void {
  const s = car.state;
  const l = L(car);
  const target = ctx.world.getAs(Player, s.target);
  if (!target || target.state.wanted === 0 || target.state.hp === 0) {
    s.mode = CarMode.Abandoned;
    s.siren = false;
    s.target = 0;
    return;
  }
  s.siren = true;
  const dx = target.x - s.x;
  const dy = target.y - s.y;
  const dist = Math.hypot(dx, dy);
  let desired = Math.atan2(dy, dx);

  // simple obstacle avoidance: if the way ahead is walled off, commit to the clearer side for a moment
  if (ctx.now < (l.avoidUntil ?? 0)) {
    desired = s.angle + (l.avoid ?? 0);
  } else if (ctx.city.raycast(s.x, s.y, desired, 8.5) < 8.5) {
    const left = ctx.city.raycast(s.x, s.y, s.angle - 0.8, 15);
    const right = ctx.city.raycast(s.x, s.y, s.angle + 0.8, 15);
    l.avoid = left > right ? -0.9 : 0.9;
    l.avoidUntil = ctx.now + 600;
    desired = s.angle + l.avoid;
  }
  steerTowards(car, desired, 3.0, dt);

  // Ram suspects who are driving; pull up next to one on foot (or a stopped car) and get out.
  const onFoot = target.state.car === 0;
  const suspectCar = onFoot ? undefined : ctx.world.getAs(Car, target.state.car);
  const pullOver = dist < 21 && (onFoot || Math.abs(suspectCar?.state.speed ?? 0) < 3.8);
  let want = dist < 13 ? 24 : 31;
  const facing = Math.abs(angleDiff(s.angle, Math.atan2(dy, dx)));
  if (facing > 1.4 && dist < 28) want = -11; // back up and re-approach
  if (pullOver) want = 0;
  const speed = s.speed + clamp(want - s.speed, -45 * dt, 20 * dt);
  const before = Math.hypot(l.vx!, l.vy!);
  l.vx = Math.cos(s.angle) * speed;
  l.vy = Math.sin(s.angle) * speed;
  moveCar(ctx, car, dt);
  if (before > 4.7 && Math.abs(s.speed) < 0.5) {
    l.avoid = Math.random() < 0.5 ? -1.2 : 1.2;
    l.avoidUntil = ctx.now + 800;
  }

  // stuck behind buildings for a while: continue on foot
  l.stuck = dist < 56 && Math.abs(s.speed) < 0.75 ? (l.stuck ?? 0) + dt : 0;
  if ((pullOver && Math.abs(s.speed) < 3.3) || l.stuck > 3) deployOfficers(ctx, car);
}
