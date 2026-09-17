import { angleDiff, clamp, type CrewEntity, type FaultEntity, type RelicEntity, type SentinelEntity, type StarshipContext } from './context';
import { Beam3, Crew, CrewMode, Damage, Fault, Feed, Noise, Phase, Recovered, Relic, Repaired, Sentinel, Shot, Sound } from './defs';

/** How many drones guard a relic. */
export const SENTINELS = 3;
const SENTINEL_SIGHT = 20;
const SENTINEL_RANGE = 16;
const SENTINEL_DAMAGE = 8;
const SENTINEL_RELOAD = 2;
const SENTINEL_SPEED = 2.6;
/** A sentinel keeps about this far from who it's shooting, m. */
const STANDOFF = 9;
export const SENTINEL_HP = 4;
export const RELIC_HEIGHT = 1.15;

/** Relics and their guards on every relic world, when a voyage casts off. */
export function spawnSites(ctx: StarshipContext, voyage: number): void {
  const { world, sector, deck } = ctx;
  for (const planet of sector.relicPlanets(voyage)) {
    const site = deck.sites[planet];
    world.spawn(Relic, { x: site.plinth.x, y: site.plinth.y, z: RELIC_HEIGHT, site: planet + 1, voyage });
    for (let i = 0; i < SENTINELS; i++) {
      const a = (i / SENTINELS) * Math.PI * 2 + Math.random();
      const at = deck.clearNear(site.plinth.x + Math.cos(a) * 11, site.plinth.y + Math.sin(a) * 11);
      world.spawn(Sentinel, { x: at.x, y: at.y, z: 1.8, heading: a, hp: SENTINEL_HP, site: planet + 1, tx: at.x, ty: at.y, cooldown: 1, voyage });
    }
  }
}

/**
 * The away sites' things this peer owns. Sentinels drift round their relic until they see a crew member, then keep
 * their distance and shoot. A carried relic follows whoever has it, and falls where they fall.
 */
export function updateAway(ctx: StarshipContext, dt: number): void {
  const { world, deck } = ctx;
  const ship = ctx.ship()?.render;
  for (const e of world.owned(Sentinel) as ReadonlySet<SentinelEntity>) {
    const s = e.state;
    if (!ship || s.voyage !== ship.voyage) {
      world.despawn(e);
      continue;
    }
    const site = deck.sites[s.site - 1];
    let target = world.getAs(Crew, s.target) as CrewEntity | undefined;
    if (!target || !visible(ctx, s, target)) {
      target = undefined;
      let best = SENTINEL_SIGHT;
      for (const c of world.query(s.x, s.y, SENTINEL_SIGHT, Crew) as CrewEntity[]) {
        const d = Math.hypot(c.x - s.x, c.y - s.y);
        if (d < best && visible(ctx, s, c)) {
          best = d;
          target = c;
        }
      }
    }
    s.target = target?.id ?? 0;
    s.z = 1.8 + Math.sin(ctx.now / 600 + e.id) * 0.25;
    s.cooldown = Math.max(0, s.cooldown - dt);
    if (target) {
      const dx = target.x - s.x;
      const dy = target.y - s.y;
      const d = Math.hypot(dx, dy);
      const bearing = Math.atan2(dy, dx);
      s.heading += clamp(angleDiff(s.heading, bearing), -3 * dt, 3 * dt);
      const push = d > STANDOFF + 2 ? 1 : d < STANDOFF - 3 ? -1 : 0;
      const orbit = Math.sin(ctx.now / 1400 + e.id) * 0.6;
      deck.move(s, (Math.cos(bearing) * push - Math.sin(bearing) * orbit) * SENTINEL_SPEED * dt, (Math.sin(bearing) * push + Math.cos(bearing) * orbit) * SENTINEL_SPEED * dt, 0.45);
      if (s.cooldown <= 0 && d < SENTINEL_RANGE && Math.abs(angleDiff(s.heading, bearing)) < 0.35) {
        s.cooldown = SENTINEL_RELOAD * (0.8 + Math.random() * 0.4);
        s.shots = (s.shots + 1) % 256;
        const hit = Math.random() < 0.72;
        const miss = hit ? 0 : 1.5;
        world.send(Beam3, { kind: Shot.Bolt, x: s.x, y: s.y, z: s.z, tx: target.x + (Math.random() - 0.5) * miss, ty: target.y + (Math.random() - 0.5) * miss, tz: 1.2, hit }, { to: 'all' });
        if (hit) world.command(Damage, { target: target.id, amount: SENTINEL_DAMAGE, x: s.x, y: s.y });
      }
    } else {
      if (Math.hypot(s.tx - s.x, s.ty - s.y) < 1) {
        const a = Math.random() * Math.PI * 2;
        const at = deck.clearNear(site.plinth.x + Math.cos(a) * (7 + Math.random() * 8), site.plinth.y + Math.sin(a) * (7 + Math.random() * 8));
        s.tx = at.x;
        s.ty = at.y;
      }
      const bearing = Math.atan2(s.ty - s.y, s.tx - s.x);
      s.heading += clamp(angleDiff(s.heading, bearing), -2 * dt, 2 * dt);
      const before = { x: s.x, y: s.y };
      deck.move(s, Math.cos(bearing) * SENTINEL_SPEED * 0.6 * dt, Math.sin(bearing) * SENTINEL_SPEED * 0.6 * dt, 0.45);
      // stuck on a rock: pick somewhere else
      if (Math.hypot(s.x - before.x, s.y - before.y) < SENTINEL_SPEED * 0.1 * dt) {
        s.tx = s.x;
        s.ty = s.y;
      }
    }
  }

  for (const e of world.owned(Relic) as ReadonlySet<RelicEntity>) {
    const r = e.state;
    if (!ship || r.voyage !== ship.voyage || ship.relics & (1 << (r.site - 1))) {
      world.despawn(e);
      continue;
    }
    if (!r.carrier) continue;
    const carrier = world.getAs(Crew, r.carrier) as CrewEntity | undefined;
    if (!carrier || carrier.render.mode !== CrewMode.Up || deck.onShip(carrier.x)) {
      r.carrier = 0;
      r.z = 0.3;
      continue;
    }
    r.x = carrier.x;
    r.y = carrier.y;
    r.z = 1.2;
  }
}

function visible(ctx: StarshipContext, s: { x: number; y: number; site: number }, c: CrewEntity): boolean {
  const { deck } = ctx;
  if (c.render.mode !== CrewMode.Up || deck.onShip(c.x) || deck.siteAt(c.x) !== s.site - 1) return false;
  return Math.hypot(c.x - s.x, c.y - s.y) < SENTINEL_SIGHT && deck.clear(s.x, s.y, c.x, c.y);
}

/** Damage to a sentinel this peer owns. */
export function hurtSentinel(ctx: StarshipContext, e: SentinelEntity, amount: number): void {
  const s = e.state;
  s.hp = Math.max(0, s.hp - Math.round(amount));
  if (s.hp > 0) return;
  ctx.world.send(Noise, { kind: Sound.Wreck, x: s.x, y: s.y, z: s.z, ship: false }, { to: 'all' });
  ctx.world.despawn(e);
}

/** Someone wants to pick up a relic (or put it down), on its owner: first come, first served. */
export function grabbed(ctx: StarshipContext, e: RelicEntity, by: number): void {
  const r = e.state;
  if (!by) {
    r.carrier = 0;
    r.z = 0.3;
    return;
  }
  const crew = ctx.world.getAs(Crew, by);
  if (r.carrier || !crew || Math.hypot(crew.x - r.x, crew.y - r.y) > 3) return;
  r.carrier = by;
  ctx.world.send(Noise, { kind: Sound.Relic, x: r.x, y: r.y, z: r.z, ship: false }, { to: 'all' });
}

/** A relic beamed aboard, carried or on its own: the ship counts it, and it's gone from the surface. */
export function relicAboard(ctx: StarshipContext, e: RelicEntity): void {
  const ship = ctx.ship();
  const planet = e.state.site - 1;
  if (ship) ctx.world.command(Recovered, { target: ship.id, planet });
  ctx.world.despawn(e);
}

/** Faults this peer owns: gone with their voyage, and mended by the starbase's engineers while docked. */
export function updateFaults(ctx: StarshipContext, dt: number): void {
  const ship = ctx.ship()?.render;
  for (const e of ctx.world.owned(Fault) as ReadonlySet<FaultEntity>) {
    if (!ship || e.state.voyage !== ship.voyage || ship.phase !== Phase.Underway) {
      ctx.world.despawn(e);
      continue;
    }
    if (ship.docked) mend(ctx, e, dt / 8);
  }
}

/** Mend a fault this peer owns a little. Mended, it's gone and its system is the better for it. */
export function mend(ctx: StarshipContext, e: FaultEntity, amount: number): void {
  if (!e.alive) return;
  const f = e.state;
  f.left = Math.max(0, f.left - amount);
  if (f.left > 0) return;
  const ship = ctx.ship();
  if (ship) ctx.world.command(Repaired, { target: ship.id, system: f.system });
  ctx.world.send(Noise, { kind: Sound.Repair, x: f.x, y: f.y, z: f.z, ship: false }, { to: 'all' });
  ctx.world.despawn(e);
}

/** A relic came aboard: the ship's owner counts it. */
export function recovered(ctx: StarshipContext, planet: number): void {
  const ship = ctx.ship();
  if (!ship?.mine) return;
  const s = ship.state;
  if (s.relics & (1 << planet)) return;
  s.relics |= 1 << planet;
  let n = 0;
  for (let b = s.relics; b; b &= b - 1) n++;
  const name = ctx.sector.planets[planet]?.name ?? 'the planet';
  ctx.world.send(Feed, { text: n >= 3 ? `The relic from ${name} is aboard. That's all three: set a course for the starbase!` : `The relic from ${name} is aboard (${n} of 3)` }, { to: 'all' });
}
