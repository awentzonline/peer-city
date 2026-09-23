import { angleDiff, type CrewEntity, type RaiderEntity, type ShipState, type StarshipContext } from './context';
import { Beam, Crew, Phase, Raider, Relic, Warp, type ShipSystem } from './defs';
import type { Picked } from './scopes';
import { DOCK_REACH, ORBIT_REACH, POWER_POOL, SHIELD_MAX, WARP_MIN, onPad, phaserBlocked, pips, powerUsed, sensorRange, transporterBlocked } from './ship';

/**
 * What each station may do right now, and what its keys say. The phone's panel (`StationPanel`) and the bridge's
 * consoles (`BridgeConsole`) both ask here, so a key that's greyed on one is greyed on the other for the same reason.
 * Everything is worked out from the ship's replicated state, so any peer gets the same answer.
 */

// ---------------------------------------------------------------------------
// Helm
// ---------------------------------------------------------------------------

export function waypointDistance(s: ShipState): number {
  return Math.hypot(s.wx - s.x, s.wy - s.y);
}

export function warpLabel(s: ShipState): string {
  return s.warp === Warp.Charging ? `CHARGING ${Math.round(s.warpT * 100)}%` : s.warp === Warp.Warping ? 'AT WARP' : 'WARP';
}

/** How far the warp key's charge bar is along, 0 to 1. */
export function warpFill(s: ShipState): number {
  return s.warp === Warp.Charging ? s.warpT : s.warp === Warp.Warping ? 1 : 0;
}

/** Warp needs a waypoint worth warping to, and a ship that's out and about. Once charging, it can be cancelled. */
export function warpBlocked(s: ShipState): boolean {
  return s.phase !== Phase.Underway || s.docked || (s.warp === Warp.Idle && (!s.waypoint || waypointDistance(s) < WARP_MIN));
}

export function autopilotBlocked(s: ShipState): boolean {
  return !s.waypoint || s.docked || s.phase !== Phase.Underway;
}

export function orbitLabel(ctx: StarshipContext, s: ShipState): string {
  if (s.orbit) return 'BREAK ORBIT';
  const near = ctx.sector.nearestPlanet(s.x, s.y);
  return near.surface <= ORBIT_REACH ? `ORBIT ${near.planet.name.toUpperCase()}` : 'ORBIT';
}

export function orbitBlocked(ctx: StarshipContext, s: ShipState): boolean {
  return !s.orbit && (ctx.sector.nearestPlanet(s.x, s.y).surface > ORBIT_REACH || s.docked || s.phase !== Phase.Underway);
}

export function dockLabel(s: ShipState): string {
  return s.phase === Phase.Briefing ? 'CAST OFF' : s.docked ? 'UNDOCK' : 'DOCK';
}

export function dockBlocked(ctx: StarshipContext, s: ShipState): boolean {
  return s.phase === Phase.Over || (!s.docked && Math.hypot(ctx.sector.starbase.x - s.x, ctx.sector.starbase.y - s.y) > DOCK_REACH);
}

/** The helm's line about where it's going: `hint` is what to say when there's no waypoint (each screen points at its own map). */
export function waypointLine(s: ShipState, hint: string): string {
  if (!s.waypoint) return hint;
  const wd = waypointDistance(s);
  const eta = s.speed > 5 && s.warp === Warp.Idle ? ` · ETA ${Math.round(wd / s.speed)} s` : s.warp === Warp.Warping ? ' · AT WARP' : '';
  return `WAYPOINT ${Math.round(wd)} u${eta}`;
}

// ---------------------------------------------------------------------------
// Tactical
// ---------------------------------------------------------------------------

export function targetOf(ctx: StarshipContext, s: ShipState): RaiderEntity | null {
  return (ctx.world.getAs(Raider, s.target) as RaiderEntity | undefined) ?? null;
}

/** Why the phasers can't fire, or '': `phaserBlocked` plus the ship having to be underway. */
export function phasersBlocked(s: ShipState, target: RaiderEntity | null): string {
  return s.phase !== Phase.Underway ? 'Not underway' : phaserBlocked(s, target);
}

export function shieldsLabel(s: ShipState): string {
  return s.shieldsUp ? (s.shields < SHIELD_MAX * 0.95 ? 'SHIELDS RAISING' : 'SHIELDS UP') : 'SHIELDS DOWN';
}

/** Shields stay down in dock. */
export function shieldsBlocked(s: ShipState): boolean {
  return s.docked && !s.shieldsUp;
}

export function torpedoBlocked(s: ShipState): boolean {
  return !s.tubes || s.docked || s.phase !== Phase.Underway;
}

/** How many tubes are loaded. */
export function tubesLoaded(s: ShipState): number {
  return (s.tubes & 1 ? 1 : 0) + (s.tubes & 2 ? 1 : 0);
}

/** The raider to target after the current one, nearest first round the list, or 0 with none about. */
export function nextTarget(ctx: StarshipContext, s: ShipState): number {
  const list = ([...ctx.world.all(Raider)] as RaiderEntity[]).sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y));
  if (!list.length) return 0;
  const i = list.findIndex((r) => r.id === s.target);
  return list[(i + 1) % list.length].id;
}

/** Where a target lies off the bow: 'dead ahead', or so many degrees to port or starboard. */
export function bearingOf(s: ShipState, t: { x: number; y: number }): string {
  const rel = Math.round((angleDiff(s.heading, Math.atan2(t.y - s.y, t.x - s.x)) * 180) / Math.PI);
  return Math.abs(rel) < 3 ? 'dead ahead' : `${Math.abs(rel)}° ${rel > 0 ? 'starboard' : 'port'}`;
}

// ---------------------------------------------------------------------------
// Science
// ---------------------------------------------------------------------------

/** Whether the sensors are on what science has picked. */
export function scanningThis(s: ShipState, picked: Picked): boolean {
  return !!picked && ('planet' in picked ? s.scanPlanet === picked.planet + 1 : s.scanning === picked.raider);
}

export function scanLabel(s: ShipState, picked: Picked): string {
  return scanningThis(s, picked) ? `SCANNING ${Math.round(s.scanT * 100)}%` : 'SCAN';
}

/** A planet must be in sensor range while underway; a raider only needs to be unscanned. */
export function scanBlocked(ctx: StarshipContext, s: ShipState, picked: Picked): boolean {
  if (!picked) return true;
  if ('planet' in picked) {
    const pl = ctx.sector.planets[picked.planet];
    return Math.max(0, Math.hypot(pl.x - s.x, pl.y - s.y) - pl.radius) > sensorRange(s) || s.phase !== Phase.Underway;
  }
  return !!(ctx.world.getAs(Raider, picked.raider) as RaiderEntity | undefined)?.render.scanned;
}

/** Crew on the transporter pad, ready to go down. */
export function onPadCount(ctx: StarshipContext): number {
  let n = 0;
  for (const c of ctx.world.all(Crew) as ReadonlySet<CrewEntity>) if (ctx.deck.onShip(c.x) && onPad(c)) n++;
  return n;
}

/** Crew down on a planet's surface, ready to come up. */
export function awayCount(ctx: StarshipContext, planet: number): number {
  if (planet < 0) return 0;
  let n = 0;
  for (const c of ctx.world.all(Crew) as ReadonlySet<CrewEntity>) if (!ctx.deck.onShip(c.x) && ctx.deck.siteAt(c.x) === planet) n++;
  return n;
}

/** Whether a relic lies on a planet's surface for the transporter to lock onto. */
export function relicWaiting(ctx: StarshipContext, planet: number): boolean {
  if (planet < 0) return false;
  for (const r of ctx.world.all(Relic)) if (r.render.site === planet + 1 && !r.render.carrier) return true;
  return false;
}

/** Whether the transporter can do `want` now: it's free and clear (`transporterBlocked`), and there's someone or something to beam. */
export function beamBlocked(ctx: StarshipContext, s: ShipState, want: 'down' | 'up' | 'relic'): boolean {
  if (transporterBlocked(s) || s.beam !== Beam.Idle) return true;
  const planet = s.orbit - 1;
  if (want === 'down') return !onPadCount(ctx);
  if (want === 'up') return !awayCount(ctx, planet);
  return !relicWaiting(ctx, planet);
}

/** What the transporter's doing, while it's doing something. */
export function beamingLine(s: ShipState): string {
  return `${['', 'Beaming down', 'Beaming up', 'Locking onto the relic through the interference'][s.beam]}… ${Math.round(s.beamT * 100)}%`;
}

// ---------------------------------------------------------------------------
// Engineering
// ---------------------------------------------------------------------------

/** Whether a system can be set to `n` pips: only if the pool has that many spare. */
export function pipBlocked(s: ShipState, sys: ShipSystem, n: number): boolean {
  const p = pips(s, sys);
  return n > p && n - p > POWER_POOL - powerUsed(s);
}

export function powerLine(s: ShipState): string {
  const used = powerUsed(s);
  return `POWER ${used} / ${POWER_POOL}${used < POWER_POOL ? ` · ${POWER_POOL - used} spare` : ''}`;
}
