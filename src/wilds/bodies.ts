import type { NetEntity } from '@engine/index';
import type { AnimalEntity, SurvivorEntity, Vec3, WildsContext } from './context';
import { Animal, AnimalKind, AnimalMode, Survivor } from './defs';

export interface AnimalSpec {
  name: string;
  hp: number;
  /** Hit and collision radius, and height, meters. */
  radius: number;
  height: number;
  /** Portions of meat on a carcass. */
  meat: number;
  walk: number;
  run: number;
  /** How near a survivor comes before it notices. */
  alert: number;
}

export const ANIMALS: Record<AnimalKind, AnimalSpec> = {
  [AnimalKind.Deer]: { name: 'deer', hp: 70, radius: 0.45, height: 1.5, meat: 3, walk: 1.3, run: 9, alert: 18 },
  [AnimalKind.Rabbit]: { name: 'rabbit', hp: 12, radius: 0.25, height: 0.45, meat: 1, walk: 1.2, run: 7, alert: 9 },
  [AnimalKind.Wolf]: { name: 'wolf', hp: 50, radius: 0.4, height: 0.95, meat: 2, walk: 2, run: 7.6, alert: 34 },
};

export function animalSpec(kind: number): AnimalSpec {
  return ANIMALS[kind as AnimalKind] ?? ANIMALS[AnimalKind.Deer];
}

export const SURVIVOR_RADIUS = 0.4;

export interface BodyHit {
  entity: AnimalEntity | SurvivorEntity;
  t: number;
}

/** Entry distance of a ray into an upright cylinder, or -1. */
function rayCylinder(o: Vec3, d: Vec3, cx: number, cy: number, r: number, z0: number, z1: number, max: number): number {
  const fx = o.x - cx;
  const fy = o.y - cy;
  let tIn = 0;
  let tOut = max;
  const a = d.x * d.x + d.y * d.y;
  if (a < 1e-9) {
    if (fx * fx + fy * fy > r * r) return -1;
  } else {
    const b = fx * d.x + fy * d.y;
    const disc = b * b - a * (fx * fx + fy * fy - r * r);
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    tIn = Math.max(tIn, (-b - sq) / a);
    tOut = Math.min(tOut, (-b + sq) / a);
  }
  if (Math.abs(d.z) < 1e-9) {
    if (o.z < z0 || o.z > z1) return -1;
  } else {
    let t0 = (z0 - o.z) / d.z;
    let t1 = (z1 - o.z) / d.z;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tIn = Math.max(tIn, t0);
    tOut = Math.min(tOut, t1);
  }
  return tIn <= tOut ? tIn : -1;
}

/** Whether an entity is a living animal or survivor that can be hit. */
export function hittable(e: NetEntity<any>): e is AnimalEntity | SurvivorEntity {
  if (e.is(Animal)) return e.render.mode !== AnimalMode.Dead;
  if (e.is(Survivor)) return e.render.hp > 0;
  return false;
}

/** The first living animal or survivor (other than `ignore`) that a ray passes through within `max` meters. `d` must be normalized. */
export function sweepBodies(ctx: WildsContext, o: Vec3, d: Vec3, max: number, ignore = 0, dead = false): BodyHit | null {
  const { land, world } = ctx;
  let best: BodyHit | null = null;
  let bestT = max;
  const mx = o.x + (d.x * max) / 2;
  const my = o.y + (d.y * max) / 2;
  for (const e of world.query(mx, my, max / 2 + 1.5)) {
    if (e.id === ignore) continue;
    let r: number;
    let z0: number;
    let z1: number;
    if (e.is(Animal)) {
      if (!dead && e.render.mode === AnimalMode.Dead) continue;
      const spec = animalSpec(e.render.kind);
      r = spec.radius;
      z0 = land.heightAt(e.x, e.y);
      z1 = z0 + (e.render.mode === AnimalMode.Dead ? spec.radius : spec.height);
    } else if (e.is(Survivor)) {
      if (e.render.hp <= 0) continue;
      r = SURVIVOR_RADIUS;
      z0 = land.heightAt(e.x, e.y) + e.render.z;
      z1 = z0 + e.render.head + 0.2;
    } else {
      continue;
    }
    const t = rayCylinder(o, d, e.x, e.y, r, z0, z1, bestT);
    if (t < 0 || t >= bestT) continue;
    bestT = t;
    best = { entity: e as AnimalEntity | SurvivorEntity, t };
  }
  return best;
}
