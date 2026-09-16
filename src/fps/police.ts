import type { NetEntity } from '@engine/index';
import { TILE } from './city';
import { direction, type CarEntity, type GameContext, type PedEntity, type PlayerEntity } from './context';
import { Busted, Car, CarKind, CarMode, Ped, PedMode, Player } from './defs';
import { PED_RADIUS, moveCircle, retarget } from './peds';
import { COP_SKINS } from './specs';
import { fireBullet } from './weapons';

const COP_SPEED = 5.2; // players run at 7.2, so you can outrun officers on foot
const COP_HP = 60;
const GUN_RANGE = 60;
const ENGAGE_RANGE = 42;
/** Within this distance of a suspect on foot, officers holster and go for the arrest. */
const GRAPPLE_RANGE = 8;
export const CUFF_RANGE = 1.3;
const CUFF_MS = 1400;
const GIVE_UP_RANGE = 150;
const SHOT_MEMORY_MS = 5000;

interface CopLocal {
  nextShot?: number;
  cuff?: number;
  detour?: number;
  detourUntil?: number;
  lastTX?: number;
  lastTY?: number;
  strafe?: number;
  strafeUntil?: number;
  nextScan?: number;
}

/** Set on a player entity's `local` by whichever peer sees their Shot actions. */
export function firedRecently(ctx: GameContext, p: PlayerEntity): boolean {
  return ctx.now - ((p.local.lastShot as number | undefined) ?? -Infinity) < SHOT_MEMORY_MS;
}

/** Officers shoot suspects with 2+ stars, or anyone who has just been firing a gun. */
export function copsWillShoot(ctx: GameContext, p: PlayerEntity): boolean {
  return p.state.wanted >= 2 || firedRecently(ctx, p);
}

/** Police on duty: officers on foot and police cars not driven by a player. */
export function isPoliceUnit(e: NetEntity): boolean {
  if (e.def === Ped) {
    const s = e.state as { cop: boolean; mode: number };
    return s.cop && s.mode !== PedMode.Dead;
  }
  if (e.def === Car) {
    const s = e.state as { kind: number; mode: number };
    return s.kind === CarKind.Police && s.mode !== CarMode.Wrecked && s.mode !== CarMode.Driven;
  }
  return false;
}

export function spawnOfficer(ctx: GameContext, x: number, y: number, target: number): PedEntity {
  const cop = ctx.world.spawn(Ped, {
    x,
    y,
    skin: Math.floor(Math.random() * COP_SKINS),
    hp: COP_HP,
    cop: true,
    mode: target ? PedMode.Attack : PedMode.Walk,
    target,
    tx: Math.floor(x / TILE),
    ty: Math.floor(y / TILE),
  });
  // a moment to draw before the first shot
  (cop.local as CopLocal).nextShot = ctx.now + 600 + Math.random() * 400;
  return cop;
}

/** The police car stops and two officers get out to pursue on foot. */
export function deployOfficers(ctx: GameContext, car: CarEntity): void {
  const s = car.state;
  const c = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  let spawned = 0;
  for (const side of [-1, 1]) {
    const x = s.x - sn * side * 2.4;
    const y = s.y + c * side * 2.4;
    if (ctx.city.circleBlocked(x, y, PED_RADIUS)) continue;
    spawnOfficer(ctx, x, y, s.target);
    spawned++;
  }
  if (spawned === 0) {
    const x = s.x - c * 3.5;
    const y = s.y - sn * 3.5;
    if (!ctx.city.circleBlocked(x, y, PED_RADIUS)) spawnOfficer(ctx, x, y, s.target);
  }
  s.mode = CarMode.Abandoned; // lights stay on
  s.target = 0;
  ctx.sfx.play('door', { x: s.x, y: s.y, z: 1 });
}

export function updateOwnedCops(ctx: GameContext, dt: number): void {
  for (const cop of ctx.world.all(Ped)) {
    if (!cop.mine || !cop.state.cop) continue;
    if (cop.state.mode === PedMode.Attack) copAI(ctx, cop, dt);
    else if (cop.state.mode === PedMode.Walk) patrol(ctx, cop);
  }
}

/** Off-duty officers (walking the beat) pick up any wanted player they can see. */
function patrol(ctx: GameContext, cop: PedEntity): void {
  const l = cop.local as CopLocal;
  if (ctx.now < (l.nextScan ?? 0)) return;
  l.nextScan = ctx.now + 500;
  const s = cop.state;
  for (const p of ctx.world.query(s.x, s.y, 55, Player)) {
    if (p.state.hp === 0 || (p.state.wanted === 0 && !firedRecently(ctx, p))) continue;
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (ctx.city.raycast(s.x, s.y, Math.atan2(p.y - s.y, p.x - s.x), d) < d - 1.3) continue;
    s.mode = PedMode.Attack;
    s.target = p.id;
    l.nextShot = ctx.now + 700;
    return;
  }
}

function standDown(ctx: GameContext, cop: PedEntity): void {
  const s = cop.state;
  s.mode = PedMode.Walk;
  s.target = 0;
  (cop.local as CopLocal).cuff = 0;
  retarget(ctx.city, cop);
}

function copAI(ctx: GameContext, cop: PedEntity, dt: number): void {
  const s = cop.state;
  const l = cop.local as CopLocal;
  const suspect = ctx.world.getAs(Player, s.target);
  if (!suspect || suspect.state.hp === 0 || (suspect.state.wanted === 0 && !firedRecently(ctx, suspect))) {
    standDown(ctx, cop);
    return;
  }

  const inCar = suspect.state.car !== 0;
  const aim: NetEntity = (inCar && ctx.world.get(suspect.state.car)) || suspect;
  const tx = aim.x;
  const ty = aim.y;
  const dist = Math.hypot(tx - s.x, ty - s.y);
  if (dist > GIVE_UP_RANGE) {
    standDown(ctx, cop);
    return;
  }
  const bearing = Math.atan2(ty - s.y, tx - s.x);
  const suspectSpeed = Math.hypot(tx - (l.lastTX ?? tx), ty - (l.lastTY ?? ty)) / Math.max(dt, 0.001);
  l.lastTX = tx;
  l.lastTY = ty;
  const shooting = copsWillShoot(ctx, suspect);

  // Arrest: run a suspect on foot down and hold on to them for a moment.
  // Someone who is actively firing gets shot, however close they are.
  if (!inCar && (!shooting || (dist < GRAPPLE_RANGE && !firedRecently(ctx, suspect)))) {
    if (dist < CUFF_RANGE) {
      s.angle = bearing;
      l.cuff = (l.cuff ?? 0) + dt * 1000;
      if (l.cuff >= CUFF_MS) {
        l.cuff = 0;
        ctx.world.command(Busted, { target: suspect.id, cop: cop.id });
      }
      return;
    }
    l.cuff = Math.max(0, (l.cuff ?? 0) - dt * 2000);
    runTowards(ctx, cop, tx, ty, dist < 20 ? COP_SPEED * 1.15 : COP_SPEED, dt);
    return;
  }
  l.cuff = 0;

  const los = dist < GUN_RANGE && ctx.city.raycast(s.x, s.y, bearing, dist) >= dist - 1.3;
  if (!shooting) {
    // wanted, but not dangerous yet, and sitting in a car: surround it
    if (dist > 6.5) runTowards(ctx, cop, tx, ty, COP_SPEED, dt);
    else s.angle = bearing;
    return;
  }
  if (!los || dist > ENGAGE_RANGE) {
    runTowards(ctx, cop, tx, ty, COP_SPEED, dt);
    return;
  }

  // Firefight: face the suspect, sidestep now and then, shoot with spread that grows with their speed.
  s.angle = bearing;
  if (ctx.now > (l.strafeUntil ?? 0)) {
    l.strafe = Math.random() < 0.35 ? 0 : Math.random() < 0.5 ? -1 : 1;
    l.strafeUntil = ctx.now + 900 + Math.random() * 900;
  }
  if (l.strafe) {
    const step = 2 * dt * l.strafe;
    moveCircle(ctx.city, s, -Math.sin(bearing) * step, Math.cos(bearing) * step, PED_RADIUS);
  }
  if (ctx.now >= (l.nextShot ?? 0)) {
    l.nextShot = ctx.now + 650 + Math.random() * 450;
    const spread = 0.025 + (Math.min(suspectSpeed, 10) / 10) * 0.05;
    const o = { x: s.x + Math.cos(bearing) * 0.5, y: s.y + Math.sin(bearing) * 0.5, z: 1.42 };
    const aimZ = inCar ? 0.95 : suspect.render.z + 1.25;
    const yaw = bearing + (Math.random() - 0.5) * 2 * spread;
    const pitch = Math.atan2(aimZ - o.z, Math.max(0.1, dist - 0.5)) + (Math.random() - 0.5) * spread;
    fireBullet(ctx, cop, o, direction(yaw, pitch), {
      range: GUN_RANGE,
      damage: (e, head) => (isPoliceUnit(e) ? 0 : e.def === Player ? (head ? 16 : 7) : e.def === Car ? 5 : 12),
    });
  }
}

function runTowards(ctx: GameContext, cop: PedEntity, tx: number, ty: number, speed: number, dt: number): void {
  const s = cop.state;
  const l = cop.local as CopLocal;
  let a = Math.atan2(ty - s.y, tx - s.x);
  const detouring = ctx.now < (l.detourUntil ?? 0);
  if (detouring) a += l.detour ?? 0;
  const x0 = s.x;
  const y0 = s.y;
  moveCircle(ctx.city, s, Math.cos(a) * speed * dt, Math.sin(a) * speed * dt, PED_RADIUS);
  s.angle = a;
  if (!detouring && Math.hypot(s.x - x0, s.y - y0) < speed * dt * 0.3) {
    // walled off: go round on the side with more room
    const left = ctx.city.raycast(s.x, s.y, a - Math.PI / 2, 18);
    const right = ctx.city.raycast(s.x, s.y, a + Math.PI / 2, 18);
    l.detour = left > right ? -1.2 : 1.2;
    l.detourUntil = ctx.now + 700;
  }
}
