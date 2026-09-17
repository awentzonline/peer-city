import { angleDiff, clamp, type RaiderEntity, type ShipState, type StarshipContext } from './context';
import { Beam3, Boom, Damage, Feed, Phase, Raider, RaiderKind, Shot, Warp } from './defs';
import type { Torpedoes } from './flights';
import { MAX_IMPULSE } from './ship';
import { SECTOR } from './sector';

export interface RaiderSpec {
  name: string;
  hp: number;
  shields: number;
  speed: number;
  turn: number;
  /** Disruptor: range, damage, seconds between shots. */
  range: number;
  damage: number;
  reload: number;
  /** Seconds between torpedoes, or 0 for none. */
  torpedoes: number;
}

export const RAIDERS: Record<RaiderKind, RaiderSpec> = {
  [RaiderKind.Fighter]: { name: 'Raider', hp: 60, shields: 30, speed: 150, turn: 1.3, range: 620, damage: 5, reload: 2.4, torpedoes: 0 },
  [RaiderKind.Cruiser]: { name: 'Raider cruiser', hp: 170, shields: 90, speed: 75, turn: 0.55, range: 720, damage: 8, reload: 1.9, torpedoes: 10 },
};

/** Most raiders about at once. */
export const MAX_RAIDERS = 6;
/** How far off a wave appears, u. */
const WAVE_DISTANCE = 2300;
/** Raiders this far from the ship lose track of it and go home. */
const LOST_DISTANCE = 5200;
/** The starbase's guns reach this far, and hurt this much a second. */
export const STARBASE_GUNS = 1300;
const STARBASE_DPS = 14;
/** Circling distance: raiders close in to about this far, u. */
const CIRCLE = 460;

/** Turn out a wave of raiders somewhere off the ship's bow or quarter. Returns how many came. */
export function spawnWave(ctx: StarshipContext, ship: ShipState, size: number): number {
  const { world } = ctx;
  let alive = 0;
  for (const r of world.all(Raider)) if (r.render.voyage === ship.voyage) alive++;
  const n = Math.min(size, MAX_RAIDERS - alive);
  if (n <= 0) return 0;
  const a = Math.random() * Math.PI * 2;
  const cx = clamp(ship.x + Math.cos(a) * WAVE_DISTANCE, 300, SECTOR - 300);
  const cy = clamp(ship.y + Math.sin(a) * WAVE_DISTANCE, 300, SECTOR - 300);
  const cruisers = ship.waves >= 2 ? Math.floor(n / 3) + (ship.waves >= 4 ? 1 : 0) : 0;
  for (let i = 0; i < n; i++) {
    const kind = i < cruisers ? RaiderKind.Cruiser : RaiderKind.Fighter;
    const spec = RAIDERS[kind];
    world.spawn(Raider, {
      x: cx + (Math.random() - 0.5) * 300,
      y: cy + (Math.random() - 0.5) * 300,
      heading: a + Math.PI,
      speed: spec.speed,
      kind,
      hp: spec.hp,
      shields: spec.shields,
      side: Math.random() < 0.5,
      cooldown: 2 + Math.random() * 2,
      torpT: 6 + Math.random() * 4,
      voyage: ship.voyage,
    });
  }
  world.send(Feed, { text: n === 1 ? 'Sensors: a raider is closing on us' : `Sensors: ${n} raiders closing on us` }, { to: 'all' });
  return n;
}

/**
 * The raiders this peer owns: close in on the ship and circle it, firing disruptors when it's in their sights, and (the
 * cruisers) torpedoes. Faster than the ship, but they lose it at warp, and they won't stay near the starbase's guns.
 */
export function updateRaiders(ctx: StarshipContext, torpedoes: Torpedoes, dt: number): void {
  const { world, sector } = ctx;
  const ship = ctx.ship();
  const s = ship?.render;
  for (const r of world.owned(Raider) as ReadonlySet<RaiderEntity>) {
    const rs = r.state;
    if (!s || rs.voyage !== s.voyage || s.phase === Phase.Briefing) {
      world.despawn(r);
      continue;
    }
    const spec = RAIDERS[rs.kind];
    const dx = s.x - rs.x;
    const dy = s.y - rs.y;
    const d = Math.hypot(dx, dy);
    if (d > LOST_DISTANCE) {
      world.despawn(r);
      continue;
    }
    const bearing = Math.atan2(dy, dx);
    const over = s.phase !== Phase.Underway;
    let want: number;
    const sb = Math.hypot(sector.starbase.x - rs.x, sector.starbase.y - rs.y);
    if (over || s.docked || sb < STARBASE_GUNS) {
      // keep off: away from the starbase, and from the ship once it's over
      want = Math.atan2(rs.y - sector.starbase.y, rs.x - sector.starbase.x);
    } else if (d > CIRCLE + 350) {
      want = bearing;
    } else {
      const drift = clamp((d - CIRCLE) / 400, -0.7, 0.7);
      want = bearing + (rs.side ? 1 : -1) * (Math.PI / 2 - drift);
    }
    const turn = spec.turn * dt;
    rs.heading += clamp(angleDiff(rs.heading, want), -turn, turn);
    rs.speed += (spec.speed - rs.speed) * Math.min(1, dt);
    rs.x = clamp(rs.x + Math.cos(rs.heading) * rs.speed * dt, 50, SECTOR - 50);
    rs.y = clamp(rs.y + Math.sin(rs.heading) * rs.speed * dt, 50, SECTOR - 50);
    const planet = sector.nearestPlanet(rs.x, rs.y);
    if (planet.surface < 30) {
      const a = Math.atan2(rs.y - planet.planet.y, rs.x - planet.planet.x);
      rs.x = planet.planet.x + Math.cos(a) * (planet.planet.radius + 30);
      rs.y = planet.planet.y + Math.sin(a) * (planet.planet.radius + 30);
      rs.heading = a;
    }

    if (sb < STARBASE_GUNS) hurt(ctx, r, STARBASE_DPS * dt);
    if (!r.alive || over || s.docked || s.warp === Warp.Warping) continue;

    rs.cooldown -= dt;
    if (rs.cooldown <= 0 && d < spec.range && Math.abs(angleDiff(rs.heading, bearing)) < 1.1) {
      rs.cooldown = spec.reload * (0.85 + Math.random() * 0.3);
      const hit = Math.random() < 0.9 - (s.speed / MAX_IMPULSE) * 0.35;
      const miss = hit ? 0 : 60;
      world.send(Beam3, { kind: Shot.Disruptor, x: rs.x, y: rs.y, z: 0, tx: s.x + (Math.random() - 0.5) * miss, ty: s.y + (Math.random() - 0.5) * miss, tz: 0, hit }, { to: 'all' });
      if (hit) world.command(Damage, { target: ship!.id, amount: spec.damage, x: rs.x, y: rs.y });
    }
    if (spec.torpedoes) {
      rs.torpT -= dt;
      if (rs.torpT <= 0 && d < 1500) {
        rs.torpT = spec.torpedoes * (0.8 + Math.random() * 0.4);
        torpedoes.launch(rs.x, rs.y, bearing, ship!.id, true);
      }
    }
  }
}

/** Damage to a raider this peer owns: shields first. Destroyed at no hull. */
export function hurt(ctx: StarshipContext, r: RaiderEntity, amount: number): void {
  const rs = r.state;
  if (!r.alive || rs.hp <= 0) return;
  const soak = Math.min(rs.shields, amount);
  rs.shields -= soak;
  rs.hp = Math.max(0, rs.hp - (amount - soak));
  if (rs.hp > 0) return;
  ctx.world.send(Boom, { x: rs.x, y: rs.y, size: rs.kind === RaiderKind.Cruiser ? 2 : 1 }, { to: 'all' });
  ctx.world.send(Feed, { text: `${RAIDERS[rs.kind].name} destroyed` }, { to: 'all' });
  ctx.world.despawn(r);
}
