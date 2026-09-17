import { defineLocal } from '@engine/index';
import { angleDiff, type HauntContext, type MonsterEntity, type SurvivorEntity } from './context';
import { Feed, Hurt, Monster, MonsterKind, MonsterMode, Noise, Phase, Sound, Survivor, SurvivorMode } from './defs';
import { PEDESTAL, SANCTUARY, type Manor } from './manor';

export interface MonsterSpec {
  name: string;
  /** Dread to summon one. */
  cost: number;
  hp: number;
  /** m/s. */
  speed: number;
  radius: number;
  /** Where its middle is above the ground, for flashlights to find. */
  height: number;
  /** How close it strikes from, how hard, and how often. */
  reach: number;
  damage: number;
  cooldownMs: number;
  /** Hit points a second of full beam burns off. */
  burn: number;
  /** Speed while lit. */
  litSpeed: number;
  /** Runs from the light rather than pushing through it, for this long, ms. */
  fleeMs: number;
  /** How far it notices a survivor showing a light or carrying a key; one in the dark only at `darkSense` of that. */
  sense: number;
}

export const MONSTERS: Record<MonsterKind, MonsterSpec> = {
  [MonsterKind.Shade]: { name: 'shade', cost: 20, hp: 30, speed: 3.3, radius: 0.35, height: 1.3, reach: 1.4, damage: 1, cooldownMs: 1300, burn: 22, litSpeed: 0.35, fleeMs: 0, sense: 15 },
  [MonsterKind.Crawler]: { name: 'crawler', cost: 30, hp: 18, speed: 5.6, radius: 0.35, height: 0.45, reach: 1.2, damage: 1, cooldownMs: 900, burn: 12, litSpeed: 1, fleeMs: 1400, sense: 18 },
  [MonsterKind.Brute]: { name: 'brute', cost: 90, hp: 140, speed: 2.7, radius: 0.48, height: 1.5, reach: 1.7, damage: 2, cooldownMs: 1900, burn: 9, litSpeed: 0.7, fleeMs: 0, sense: 14 },
};

/** A survivor in the dark is only noticed this much as far off. Anyone within `CLOSE` is noticed however dark it is. */
const DARK_SENSE = 0.5;
const CLOSE = 3;
/** How long a hunter goes on after losing sight of its quarry, ms. */
const GIVE_UP_MS = 7000;
/** How long a dissolving monster lingers, ms. */
const DISSOLVE_MS = 1400;
/** How far a survivor can see to rule out summoning there, m. */
const SIGHT = 22;
/** Nothing can be summoned this close to a survivor, m. */
const TOO_CLOSE = 7;

interface MonsterLocal {
  nextLook: number;
  nextPath: number;
  nextStrike: number;
  waypoint: { x: number; y: number } | null;
  /** Last saw its quarry at, ms. */
  sawAt: number;
  /** Wandering: stand about until then. */
  restUntil: number;
  /** Light: how strong it was, until when it lasts, and who's shining it (for running from). */
  litLevel: number;
  litUntil: number;
  fleeUntil: number;
  fx: number;
  fy: number;
  deadAt: number;
  /** Sent after someone by the Haunt: it knows where they are until then, seen or not, ms. */
  chaseUntil: number;
}

export const MonsterMind = defineLocal<MonsterLocal>(() => ({
  nextLook: 0,
  nextPath: 0,
  nextStrike: 0,
  waypoint: null,
  sawAt: 0,
  restUntil: 0,
  litLevel: 0,
  litUntil: 0,
  fleeUntil: 0,
  fx: 0,
  fy: 0,
  deadAt: 0,
  chaseUntil: 0,
}));

export function isHuntable(s: { mode: SurvivorMode }): boolean {
  return s.mode === SurvivorMode.Alive;
}

/** Whether a survivor shows up in the dark: a light on, a key glowing in hand, or down and crying out. */
export function conspicuous(s: { light: boolean; key: number; mode: SurvivorMode }): boolean {
  return s.light || s.key !== 0 || s.mode === SurvivorMode.Downed;
}

/** How far a monster of this kind notices a survivor from. */
export function noticeRange(spec: MonsterSpec, sv: SurvivorEntity): number {
  return conspicuous(sv.render) ? spec.sense : Math.max(CLOSE, spec.sense * DARK_SENSE);
}

/**
 * Why a monster can't be summoned at (x, y), or null if it can: somewhere open inside the fence, clear of the pedestal,
 * and where no survivor is close by or can see. Everything comes through somewhere nobody's looking.
 */
export function summonRefusal(ctx: HauntContext, x: number, y: number, radius = 0.5): string | null {
  const { manor, world } = ctx;
  if (!manor.inGrounds(x, y)) return 'Only inside the grounds';
  if (manor.solid(Math.floor(x), Math.floor(y))) return "There's something in the way";
  const p = { x, y };
  manor.pushOut(p, radius);
  if (Math.hypot(p.x - x, p.y - y) > 0.45) return 'Too cramped';
  if (Math.hypot(x - PEDESTAL.cx, y - PEDESTAL.cy) < SANCTUARY) return 'The pedestal keeps you back';
  for (const sv of world.all(Survivor)) {
    const s = sv.render;
    if (s.mode === SurvivorMode.Dead || s.mode === SurvivorMode.Escaped) continue;
    const d = Math.hypot(sv.x - x, sv.y - y);
    if (d < TOO_CLOSE) return 'Too close to a survivor';
    if (d < SIGHT && manor.sees(sv.x, sv.y, x, y)) return 'A survivor can see there';
  }
  return null;
}

/** Most monsters there can be at once, for this many survivors in the house. */
export function monsterCap(survivors: number): number {
  return Math.min(18, 4 + survivors * 3);
}

/** Summon a monster: the peer that does owns and runs it, and keeps it while it's theirs to command (`haunt`). */
export function summon(ctx: HauntContext, kind: MonsterKind, x: number, y: number, haunt: number, round: number): MonsterEntity {
  const spec = MONSTERS[kind];
  const at = ctx.manor.nearestOpen(x, y);
  const m = ctx.world.spawn(Monster, { x: at.x, y: at.y, kind, hp: spec.hp, mode: MonsterMode.Idle, tx: at.x, ty: at.y, haunt, round, angle: Math.random() * Math.PI * 2 }, { held: haunt !== 0 });
  ctx.world.send(Noise, { kind: Sound.Summon, x: at.x, y: at.y, z: spec.height, a: kind }, { to: 'all' });
  return m;
}

/**
 * Monsters this peer owns. Each notices survivors who show themselves (or come close in the dark), goes after them and
 * strikes, and otherwise goes where the Haunt sent it or wanders. Flashlights burn them (see `burn`): shades are slowed
 * and banished, crawlers run from the light, and brutes shoulder through it. They find their way round the house by
 * the distance fields in `ctx.paths`, and they're gone when the night is.
 */
export function updateOwnedMonsters(ctx: HauntContext, dt: number): void {
  const { world, now } = ctx;
  const round = ctx.round()?.state;
  for (const m of world.owned(Monster)) {
    const s = m.state;
    const l = MonsterMind.of(m);
    if (!round || round.phase !== Phase.Hunt || s.round !== round.round) {
      world.despawn(m);
      continue;
    }
    if (s.mode === MonsterMode.Dead) {
      l.deadAt ||= now;
      s.lit = 0;
      if (now - l.deadAt > DISSOLVE_MS) world.despawn(m);
      continue;
    }
    // a haunt that's gone can't take it back: it's the house's now
    if (s.haunt && !world.get(s.haunt)) {
      s.haunt = 0;
      world.release(m);
    }
    const spec = MONSTERS[s.kind];
    s.lit = now < l.litUntil ? l.litLevel : Math.max(0, s.lit - dt * 4);
    const speed = spec.speed * (s.lit > 0.05 ? spec.litSpeed : 1);

    if (now < l.fleeUntil) {
      const away = Math.atan2(s.y - l.fy, s.x - l.fx) + Math.sin(now / 250 + m.id) * 0.5;
      step(ctx, m, s.x + Math.cos(away) * 3, s.y + Math.sin(away) * 3, speed * 1.1, dt, false);
      continue;
    }

    if (now >= l.nextLook) {
      l.nextLook = now + 220 + Math.random() * 80;
      look(ctx, m);
    }

    switch (s.mode) {
      case MonsterMode.Hunt: {
        const target = world.getAs(Survivor, s.target);
        if (!target || !isHuntable(target.render) || now - l.sawAt > GIVE_UP_MS) {
          s.mode = MonsterMode.Idle;
          s.target = 0;
          break;
        }
        const d = Math.hypot(target.x - s.x, target.y - s.y);
        if (d > spec.reach * 0.8) step(ctx, m, s.tx, s.ty, speed, dt, true);
        else face(m, Math.atan2(target.y - s.y, target.x - s.x), dt);
        if (d < spec.reach && now >= l.nextStrike && ctx.manor.sees(s.x, s.y, target.x, target.y)) strike(ctx, m, target);
        break;
      }
      case MonsterMode.Move:
        if (Math.hypot(s.tx - s.x, s.ty - s.y) < 1.2) s.mode = MonsterMode.Idle;
        else step(ctx, m, s.tx, s.ty, speed, dt, true);
        break;
      default:
        wander(ctx, m, speed * 0.45, dt);
    }
  }
  separate(ctx);
}

/** Look for someone to go after, and keep an eye on who it's after. */
function look(ctx: HauntContext, m: MonsterEntity): void {
  const { world, manor, now } = ctx;
  const s = m.state;
  const l = MonsterMind.of(m);
  const spec = MONSTERS[s.kind];
  if (s.mode === MonsterMode.Hunt) {
    const target = world.getAs(Survivor, s.target);
    const sent = now < l.chaseUntil;
    if (target && isHuntable(target.render) && (sent || (Math.hypot(target.x - s.x, target.y - s.y) < spec.sense * 1.4 && manor.sees(s.x, s.y, target.x, target.y)))) {
      l.sawAt = now;
      s.tx = target.x;
      s.ty = target.y;
      return;
    }
  }
  let best: SurvivorEntity | null = null;
  let bestD = Infinity;
  for (const sv of world.query(s.x, s.y, spec.sense, Survivor) as SurvivorEntity[]) {
    if (!isHuntable(sv.render)) continue;
    const d = Math.hypot(sv.x - s.x, sv.y - s.y);
    if (d >= bestD || d > noticeRange(spec, sv) || !manor.sees(s.x, s.y, sv.x, sv.y)) continue;
    best = sv;
    bestD = d;
  }
  if (best && (s.mode !== MonsterMode.Hunt || best.id !== s.target)) {
    // an order to go after someone else stands until they're lost
    const current = s.mode === MonsterMode.Hunt ? world.getAs(Survivor, s.target) : null;
    if (current && isHuntable(current.render) && now - l.sawAt < GIVE_UP_MS) return;
    s.mode = MonsterMode.Hunt;
    s.target = best.id;
    s.tx = best.x;
    s.ty = best.y;
    l.sawAt = now;
  }
}

/** Head for (tx, ty) at `speed`, round walls. */
function step(ctx: HauntContext, m: MonsterEntity, tx: number, ty: number, speed: number, dt: number, path: boolean): void {
  const { manor, paths, now } = ctx;
  const s = m.state;
  const l = MonsterMind.of(m);
  const spec = MONSTERS[s.kind];
  let gx = tx;
  let gy = ty;
  if (path) {
    if (now >= l.nextPath || !l.waypoint) {
      l.nextPath = now + 250 + Math.random() * 100;
      l.waypoint = paths.next(s.x, s.y, tx, ty, spec.radius, now);
    }
    if (!l.waypoint) return;
    gx = l.waypoint.x;
    gy = l.waypoint.y;
    if (Math.hypot(gx - s.x, gy - s.y) < 0.3) l.nextPath = 0;
  }
  const dx = gx - s.x;
  const dy = gy - s.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) return;
  const k = Math.min(d, speed * dt) / d;
  if (manor.move(s, dx * k, dy * k, spec.radius)) l.nextPath = 0;
  face(m, Math.atan2(dy, dx), dt);
}

function face(m: MonsterEntity, angle: number, dt: number): void {
  const s = m.state;
  s.angle += angleDiff(s.angle, angle) * Math.min(1, dt * 8);
}

/** Drift about the room it's in, stopping now and then. */
function wander(ctx: HauntContext, m: MonsterEntity, speed: number, dt: number): void {
  const s = m.state;
  const l = MonsterMind.of(m);
  if (ctx.now < l.restUntil) return;
  if (Math.hypot(s.tx - s.x, s.ty - s.y) < 0.6) {
    l.restUntil = ctx.now + 1200 + Math.random() * 3500;
    const spot = openNear(ctx.manor, s.x, s.y, 7);
    s.tx = spot.x;
    s.ty = spot.y;
    return;
  }
  step(ctx, m, s.tx, s.ty, speed, dt, true);
}

function openNear(manor: Manor, x: number, y: number, r: number): { x: number; y: number } {
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 2 + Math.random() * r;
    const px = x + Math.cos(a) * d;
    const py = y + Math.sin(a) * d;
    if (manor.inGrounds(px, py) && !manor.solid(Math.floor(px), Math.floor(py)) && manor.sees(x, y, px, py)) return { x: Math.floor(px) + 0.5, y: Math.floor(py) + 0.5 };
  }
  return { x, y };
}

function strike(ctx: HauntContext, m: MonsterEntity, target: SurvivorEntity): void {
  const s = m.state;
  const l = MonsterMind.of(m);
  const spec = MONSTERS[s.kind];
  l.nextStrike = ctx.now + spec.cooldownMs;
  s.strikes = (s.strikes + 1) & 0xff;
  const d = Math.max(0.1, Math.hypot(target.x - s.x, target.y - s.y));
  const k = (spec.damage * 3) / d;
  ctx.world.command(Hurt, { target: target.id, by: m.id, amount: spec.damage, kx: (target.x - s.x) * k, ky: (target.y - s.y) * k });
  ctx.world.send(Noise, { kind: Sound.Strike, x: s.x, y: s.y, z: spec.height, a: s.kind }, { to: 'all' });
}

/** Keep monsters from standing in each other. */
function separate(ctx: HauntContext): void {
  const { world, manor } = ctx;
  for (const m of world.owned(Monster)) {
    const s = m.state;
    if (s.mode === MonsterMode.Dead) continue;
    const r = MONSTERS[s.kind].radius;
    for (const o of world.query(s.x, s.y, 1.2, Monster) as MonsterEntity[]) {
      if (o === m || o.render.mode === MonsterMode.Dead) continue;
      const min = r + MONSTERS[o.render.kind].radius;
      const dx = s.x - o.x;
      const dy = s.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d >= min || d < 1e-4) continue;
      const push = (min - d) * 0.5;
      manor.move(s, (dx / d) * push, (dy / d) * push, r);
    }
  }
}

/**
 * A flashlight's been on a monster this peer owns: `amount` is seconds of full beam since the shiner last said. It burns,
 * slows or scares it off, and banishes it when it's burnt away.
 */
export function burn(ctx: HauntContext, m: MonsterEntity, amount: number, by: SurvivorEntity | undefined): void {
  const s = m.state;
  if (s.mode === MonsterMode.Dead) return;
  const spec = MONSTERS[s.kind];
  const l = MonsterMind.of(m);
  l.litLevel = Math.min(1, Math.max(l.litLevel * 0.5, amount / 0.2));
  l.litUntil = ctx.now + 320;
  s.lit = Math.max(s.lit, l.litLevel);
  s.hp = Math.max(0, s.hp - amount * spec.burn);
  if (by && spec.fleeMs) {
    l.fleeUntil = ctx.now + spec.fleeMs;
    l.fx = by.x;
    l.fy = by.y;
  }
  // light turns it on whoever's shining it
  if (by && s.mode !== MonsterMode.Hunt && isHuntable(by.render)) {
    s.mode = MonsterMode.Hunt;
    s.target = by.id;
    s.tx = by.x;
    s.ty = by.y;
    l.sawAt = ctx.now;
  }
  if (s.hp > 0) return;
  s.mode = MonsterMode.Dead;
  l.deadAt = ctx.now;
  ctx.world.send(Noise, { kind: Sound.Banish, x: s.x, y: s.y, z: spec.height, a: s.kind }, { to: 'all' });
  if (by) ctx.world.send(Feed, { text: `${by.render.name} banished a ${spec.name}` }, { to: 'all' });
}

/** The Haunt sends a monster this peer owns somewhere, or after a survivor. */
export function order(ctx: HauntContext, m: MonsterEntity, attack: SurvivorEntity | null, x: number, y: number): void {
  const s = m.state;
  if (s.mode === MonsterMode.Dead) return;
  const l = MonsterMind.of(m);
  l.fleeUntil = 0;
  l.restUntil = 0;
  l.nextPath = 0;
  if (attack && isHuntable(attack.render)) {
    s.mode = MonsterMode.Hunt;
    s.target = attack.id;
    s.tx = attack.x;
    s.ty = attack.y;
    l.sawAt = ctx.now;
    l.chaseUntil = ctx.now + 8000;
    return;
  }
  const at = ctx.manor.nearestOpen(x, y);
  s.mode = MonsterMode.Move;
  s.target = 0;
  s.tx = at.x;
  s.ty = at.y;
  l.chaseUntil = 0;
}

/** Whether a survivor's eyes can see a monster: in range, and nothing in the way. For the Haunt's view of who's where. */
export function monsterSees(manor: Manor, m: MonsterEntity, sv: SurvivorEntity): boolean {
  const spec = MONSTERS[m.render.kind];
  const d = Math.hypot(sv.x - m.x, sv.y - m.y);
  return d < noticeRange(spec, sv) * 1.2 && manor.sees(m.x, m.y, sv.x, sv.y);
}
