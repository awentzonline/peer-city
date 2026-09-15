import { animalSpec } from './bodies';
import { isNight } from './clock';
import type { AnimalEntity, SurvivorEntity, WildsContext } from './context';
import { Animal, AnimalKind, AnimalMode, Damage, Survivor } from './defs';
import { WARM_RADIUS, fireNear } from './homestead';
import { Ground } from './land';

interface AnimalLocal {
  deadAt?: number;
  /** Keep running until then, from (fx, fy). */
  fleeUntil?: number;
  fx?: number;
  fy?: number;
  /** Standing still, grazing, until then. */
  pauseUntil?: number;
  nextBite?: number;
  /** Extra turn while cornered. */
  veer?: number;
}

const CARCASS_MS = 90000;
const BITE_RANGE = 1.5;
const BITE_MS = 1100;
const BITE = 10;
/** Wolves keep this far from a lit fire. */
const FIRE_FEAR = WARM_RADIUS + 1;

/** The nearest living survivor within `r`, and how far. */
function nearestSurvivor(ctx: WildsContext, a: AnimalEntity, r: number, accept: (s: SurvivorEntity) => boolean = () => true): [SurvivorEntity | undefined, number] {
  let best: SurvivorEntity | undefined;
  let bestD = r;
  for (const s of ctx.world.query(a.state.x, a.state.y, r, Survivor)) {
    if (s.render.hp <= 0 || !accept(s)) continue;
    const d = Math.hypot(s.x - a.state.x, s.y - a.state.y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return [best, bestD];
}

/**
 * Animals this peer owns: deer and rabbits graze and bolt from anyone who comes near; wolves come out at
 * night and hunt survivors who aren't by a fire. Like Peer City's pedestrians they're migratable, so when
 * a peer leaves, the next nearest takes over their herd, and the state that matters (mode, target, where
 * they're headed) is in the schema.
 */
export function updateOwnedAnimals(ctx: WildsContext, dt: number): void {
  const { world, now } = ctx;
  for (const a of world.all(Animal)) {
    if (!a.mine) continue;
    const s = a.state;
    const l = a.local as AnimalLocal;
    const spec = animalSpec(s.kind);

    if (s.mode === AnimalMode.Dead) {
      l.deadAt ??= now;
      if (now - l.deadAt > CARCASS_MS || (s.meat === 0 && now - l.deadAt > 4000)) world.despawn(a);
      continue;
    }

    if (s.kind === AnimalKind.Wolf && (isNight(ctx.day) || s.mode === AnimalMode.Hunt)) {
      hunt(ctx, a, dt);
      continue;
    }

    const [threat, d] = nearestSurvivor(ctx, a, spec.alert);
    if (threat && d < spec.alert) {
      s.mode = AnimalMode.Flee;
      l.fleeUntil = now + 3000;
      l.fx = threat.x;
      l.fy = threat.y;
    }
    if (s.mode === AnimalMode.Flee) {
      if (now > (l.fleeUntil ?? 0)) {
        s.mode = AnimalMode.Graze;
        wander(ctx, a);
      } else {
        runFrom(ctx, a, l.fx ?? s.x, l.fy ?? s.y, spec.run, dt);
      }
      continue;
    }
    graze(ctx, a, dt);
  }
}

function graze(ctx: WildsContext, a: AnimalEntity, dt: number): void {
  const s = a.state;
  const l = a.local as AnimalLocal;
  const spec = animalSpec(s.kind);
  if (ctx.now < (l.pauseUntil ?? 0)) return;
  const dx = s.tx - s.x;
  const dy = s.ty - s.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.6 || (s.tx === 0 && s.ty === 0)) {
    l.pauseUntil = ctx.now + 1500 + Math.random() * 5000;
    wander(ctx, a);
    return;
  }
  const step = Math.min(d, spec.walk * dt);
  if (ctx.land.move(s, (dx / d) * step, (dy / d) * step, spec.radius)) wander(ctx, a);
  turnTo(a, Math.atan2(dy, dx), dt);
}

/** Pick somewhere nearby to amble to. */
function wander(ctx: WildsContext, a: AnimalEntity): void {
  const s = a.state;
  const spot = ctx.land.randomOpen(s.x, s.y, 4, 16, (g) => g !== Ground.Water);
  s.tx = spot?.x ?? s.x;
  s.ty = spot?.y ?? s.y;
}

function runFrom(ctx: WildsContext, a: AnimalEntity, fx: number, fy: number, speed: number, dt: number): void {
  const s = a.state;
  const l = a.local as AnimalLocal;
  const spec = animalSpec(s.kind);
  const angle = Math.atan2(s.y - fy, s.x - fx) + (l.veer ?? 0) + Math.sin(ctx.now / 300 + (a.id % 13)) * 0.3;
  if (ctx.land.move(s, Math.cos(angle) * speed * dt, Math.sin(angle) * speed * dt, spec.radius)) l.veer = (l.veer ?? 0) + 1.2 * dt * 4;
  else l.veer = (l.veer ?? 0) * Math.exp(-dt);
  turnTo(a, angle, dt);
}

function runTo(ctx: WildsContext, a: AnimalEntity, tx: number, ty: number, speed: number, dt: number): void {
  const s = a.state;
  const spec = animalSpec(s.kind);
  const angle = Math.atan2(ty - s.y, tx - s.x);
  if (ctx.land.move(s, Math.cos(angle) * speed * dt, Math.sin(angle) * speed * dt, spec.radius)) {
    // blocked: try sliding round it
    const side = angle + ((a.id & 1) * 2 - 1) * 1.1;
    ctx.land.move(s, Math.cos(side) * speed * dt, Math.sin(side) * speed * dt, spec.radius);
  }
  turnTo(a, angle, dt);
}

function turnTo(a: AnimalEntity, angle: number, dt: number): void {
  const s = a.state;
  let d = (angle - s.angle) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  s.angle += d * Math.min(1, dt * 8);
}

/** A wolf after survivors: circle round fires, close in, bite. */
function hunt(ctx: WildsContext, a: AnimalEntity, dt: number): void {
  const { world, now } = ctx;
  const s = a.state;
  const l = a.local as AnimalLocal;
  const spec = animalSpec(s.kind);

  const fire = fireNear(ctx, s.x, s.y, FIRE_FEAR);
  if (fire || s.hp < 15) {
    s.mode = AnimalMode.Flee;
    runFrom(ctx, a, fire?.x ?? l.fx ?? s.x - 1, fire?.y ?? l.fy ?? s.y, spec.run, dt);
    if (!fire && s.hp >= 15) s.mode = AnimalMode.Graze;
    return;
  }

  let target = s.target ? world.getAs(Survivor, s.target) : undefined;
  if (!target || target.render.hp <= 0 || fireNear(ctx, target.x, target.y, WARM_RADIUS) || Math.hypot(target.x - s.x, target.y - s.y) > spec.alert * 1.5) {
    [target] = nearestSurvivor(ctx, a, spec.alert, (sv) => !fireNear(ctx, sv.x, sv.y, WARM_RADIUS));
    s.target = target?.id ?? 0;
  }
  if (!target) {
    s.mode = AnimalMode.Graze;
    graze(ctx, a, dt);
    return;
  }

  s.mode = AnimalMode.Hunt;
  const d = Math.hypot(target.x - s.x, target.y - s.y);
  if (d > BITE_RANGE * 0.8) runTo(ctx, a, target.x, target.y, d < 6 ? spec.run : spec.run * 0.8, dt);
  else turnTo(a, Math.atan2(target.y - s.y, target.x - s.x), dt);
  if (d < BITE_RANGE && now >= (l.nextBite ?? 0)) {
    l.nextBite = now + BITE_MS;
    const k = 1 / Math.max(d, 0.1);
    world.send(Damage, { target: target.id, amount: BITE, attacker: a.id, kx: (target.x - s.x) * k * 3, ky: (target.y - s.y) * k * 3 }, { to: 'owner', entity: target });
    ctx.sfx.play('bite', { x: s.x, y: s.y, z: ctx.land.heightAt(s.x, s.y) + 0.6 });
  }
}
