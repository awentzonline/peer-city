import { defineLocal } from '@engine/index';
import { angleDiff, type GoblinEntity, type LordEntity, type SewerContext, type Vec3 } from './context';
import { Feed, Goblin, GoblinMode, Hurt, Lord, LordMode, Loot, LootWhere, Noise, Phase, Snatch, Sound, Splat, SplatKind } from './defs';
import { WADE } from './fatberg';
import type { WallSpot } from './sewer';

/** A goblin's size: its height, and how wide it is. Shorter than a Lord, but not by much. */
export const GOBLIN_HEIGHT = 1.25;
export const GOBLIN_RADIUS = 0.3;
/** Where to hold one: by the scruff of the neck, this far over its feet. */
export const SCRUFF = 1.02;
const WANDER_SPEED = 1.1;
const CHASE_SPEED = 2.8;
const FLEE_SPEED = 3.3;
/** How far it notices a Lord, and a Lord with a full sack (it smells the loot). */
const SENSE = 10;
const GREED_SENSE = 16;
const REACH = 0.95;
const STRIKE_MS = 1500;
/** Chance a lunge at a Lord with loot takes some rather than scratching. */
const SNATCH_CHANCE = 0.55;
/** After a scratch, how often it scampers off for a moment before coming back. */
const SCAMPER_CHANCE = 0.6;
const GIVE_UP_MS = 6000;
/** How long something splattered or gone lingers, so everyone sees why, ms. */
const LINGER_MS = 400;
/** Below this, a punch only knocks one silly; above, it goes flying. */
export const FLING_FORCE = 0.45;
/** At this, a punch bursts it. */
export const GIB_FORCE = 0.95;
const GIB_CHANCE = 0.25;

interface GoblinLocal {
  nextLook: number;
  nextPath: number;
  nextStrike: number;
  waypoint: { x: number; y: number } | null;
  sawAt: number;
  restUntil: number;
  staggerUntil: number;
  /** Knocked back this fast, m/s, sliding to a stop. */
  kx: number;
  ky: number;
  /** Scampering off from here until then, with no loot: then back to it. */
  fleeUntil: number;
  fx: number;
  fy: number;
  deadAt: number;
}

export const GoblinMind = defineLocal<GoblinLocal>(() => ({
  nextLook: 0,
  nextPath: 0,
  nextStrike: 0,
  waypoint: null,
  sawAt: 0,
  restUntil: 0,
  staggerUntil: 0,
  kx: 0,
  ky: 0,
  fleeUntil: 0,
  fx: 0,
  fy: 0,
  deadAt: 0,
}));

export function alive(mode: GoblinMode): boolean {
  return mode !== GoblinMode.Dead && mode !== GoblinMode.Gone;
}

/** How far a point is from a goblin's body: a capsule up its middle. */
export function distanceToGoblin(g: { x: number; y: number; render: { z: number } }, p: Vec3): number {
  const z = Math.min(Math.max(p.z, g.render.z + 0.3), g.render.z + GOBLIN_HEIGHT - 0.2);
  return Math.max(0, Math.hypot(p.x - g.x, p.y - g.y, p.z - z) - GOBLIN_RADIUS);
}

/** A goblin comes out of a drain. Whoever spawns it runs it. */
export function spawnGoblin(ctx: SewerContext, drain: WallSpot, dive: number): GoblinEntity {
  const x = drain.x + drain.nx * 0.45;
  const y = drain.y + drain.ny * 0.45;
  return ctx.world.spawn(Goblin, { x, y, z: ctx.map.groundAt(x, y), angle: Math.atan2(drain.ny, drain.nx), mode: GoblinMode.Wander, hp: 2, tx: x, ty: y, dive, look: Math.floor(Math.random() * 256) });
}

/** Whether a Lord's worth going after: up and about, or down with something in the sack. */
function prey(s: { mode: LordMode; sack: number }): boolean {
  return s.mode === LordMode.Active || (s.mode === LordMode.Downed && s.sack > 0);
}

/**
 * Goblins this peer owns. Each wanders till it notices a Lord (from further off if their sack's full), runs at them and
 * scratches, or grabs something out of the sack and makes for the nearest drain with it. Held ones are moved by whoever
 * holds them; splattered ones linger a moment so everyone sees them go.
 */
export function updateOwnedGoblins(ctx: SewerContext, dt: number): void {
  const { world, now } = ctx;
  const sewer = ctx.sewer()?.state;
  for (const g of world.owned(Goblin) as ReadonlySet<GoblinEntity>) {
    const s = g.state;
    const l = GoblinMind.of(g);
    if (!sewer || s.dive !== sewer.dive || sewer.phase !== Phase.Dive) {
      world.despawn(g);
      continue;
    }
    if (!alive(s.mode)) {
      l.deadAt ||= now;
      if (now - l.deadAt > LINGER_MS) world.despawn(g);
      continue;
    }
    if (s.mode === GoblinMode.Held) {
      const holder = world.getAs(Lord, s.heldBy);
      if (holder !== ctx.me || holder?.state.holding !== g.id) drop(ctx, g);
      continue;
    }
    if (now >= l.nextLook) {
      l.nextLook = now + 220 + Math.random() * 80;
      look(ctx, g);
    }
    switch (s.mode) {
      case GoblinMode.Stagger: {
        const k = Math.exp(-dt * 4);
        l.kx *= k;
        l.ky *= k;
        ctx.map.move(s, l.kx * dt, l.ky * dt, GOBLIN_RADIUS);
        if (now >= l.staggerUntil) s.mode = s.carrying ? GoblinMode.Flee : GoblinMode.Wander;
        break;
      }
      case GoblinMode.Chase: {
        const target = world.getAs(Lord, s.target);
        if (!target || !prey(target.render) || now - l.sawAt > GIVE_UP_MS) {
          s.mode = GoblinMode.Wander;
          s.target = 0;
          break;
        }
        const d = Math.hypot(target.x - s.x, target.y - s.y);
        if (d > REACH * 0.7) step(ctx, g, s.tx, s.ty, CHASE_SPEED, dt, true);
        else face(g, Math.atan2(target.y - s.y, target.x - s.x), dt);
        if (d < REACH && now >= l.nextStrike) strike(ctx, g, target);
        break;
      }
      case GoblinMode.Flee: {
        if (!s.carrying && now >= l.fleeUntil) {
          s.mode = GoblinMode.Wander;
          break;
        }
        if (!s.carrying) {
          const away = Math.atan2(s.y - l.fy, s.x - l.fx) + Math.sin(now / 300 + g.id) * 0.4;
          step(ctx, g, s.x + Math.cos(away) * 3, s.y + Math.sin(away) * 3, FLEE_SPEED, dt, false);
          break;
        }
        const drain = nearestDrain(ctx, s.x, s.y);
        const dx = drain.x + drain.nx * 0.3;
        const dy = drain.y + drain.ny * 0.3;
        if (Math.hypot(dx - s.x, dy - s.y) < 0.5) {
          escape(ctx, g);
          break;
        }
        step(ctx, g, dx, dy, FLEE_SPEED, dt, true);
        break;
      }
      default:
        wander(ctx, g, dt);
    }
    s.z = ctx.map.groundAt(s.x, s.y);
  }
  separate(ctx);
}

/** Look for someone to go after, and at what it's carrying. */
function look(ctx: SewerContext, g: GoblinEntity): void {
  const { world, map, now } = ctx;
  const s = g.state;
  const l = GoblinMind.of(g);
  // did the loot it grabbed come to it?
  if (!s.carrying) {
    for (const loot of world.all(Loot)) if (loot.render.carrier === g.id && loot.render.where === LootWhere.Carried) s.carrying = loot.id;
  } else if (world.getAs(Loot, s.carrying)?.render.carrier !== g.id && now - l.sawAt > 1500) {
    s.carrying = 0;
  }
  if (s.carrying) {
    if (s.mode !== GoblinMode.Stagger) s.mode = GoblinMode.Flee;
    return;
  }
  if (s.mode === GoblinMode.Flee || s.mode === GoblinMode.Stagger) return;
  if (s.mode === GoblinMode.Chase) {
    const target = world.getAs(Lord, s.target);
    if (target && prey(target.render) && Math.hypot(target.x - s.x, target.y - s.y) < GREED_SENSE && map.sees(s.x, s.y, target.x, target.y)) {
      l.sawAt = now;
      s.tx = target.x;
      s.ty = target.y;
      return;
    }
  }
  let best: LordEntity | null = null;
  let bestScore = Infinity;
  for (const lord of world.query(s.x, s.y, GREED_SENSE, Lord) as LordEntity[]) {
    const r = lord.render;
    if (!prey(r) || r.dive !== s.dive) continue;
    const d = Math.hypot(lord.x - s.x, lord.y - s.y);
    if (d > (r.sack > 0 ? GREED_SENSE : SENSE) || !map.sees(s.x, s.y, lord.x, lord.y)) continue;
    const score = d - (r.sack > 0 ? 6 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = lord;
    }
  }
  if (best && (s.mode !== GoblinMode.Chase || best.id !== s.target)) {
    s.mode = GoblinMode.Chase;
    s.target = best.id;
    s.tx = best.x;
    s.ty = best.y;
    l.sawAt = now;
  }
}

function step(ctx: SewerContext, g: GoblinEntity, tx: number, ty: number, speed: number, dt: number, path: boolean): void {
  const { map, paths, now } = ctx;
  const s = g.state;
  const l = GoblinMind.of(g);
  let gx = tx;
  let gy = ty;
  if (path) {
    if (now >= l.nextPath || !l.waypoint) {
      l.nextPath = now + 250 + Math.random() * 100;
      l.waypoint = paths.next(s.x, s.y, tx, ty, GOBLIN_RADIUS, now);
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
  const x0 = s.x;
  const y0 = s.y;
  if (map.move(s, dx * k, dy * k, GOBLIN_RADIUS)) l.nextPath = 0;
  // the fat stops goblins as it stops anyone
  const ground = map.groundAt(s.x, s.y);
  if (ctx.plug.blocks(s.x, s.y, ground + WADE + 0.05, ground + GOBLIN_HEIGHT - 0.1, GOBLIN_RADIUS)) {
    s.x = x0;
    s.y = y0;
    l.nextPath = 0;
  }
  face(g, Math.atan2(dy, dx), dt);
}

function face(g: GoblinEntity, angle: number, dt: number): void {
  const s = g.state;
  s.angle += angleDiff(s.angle, angle) * Math.min(1, dt * 9);
}

function wander(ctx: SewerContext, g: GoblinEntity, dt: number): void {
  const s = g.state;
  const l = GoblinMind.of(g);
  if (ctx.now < l.restUntil) return;
  if (Math.hypot(s.tx - s.x, s.ty - s.y) < 0.6) {
    l.restUntil = ctx.now + 800 + Math.random() * 2500;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 2 + Math.random() * 6;
      const x = s.x + Math.cos(a) * d;
      const y = s.y + Math.sin(a) * d;
      if (ctx.map.solid(Math.floor(x), Math.floor(y)) || !ctx.map.sees(s.x, s.y, x, y)) continue;
      s.tx = Math.floor(x) + 0.5;
      s.ty = Math.floor(y) + 0.5;
      break;
    }
    return;
  }
  step(ctx, g, s.tx, s.ty, WANDER_SPEED, dt, true);
}

/** Lunge at a Lord: a scratch, or a grab at their sack if there's anything in it. */
function strike(ctx: SewerContext, g: GoblinEntity, target: LordEntity): void {
  const { world, now } = ctx;
  const s = g.state;
  const l = GoblinMind.of(g);
  l.nextStrike = now + STRIKE_MS * (0.8 + Math.random() * 0.4);
  s.strikes = (s.strikes + 1) & 0xff;
  if (target.render.sack > 0 && Math.random() < SNATCH_CHANCE) {
    const bag: number[] = [];
    for (const loot of world.all(Loot)) if (loot.render.carrier === target.id && loot.render.where === LootWhere.Carried) bag.push(loot.id);
    if (bag.length) {
      const id = bag[Math.floor(Math.random() * bag.length)];
      world.command(Snatch, { target: id, by: g.id });
      world.send(Noise, { kind: Sound.Snatch, x: s.x, y: s.y, z: s.z + 1, a: 0 }, { to: 'all' });
      s.mode = GoblinMode.Flee;
      l.fleeUntil = now + 4000;
      l.fx = target.x;
      l.fy = target.y;
      l.sawAt = now;
      return;
    }
  }
  const d = Math.max(0.1, Math.hypot(target.x - s.x, target.y - s.y));
  const k = 2 / d;
  world.command(Hurt, { target: target.id, by: g.id, amount: 1, kx: (target.x - s.x) * k, ky: (target.y - s.y) * k });
  world.send(Noise, { kind: Sound.Scratch, x: s.x, y: s.y, z: s.z + 1, a: 0 }, { to: 'all' });
  if (Math.random() < SCAMPER_CHANCE) {
    s.mode = GoblinMode.Flee;
    l.fleeUntil = now + 900 + Math.random() * 1200;
    l.fx = target.x;
    l.fy = target.y;
  }
}

function nearestDrain(ctx: SewerContext, x: number, y: number): WallSpot {
  let best = ctx.map.drains[0];
  let bestD = Infinity;
  for (const d of ctx.map.drains) {
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/** Down the drain and away, with whatever it's got. */
function escape(ctx: SewerContext, g: GoblinEntity): void {
  const s = g.state;
  s.mode = GoblinMode.Gone;
  ctx.world.send(Noise, { kind: Sound.Escape, x: s.x, y: s.y, z: s.z + 0.6, a: s.carrying ? 1 : 0 }, { to: 'all' });
  if (s.carrying) ctx.world.send(Feed, { text: 'A goblin got away down a drain with some loot!' }, { to: 'all' });
}

/** Keep goblins from standing in each other. */
function separate(ctx: SewerContext): void {
  const { world, map } = ctx;
  for (const g of world.owned(Goblin) as ReadonlySet<GoblinEntity>) {
    const s = g.state;
    if (!alive(s.mode) || s.mode === GoblinMode.Held) continue;
    for (const o of world.query(s.x, s.y, 0.8, Goblin) as GoblinEntity[]) {
      if (o === g || !alive(o.render.mode) || o.render.mode === GoblinMode.Held) continue;
      const dx = s.x - o.x;
      const dy = s.y - o.y;
      const d = Math.hypot(dx, dy);
      const min = GOBLIN_RADIUS * 2;
      if (d >= min || d < 1e-4) continue;
      const push = (min - d) * 0.5;
      map.move(s, (dx / d) * push, (dy / d) * push, GOBLIN_RADIUS);
    }
  }
}

/**
 * A fist (or a jet) hit a goblin this peer owns. A light blow knocks it silly; a proper punch sends it flying, and a
 * haymaker (or bad luck) bursts it.
 */
export function punched(ctx: SewerContext, g: GoblinEntity, force: number, dx: number, dy: number, dz: number): void {
  const s = g.state;
  if (!alive(s.mode)) return;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  if (force < FLING_FORCE) {
    s.hp = Math.max(0, s.hp - (force > 0.25 ? 1 : 0));
    if (s.hp > 0) {
      const l = GoblinMind.of(g);
      if (s.mode !== GoblinMode.Held) {
        s.mode = GoblinMode.Stagger;
        l.staggerUntil = ctx.now + 500 + force * 1200;
        l.kx = ux * (1.5 + force * 6);
        l.ky = uy * (1.5 + force * 6);
      }
      ctx.world.send(Noise, { kind: Sound.Thump, x: s.x, y: s.y, z: s.z + 0.9, a: Math.round(force * 100) }, { to: 'all' });
      return;
    }
  }
  const burst = force >= GIB_FORCE || Math.random() < GIB_CHANCE;
  const speed = 4 + Math.min(force, 1.5) * 9;
  splat(ctx, g, burst ? SplatKind.Gib : SplatKind.Fling, ux * speed, uy * speed, Math.max(uz * speed, 0) + 2.5 + force * 2);
}

/** A goblin this peer owns meets its end: everyone sees it go (ragdoll.ts), and it's gone once they have. */
export function splat(ctx: SewerContext, g: GoblinEntity, kind: SplatKind, vx: number, vy: number, vz: number): void {
  const s = g.state;
  if (!alive(s.mode)) return;
  ctx.world.send(Splat, { goblin: g.id, kind, x: s.x, y: s.y, z: s.z, angle: s.angle, vx, vy, vz }, { to: 'all' });
  s.mode = GoblinMode.Dead;
  s.heldBy = 0;
  GoblinMind.of(g).deadAt = ctx.now;
}

/** Let go of a goblin this peer holds (or found held by someone gone): it lands on its feet, dazed. */
export function drop(ctx: SewerContext, g: GoblinEntity): void {
  const s = g.state;
  const l = GoblinMind.of(g);
  const at = ctx.map.nearestOpen(s.x, s.y);
  if (ctx.map.solid(Math.floor(s.x), Math.floor(s.y))) {
    s.x = at.x;
    s.y = at.y;
  }
  s.mode = GoblinMode.Stagger;
  s.heldBy = 0;
  s.target = 0;
  s.z = ctx.map.groundAt(s.x, s.y);
  l.staggerUntil = ctx.now + 900;
  l.kx = l.ky = 0;
  if (g.held) ctx.world.release(g);
}
