import { Singleton } from '@engine/index';
import { angleDiff, clamp, type CrewEntity, type FaultEntity, type RaiderEntity, type RelicEntity, type ShipEntity, type ShipState, type StarshipContext } from './context';
import { CONSOLES, PAD, SPAWN } from './deck';
import {
  Act,
  Beam,
  Beam3,
  Boom,
  Crew,
  CrewMode,
  Damage,
  Fault,
  FaultKind,
  Feed,
  Jolt,
  Mend,
  Noise,
  Officer,
  Phase,
  Raider,
  Relic,
  Result,
  Scanned,
  Screen,
  Ship,
  ShipSystem,
  Shot,
  Sound,
  SYSTEMS,
  Transport,
  Warp,
} from './defs';
import type { Torpedoes } from './flights';
import { spawnSites } from './away';
import { spawnWave } from './raiders';
import { SECTOR, allRelics, bitCount } from './sector';

// ---------------------------------------------------------------------------
// Numbers: u and seconds
// ---------------------------------------------------------------------------

/** Full impulse, u/s, at full efficiency. */
export const MAX_IMPULSE = 120;
const ACCEL = 45;
/** Turning, rad/s at full efficiency. */
export const TURN_RATE = 0.65;
export const WARP_SPEED = 1600;
export const WARP_CHARGE = 5;
/** The drive won't jump to somewhere nearer than this, u. */
export const WARP_MIN = 900;
/** Close enough to a planet's surface to take up orbit, and to the starbase to dock, u. */
export const ORBIT_REACH = 700;
export const DOCK_REACH = 700;
const ORBIT_SPEED = 40;
export const PHASER_RANGE = 900;
/** Either side of dead ahead the phasers reach, rad. */
export const PHASER_ARC = 1.4;
const PHASER_CHARGE = 3;
export const PHASER_DAMAGE = 26;
/** A phaser shot needs at least this much charge. */
export const PHASER_MIN = 0.25;
export const TORPEDO_DAMAGE = 45;
export const MAX_TORPS = 8;
const AUTOLOAD = 14;
export const SHIELD_MAX = 100;
const SHIELD_REGEN = 9;
export const SENSOR_RANGE = 3200;
const SCAN_TIME = 4;
const BEAM_TIME = 3;
export const RELIC_BEAM_TIME = 25;
/** Science's damage bonus against a scanned raider. */
export const WEAKNESS = 1.5;
/** Power pips there are to share out, and the most one system takes. */
export const POWER_POOL = 8;
export const MAX_PIPS = 4;
/** How much health a fault took from its system, and gives back when mended. */
export const FAULT_HEALTH = 0.2;
export const MAX_FAULTS = 3;
/** Before an unattended voyage casts off by itself, s. */
export const BRIEFING_SECONDS = 90;
export const OVER_SECONDS = 20;
const FIRST_WAVE = 50;
export const RED_ALERT_RANGE = 2600;
/** No voyage leaves the sector's edge. */
const EDGE = 150;

export const SYSTEM_NAMES: Record<ShipSystem, string> = {
  [ShipSystem.Engines]: 'Engines',
  [ShipSystem.Weapons]: 'Weapons',
  [ShipSystem.Shields]: 'Shields',
  [ShipSystem.Sensors]: 'Sensors',
};

const PIP_KEYS = { [ShipSystem.Engines]: 'pEng', [ShipSystem.Weapons]: 'pWep', [ShipSystem.Shields]: 'pShd', [ShipSystem.Sensors]: 'pSen' } as const;
const HEALTH_KEYS = { [ShipSystem.Engines]: 'hEng', [ShipSystem.Weapons]: 'hWep', [ShipSystem.Shields]: 'hShd', [ShipSystem.Sensors]: 'hSen' } as const;

export function pips(s: ShipState, sys: ShipSystem): number {
  return s[PIP_KEYS[sys]];
}

export function health(s: ShipState, sys: ShipSystem): number {
  return s[HEALTH_KEYS[sys]];
}

function setHealth(s: ShipState, sys: ShipSystem, v: number): void {
  s[HEALTH_KEYS[sys]] = clamp(v, 0, 1);
}

/** How well a system's working: 1 at two pips and full health, up to 2 with every pip in it, nothing without power. */
export function efficiency(s: ShipState, sys: ShipSystem): number {
  return (pips(s, sys) / 2) * (0.2 + 0.8 * health(s, sys));
}

export function powerUsed(s: ShipState): number {
  return SYSTEMS.reduce((n, sys) => n + pips(s, sys), 0);
}

/** How far science's sensors reach, u. */
export function sensorRange(s: ShipState): number {
  return SENSOR_RANGE * clamp(efficiency(s, ShipSystem.Sensors), 0.3, 1.5);
}

/** Why the transporter can't be used now, or '' if it can. */
export function transporterBlocked(s: ShipState): string {
  if (s.phase !== Phase.Underway) return 'Not underway';
  if (!s.orbit) return 'Not in orbit';
  if (s.shieldsUp || s.shields > 0.5) return 'Shields are up';
  if (efficiency(s, ShipSystem.Sensors) < 0.05) return 'No sensor power';
  return '';
}

/** Why the phasers can't hit the target now, or ''. */
export function phaserBlocked(ship: ShipState, target: RaiderEntity | null): string {
  if (!target) return 'No target';
  if (ship.phaser < PHASER_MIN) return 'Charging';
  const d = Math.hypot(target.x - ship.x, target.y - ship.y);
  if (d > PHASER_RANGE) return 'Out of range';
  if (Math.abs(angleDiff(ship.heading, Math.atan2(target.y - ship.y, target.x - ship.x))) > PHASER_ARC) return 'Not in arc';
  return '';
}

/** A crew member standing on the transporter pad. */
export function onPad(c: CrewEntity): boolean {
  return c.render.mode === CrewMode.Up && Math.hypot(c.x - PAD.x, c.y - PAD.y) <= PAD.radius;
}

/**
 * The ship and its voyage: one migratable entity, run by whoever owns it. Docked at the starbase, the crew get to their
 * stations until helm casts off (or the briefing runs out). Underway, stations' `Console` commands fly it, fight with it
 * and run its systems, raiders come in waves, and science beams away teams down to planets for the relics. Bring every
 * relic home to the starbase to win; lose the hull and the ship's lost. Either way a new voyage starts a little later.
 */
export class ShipKeeper {
  private readonly one: Singleton<typeof Ship>;
  private torpTimer = 0;

  constructor(
    private readonly ctx: StarshipContext,
    private readonly torpedoes: Torpedoes,
  ) {
    const { dock } = ctx.sector;
    this.one = new Singleton(ctx.world, Ship, {
      init: () => ({ x: dock.x, y: dock.y, heading: dock.heading, course: dock.heading, docked: true, phase: Phase.Briefing, timer: BRIEFING_SECONDS, voyage: 1 }),
    });
  }

  get ship(): ShipEntity | null {
    return this.one.entity;
  }

  update(dt: number, now: number): void {
    const ship = this.one.update(now);
    if (ship?.mine) this.run(ship, dt);
  }

  private run(ship: ShipEntity, dt: number): void {
    const s = ship.state;
    switch (s.phase) {
      case Phase.Briefing:
        this.hold(s, dt);
        if (this.anyone()) s.timer = Math.max(0, s.timer - dt);
        else s.timer = BRIEFING_SECONDS;
        if (s.timer <= 0) this.castOff(ship);
        break;
      case Phase.Underway:
        s.timer += dt;
        this.fly(s, dt);
        this.systems(ship, dt);
        this.waves(ship, dt);
        if (s.docked && s.relics === allRelics(this.ctx.sector, s.voyage)) this.end(ship, Result.Victory);
        break;
      case Phase.Over:
        s.timer = Math.max(0, s.timer - dt);
        s.speed *= Math.exp(-dt);
        if (s.result === Result.Victory) this.hold(s, dt);
        else this.coast(s, dt);
        if (s.timer <= 0) this.reset(ship);
        break;
    }
  }

  private anyone(): boolean {
    const { world } = this.ctx;
    return world.all(Crew).size > 0 || world.all(Officer).size > 0;
  }

  // -------------------------------------------------------------------------
  // Orders from the stations
  // -------------------------------------------------------------------------

  /** A station's order, on the ship's owner. */
  console(ship: ShipEntity, act: Act, a: number, b: number, ref: number): void {
    const { ctx } = this;
    const s = ship.state;
    const over = s.phase === Phase.Over;
    switch (act) {
      case Act.Throttle:
        if (over || s.docked) return;
        s.throttle = clamp(a, -0.25, 1);
        if (Math.abs(s.throttle) > 0.05) this.leaveOrbit(s);
        break;
      case Act.Course:
        if (over) return;
        s.course = a;
        s.autopilot = false;
        this.leaveOrbit(s);
        break;
      case Act.Waypoint:
        s.wx = clamp(a, 0, SECTOR);
        s.wy = clamp(b, 0, SECTOR);
        s.waypoint = true;
        break;
      case Act.Autopilot:
        s.autopilot = a > 0.5 && s.waypoint;
        if (s.autopilot) this.leaveOrbit(s);
        break;
      case Act.AllStop:
        s.throttle = 0;
        s.autopilot = false;
        if (s.warp !== Warp.Warping) s.warp = Warp.Idle;
        break;
      case Act.Warp:
        if (s.warp !== Warp.Idle) {
          if (s.warp === Warp.Charging) s.warp = Warp.Idle;
          return;
        }
        if (over || s.docked || !s.waypoint || s.phase !== Phase.Underway) return;
        if (Math.hypot(s.wx - s.x, s.wy - s.y) < WARP_MIN || efficiency(s, ShipSystem.Engines) < 0.2) return;
        this.leaveOrbit(s);
        s.warp = Warp.Charging;
        s.warpT = 0;
        break;
      case Act.Orbit: {
        if (over || s.docked) return;
        if (s.orbit) {
          this.leaveOrbit(s);
          return;
        }
        const near = ctx.sector.nearestPlanet(s.x, s.y);
        if (near.surface > ORBIT_REACH || s.warp !== Warp.Idle) return;
        s.orbit = near.planet.index + 1;
        s.autopilot = false;
        s.throttle = 0;
        ctx.world.send(Feed, { text: `Standard orbit of ${near.planet.name}` }, { to: 'all' });
        const relicHere = ctx.sector.hasRelic(s.voyage, near.planet.index) && !(s.relics & (1 << near.planet.index));
        if (relicHere && s.nextWave > 30) s.nextWave = 22 + Math.random() * 10;
        break;
      }
      case Act.Dock: {
        if (over) return;
        if (s.docked) {
          if (s.phase === Phase.Briefing) this.castOff(ship);
          else this.undock(s);
          return;
        }
        const { starbase } = ctx.sector;
        if (Math.hypot(starbase.x - s.x, starbase.y - s.y) > DOCK_REACH || s.warp !== Warp.Idle) return;
        this.leaveOrbit(s);
        s.docked = true;
        s.throttle = 0;
        s.autopilot = false;
        s.shieldsUp = false;
        ctx.world.send(Noise, { kind: Sound.Dock, x: 0, y: 0, z: 0, ship: true }, { to: 'all' });
        ctx.world.send(Feed, { text: 'Docked at the starbase: repairs and torpedoes' }, { to: 'all' });
        break;
      }
      case Act.Target:
        s.target = ctx.world.getAs(Raider, ref) ? ref : 0;
        break;
      case Act.Phasers:
        this.phasers(ship);
        break;
      case Act.Torpedo:
        this.torpedo(ship);
        break;
      case Act.Shields:
        if (s.docked && a > 0.5) return;
        s.shieldsUp = a > 0.5;
        break;
      case Act.Scan:
        s.scanPlanet = 0;
        s.scanning = ctx.world.getAs(Raider, ref) && s.scanning !== ref ? ref : 0;
        s.scanT = 0;
        break;
      case Act.ScanPlanet: {
        const p = Math.round(a);
        s.scanning = 0;
        s.scanPlanet = s.scanPlanet === p + 1 || !ctx.sector.planets[p] ? 0 : p + 1;
        s.scanT = 0;
        break;
      }
      case Act.BeamDown:
      case Act.BeamUp:
      case Act.BeamRelic: {
        if (s.beam !== Beam.Idle || transporterBlocked(s)) return;
        const planet = s.orbit - 1;
        if (act === Act.BeamDown && ![...ctx.world.all(Crew)].some((c) => onPad(c as CrewEntity))) return;
        if (act === Act.BeamUp && !this.teamOn(planet).length) return;
        if (act === Act.BeamRelic && !this.relicOn(planet)) return;
        s.beam = act === Act.BeamDown ? Beam.Down : act === Act.BeamUp ? Beam.Up : Beam.Relic;
        s.beamT = 0;
        break;
      }
      case Act.BeamAbort:
        s.beam = Beam.Idle;
        s.beamT = 0;
        break;
      case Act.OnScreen:
        s.screen = clamp(Math.round(a), Screen.Forward, Screen.Away) as Screen;
        break;
      case Act.Power: {
        const sys = Math.round(a) as ShipSystem;
        if (!SYSTEMS.includes(sys)) return;
        const want = clamp(Math.round(b), 0, MAX_PIPS);
        const others = powerUsed(s) - pips(s, sys);
        s[PIP_KEYS[sys]] = Math.max(0, Math.min(want, POWER_POOL - others));
        break;
      }
      case Act.DamageControl: {
        const sys = Math.round(a);
        s.team = SYSTEMS.includes(sys as ShipSystem) && s.team !== sys ? sys : 255;
        break;
      }
      case Act.TakeTorpedo:
        if (s.torps > 0) s.torps--;
        break;
      case Act.LoadTube: {
        const bit = 1 << clamp(Math.round(a), 0, 1);
        if (s.tubes & bit || a < 0) s.torps = Math.min(MAX_TORPS + 2, s.torps + 1);
        else s.tubes |= bit;
        if (a >= 0) ctx.world.send(Noise, { kind: Sound.Load, x: 24, y: a < 0.5 ? 2.2 : 4.4, z: 1, ship: false }, { to: 'all' });
        break;
      }
    }
  }

  private leaveOrbit(s: ShipState): void {
    if (!s.orbit) return;
    s.orbit = 0;
    if (s.beam !== Beam.Idle) {
      s.beam = Beam.Idle;
      this.ctx.world.send(Feed, { text: 'Transporter lock lost: we left orbit' }, { to: 'all' });
    }
  }

  private undock(s: ShipState): void {
    s.docked = false;
    s.speed = 20;
    s.throttle = 0.2;
    this.ctx.world.send(Noise, { kind: Sound.Undock, x: 0, y: 0, z: 0, ship: true }, { to: 'all' });
  }

  /** Helm casts off from the starbase: the voyage begins. */
  private castOff(ship: ShipEntity): void {
    const { ctx } = this;
    const s = ship.state;
    s.phase = Phase.Underway;
    s.timer = 0;
    s.nextWave = FIRST_WAVE;
    s.waves = 0;
    this.undock(s);
    spawnSites(ctx, s.voyage);
    ctx.world.send(Feed, { text: `Voyage ${s.voyage}: three relics lie on the sector's worlds. Scan the planets to find them, bring them home` }, { to: 'all' });
  }

  // -------------------------------------------------------------------------
  // Flying
  // -------------------------------------------------------------------------

  /** Held at the dock. */
  private hold(s: ShipState, dt: number): void {
    const { dock } = this.ctx.sector;
    const k = Math.min(1, dt * 1.5);
    s.x += (dock.x - s.x) * k;
    s.y += (dock.y - s.y) * k;
    s.heading += angleDiff(s.heading, dock.heading) * k;
    s.speed = 0;
    s.throttle = 0;
  }

  private coast(s: ShipState, dt: number): void {
    s.x = clamp(s.x + Math.cos(s.heading) * s.speed * dt, 0, SECTOR);
    s.y = clamp(s.y + Math.sin(s.heading) * s.speed * dt, 0, SECTOR);
  }

  private fly(s: ShipState, dt: number): void {
    const { sector } = this.ctx;
    if (s.docked) {
      this.hold(s, dt);
      return;
    }
    const eng = efficiency(s, ShipSystem.Engines);
    if (s.orbit) {
      const p = sector.planets[s.orbit - 1];
      const a = Math.atan2(s.y - p.y, s.x - p.x) + (ORBIT_SPEED / p.orbit) * dt;
      const k = Math.min(1, dt * 0.8);
      s.x += (p.x + Math.cos(a) * p.orbit - s.x) * k;
      s.y += (p.y + Math.sin(a) * p.orbit - s.y) * k;
      s.heading += angleDiff(s.heading, a + Math.PI / 2) * Math.min(1, dt * 1.2);
      s.speed += (ORBIT_SPEED - s.speed) * k;
      s.course = s.heading;
      return;
    }

    if (s.warp === Warp.Warping) {
      const d = Math.hypot(s.wx - s.x, s.wy - s.y);
      s.heading += angleDiff(s.heading, Math.atan2(s.wy - s.y, s.wx - s.x)) * Math.min(1, dt * 4);
      s.speed = WARP_SPEED;
      if (d < 260 || d < s.speed * dt) {
        s.warp = Warp.Idle;
        s.speed = MAX_IMPULSE * 0.3;
        s.throttle = 0.25;
        s.autopilot = false;
        s.course = s.heading;
        this.ctx.world.send(Feed, { text: 'Dropping out of warp' }, { to: 'all' });
      }
    } else {
      const aim = s.warp === Warp.Charging || (s.autopilot && s.waypoint) ? Math.atan2(s.wy - s.y, s.wx - s.x) : s.course;
      const turn = TURN_RATE * clamp(eng, 0.25, 1.5) * dt;
      s.heading += clamp(angleDiff(s.heading, aim), -turn, turn);
      const max = MAX_IMPULSE * Math.min(1.5, eng);
      let want = s.throttle * max;
      if (s.autopilot && s.waypoint) {
        const d = Math.hypot(s.wx - s.x, s.wy - s.y);
        want = Math.min(want, d / 5);
        if (d < 120) {
          s.autopilot = false;
          s.throttle = 0;
          s.course = s.heading;
        }
      }
      const accel = ACCEL * clamp(eng, 0.3, 1.5) * dt;
      s.speed += clamp(want - s.speed, -accel, accel);
      if (s.warp === Warp.Charging) {
        s.warpT = Math.min(1, s.warpT + (dt / WARP_CHARGE) * clamp(eng, 0.25, 2));
        if (s.warpT >= 1 && Math.abs(angleDiff(s.heading, aim)) < 0.2) {
          s.warp = Warp.Warping;
          this.ctx.world.send(Noise, { kind: Sound.Warp, x: 0, y: 0, z: 0, ship: true }, { to: 'all' });
        }
      }
    }
    s.heading = ((s.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    s.x += Math.cos(s.heading) * s.speed * dt;
    s.y += Math.sin(s.heading) * s.speed * dt;
    if (s.x < EDGE || s.y < EDGE || s.x > SECTOR - EDGE || s.y > SECTOR - EDGE) {
      s.x = clamp(s.x, EDGE, SECTOR - EDGE);
      s.y = clamp(s.y, EDGE, SECTOR - EDGE);
      if (s.warp === Warp.Warping) s.warp = Warp.Idle;
      s.speed = Math.min(s.speed, 20);
    }
    // planets are solid
    const near = sector.nearestPlanet(s.x, s.y);
    if (near.surface < 40) {
      const p = near.planet;
      const a = Math.atan2(s.y - p.y, s.x - p.x);
      s.x = p.x + Math.cos(a) * (p.radius + 40);
      s.y = p.y + Math.sin(a) * (p.radius + 40);
      s.speed *= 0.3;
      if (s.warp === Warp.Warping) s.warp = Warp.Idle;
    }
  }

  // -------------------------------------------------------------------------
  // Systems: shields, weapons, sensors, the transporter, repairs
  // -------------------------------------------------------------------------

  private systems(ship: ShipEntity, dt: number): void {
    const { ctx } = this;
    const s = ship.state;
    const wep = efficiency(s, ShipSystem.Weapons);
    const shd = efficiency(s, ShipSystem.Shields);
    const sen = efficiency(s, ShipSystem.Sensors);

    if (s.shieldsUp && shd > 0.01) s.shields = Math.min(SHIELD_MAX, s.shields + SHIELD_REGEN * shd * dt);
    else s.shields = Math.max(0, s.shields - 40 * dt);

    s.phaser = Math.min(1, s.phaser + (dt / PHASER_CHARGE) * clamp(wep, 0, 2));
    if (s.tubes !== 3 && s.torps > 0) {
      s.loadT += (dt / AUTOLOAD) * clamp(wep, 0, 2);
      if (s.loadT >= 1) {
        s.loadT = 0;
        s.tubes |= s.tubes & 1 ? 2 : 1;
        s.torps--;
      }
    } else {
      s.loadT = 0;
    }
    if (s.docked) {
      s.hull = Math.min(100, s.hull + 4 * dt);
      for (const sys of SYSTEMS) setHealth(s, sys, health(s, sys) + 0.03 * dt);
      this.torpTimer += dt;
      if (this.torpTimer > 2 && s.torps < MAX_TORPS) {
        this.torpTimer = 0;
        s.torps++;
      }
    }

    // fires burn their systems down
    const faults = ctx.world.all(Fault) as ReadonlySet<FaultEntity>;
    for (const f of faults) if (f.render.voyage === s.voyage && f.render.kind === FaultKind.Fire) setHealth(s, f.render.system, health(s, f.render.system) - 0.006 * dt);

    // the damage control team: slower than crew, but tireless
    if (s.team !== 255) {
      const sys = s.team as ShipSystem;
      let fault: FaultEntity | null = null;
      for (const f of faults) if (f.render.voyage === s.voyage && f.render.system === sys) fault = f;
      if (fault) ctx.world.command(Mend, { target: fault.id, amount: dt / 14 });
      else if (health(s, sys) < 1) setHealth(s, sys, health(s, sys) + 0.006 * dt);
      else {
        s.team = 255;
        ctx.world.send(Feed, { text: `Damage control: ${SYSTEM_NAMES[sys].toLowerCase()} repaired` }, { to: 'all' });
      }
    }

    // red alert while raiders are about
    let alert = false;
    for (const r of ctx.world.all(Raider)) if (Math.hypot(r.x - s.x, r.y - s.y) < RED_ALERT_RANGE) alert = true;
    s.alert = alert;
    if (s.target && !ctx.world.getAs(Raider, s.target)) s.target = 0;
    // with nothing targeted, the nearest raider closing in is
    if (!s.target) {
      let best = PHASER_RANGE * 1.5;
      for (const r of ctx.world.all(Raider)) {
        const d = Math.hypot(r.x - s.x, r.y - s.y);
        if (d < best) {
          best = d;
          s.target = r.id;
        }
      }
    }

    this.scan(s, dt, sen);
    this.transporter(s, dt, sen);
  }

  private scan(s: ShipState, dt: number, sen: number): void {
    const { ctx } = this;
    if (!s.scanning && !s.scanPlanet) return;
    const raider = s.scanning ? (ctx.world.getAs(Raider, s.scanning) as RaiderEntity | undefined) : undefined;
    const planet = s.scanPlanet ? ctx.sector.planets[s.scanPlanet - 1] : undefined;
    const at = raider ?? planet;
    if (!at || Math.hypot(at.x - s.x, at.y - s.y) > sensorRange(s) + (planet?.radius ?? 0) || sen < 0.05) {
      s.scanning = 0;
      s.scanPlanet = 0;
      s.scanT = 0;
      return;
    }
    s.scanT = Math.min(1, s.scanT + (dt / SCAN_TIME) * clamp(sen, 0.2, 2));
    if (s.scanT < 1) return;
    if (raider) {
      ctx.world.command(Scanned, { target: raider.id });
      ctx.world.send(Feed, { text: "Scan complete: the raider's shield harmonics are on tactical's board" }, { to: 'all' });
    } else if (planet) {
      s.surveyed |= 1 << planet.index;
      const has = ctx.sector.hasRelic(s.voyage, planet.index);
      const home = s.relics & (1 << planet.index);
      ctx.world.send(Feed, { text: `${planet.name}: ${home ? 'relic already aboard' : has ? 'RELIC SIGNATURE on the surface, and drones guarding it' : 'nothing of interest'}` }, { to: 'all' });
    }
    ctx.world.send(Noise, { kind: Sound.Scan, x: 0, y: 0, z: 0, ship: true }, { to: 'all' });
    s.scanning = 0;
    s.scanPlanet = 0;
    s.scanT = 0;
  }

  private transporter(s: ShipState, dt: number, sen: number): void {
    const { ctx } = this;
    if (s.beam === Beam.Idle) return;
    const blocked = transporterBlocked(s);
    if (blocked) {
      s.beam = Beam.Idle;
      s.beamT = 0;
      ctx.world.send(Feed, { text: `Transporter lock lost: ${blocked.toLowerCase()}` }, { to: 'all' });
      return;
    }
    const planet = s.orbit - 1;
    const time = s.beam === Beam.Relic ? RELIC_BEAM_TIME : BEAM_TIME;
    s.beamT = Math.min(1, s.beamT + (dt / time) * clamp(sen, 0.25, 1.5));
    if (s.beamT < 1) return;
    const { world, deck } = ctx;
    const site = deck.sites[planet];
    let n = 0;
    switch (s.beam) {
      case Beam.Down:
        for (const c of world.all(Crew) as ReadonlySet<CrewEntity>) {
          if (!onPad(c)) continue;
          const at = deck.clearNear(site.arrive.x + ((n % 3) - 1) * 1.2, site.arrive.y + Math.floor(n / 3) * 1.2);
          world.command(Transport, { target: c.id, x: at.x, y: at.y });
          n++;
        }
        break;
      case Beam.Up:
        for (const c of this.teamOn(planet)) {
          const a = (n / 4) * Math.PI * 2;
          world.command(Transport, { target: c.id, x: PAD.x + Math.cos(a) * 0.7, y: PAD.y + Math.sin(a) * 0.7 });
          n++;
        }
        break;
      case Beam.Relic: {
        const relic = this.relicOn(planet);
        if (relic) world.command(Transport, { target: relic.id, x: PAD.x, y: PAD.y });
        break;
      }
    }
    world.send(Noise, { kind: Sound.Beam, x: PAD.x, y: PAD.y, z: 1, ship: false }, { to: 'all' });
    s.beam = Beam.Idle;
    s.beamT = 0;
  }

  /** Crew on a planet's surface. */
  teamOn(planet: number): CrewEntity[] {
    const { world, deck } = this.ctx;
    return ([...world.all(Crew)] as CrewEntity[]).filter((c) => !deck.onShip(c.x) && deck.siteAt(c.x) === planet);
  }

  /** The relic lying on a planet's surface, if nobody's carrying it. */
  relicOn(planet: number): RelicEntity | null {
    for (const r of this.ctx.world.all(Relic) as ReadonlySet<RelicEntity>) if (r.render.site === planet + 1 && !r.render.carrier) return r;
    return null;
  }

  private phasers(ship: ShipEntity): void {
    const { world } = this.ctx;
    const s = ship.state;
    if (s.phase !== Phase.Underway) return;
    const target = (world.getAs(Raider, s.target) as RaiderEntity | undefined) ?? null;
    if (phaserBlocked(s, target)) return;
    const amount = PHASER_DAMAGE * s.phaser * (target!.render.scanned ? WEAKNESS : 1);
    world.command(Damage, { target: target!.id, amount, x: s.x, y: s.y });
    world.send(Beam3, { kind: Shot.Phaser, x: s.x, y: s.y, z: 0, tx: target!.x, ty: target!.y, tz: 0, hit: true }, { to: 'all' });
    s.phaser = 0;
    s.hits = (s.hits + 1) % 256;
  }

  private torpedo(ship: ShipEntity): void {
    const s = ship.state;
    if (s.phase !== Phase.Underway || s.docked || !s.tubes) return;
    s.tubes &= s.tubes & 1 ? ~1 : ~2;
    this.torpedoes.launch(s.x + Math.cos(s.heading) * 30, s.y + Math.sin(s.heading) * 30, s.heading, s.target, false);
  }

  // -------------------------------------------------------------------------
  // Getting hurt
  // -------------------------------------------------------------------------

  /** Damage to the ship, on its owner: the shields take what they can, the hull the rest, and hull hits break things. */
  damage(ship: ShipEntity, amount: number, fromX: number, fromY: number): void {
    const { ctx } = this;
    const s = ship.state;
    if (s.phase !== Phase.Underway || s.docked) return;
    let through = amount;
    if (s.shieldsUp && s.shields > 0) {
      const cost = amount / clamp(efficiency(s, ShipSystem.Shields), 0.5, 2);
      if (cost <= s.shields) {
        s.shields -= cost;
        through = 0;
      } else {
        through = (cost - s.shields) * clamp(efficiency(s, ShipSystem.Shields), 0.5, 2);
        s.shields = 0;
      }
    }
    s.hull = Math.max(0, s.hull - through);
    ctx.world.send(Jolt, { amount, shielded: through === 0, x: fromX, y: fromY }, { to: 'all' });
    if (through >= 3) this.breakSomething(s, through);
    if (s.hull <= 0) this.end(ship, Result.Lost);
  }

  private breakSomething(s: ShipState, amount: number): void {
    const { ctx } = this;
    const sys = SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)];
    let faults = 0;
    for (const f of ctx.world.all(Fault)) if (f.render.voyage === s.voyage && f.render.system === sys) faults++;
    if (faults >= MAX_FAULTS || Math.random() > 0.35 + amount * 0.03) {
      setHealth(s, sys, health(s, sys) - Math.min(0.1, amount * 0.006));
      return;
    }
    setHealth(s, sys, health(s, sys) - FAULT_HEALTH);
    const spots = ctx.deck.faultSpots[sys];
    const spot = spots[Math.floor(Math.random() * spots.length)];
    const kind = Math.random() < 0.35 ? FaultKind.Fire : FaultKind.Sparks;
    ctx.world.spawn(Fault, { x: spot.x + (Math.random() - 0.5) * 0.6, y: spot.y + (Math.random() - 0.5) * 0.6, z: kind === FaultKind.Fire ? 0 : 0.6 + Math.random() * 1.2, system: sys, kind, left: 1, voyage: s.voyage });
    ctx.world.send(Feed, { text: `${kind === FaultKind.Fire ? 'Fire' : 'Damage'} in the ${SYSTEM_NAMES[sys] === 'Weapons' ? 'torpedo room' : SYSTEM_NAMES[sys].toLowerCase() + ' room'}!` }, { to: 'all' });
  }

  private end(ship: ShipEntity, result: Result): void {
    const { ctx } = this;
    const s = ship.state;
    const minutes = Math.max(1, Math.round(s.timer / 60));
    s.phase = Phase.Over;
    s.result = result;
    s.timer = OVER_SECONDS;
    s.warp = Warp.Idle;
    s.beam = Beam.Idle;
    s.alert = false;
    if (result === Result.Lost) {
      ctx.world.send(Boom, { x: s.x, y: s.y, size: 3 }, { to: 'all' });
      ctx.world.send(Feed, { text: 'The ship is lost with all hands' }, { to: 'all' });
    } else {
      ctx.world.send(Feed, { text: `Every relic is home after ${minutes} minutes. Well done, crew` }, { to: 'all' });
    }
  }

  /** A fresh ship at the starbase for the next voyage. Crew aboard it are put back on the bridge by their own peers. */
  private reset(ship: ShipEntity): void {
    const { dock } = this.ctx.sector;
    Object.assign(ship.state, {
      x: dock.x,
      y: dock.y,
      heading: dock.heading,
      course: dock.heading,
      speed: 0,
      throttle: 0,
      autopilot: false,
      waypoint: false,
      warp: Warp.Idle,
      warpT: 0,
      orbit: 0,
      docked: true,
      hull: 100,
      shields: 0,
      shieldsUp: false,
      phaser: 1,
      tubes: 3,
      torps: MAX_TORPS,
      loadT: 0,
      target: 0,
      scanning: 0,
      scanPlanet: 0,
      scanT: 0,
      surveyed: 0,
      beam: Beam.Idle,
      beamT: 0,
      screen: Screen.Forward,
      pEng: 2,
      pWep: 2,
      pShd: 2,
      pSen: 2,
      hEng: 1,
      hWep: 1,
      hShd: 1,
      hSen: 1,
      team: 255,
      phase: Phase.Briefing,
      result: Result.None,
      voyage: ship.state.voyage + 1,
      timer: BRIEFING_SECONDS,
      nextWave: FIRST_WAVE,
      waves: 0,
      relics: 0,
      alert: false,
    } satisfies Partial<ShipState>);
  }

  private waves(ship: ShipEntity, dt: number): void {
    const s = ship.state;
    if (s.docked || s.warp === Warp.Warping) return;
    s.nextWave -= dt;
    if (s.nextWave > 0) return;
    s.nextWave = 75 + Math.random() * 45;
    const size = Math.min(4, 1 + Math.floor(s.waves / 2) + bitCount(s.relics));
    if (spawnWave(this.ctx, s, size) > 0) s.waves++;
  }
}

/** Where a crew member goes at the start of a voyage, or when carried off hurt: the back of the bridge. */
export function bridgeSpot(i: number): { x: number; y: number } {
  return { x: SPAWN.x - 0.3 * (i % 3), y: SPAWN.y + ((i % 5) - 2) * 0.7 };
}

/** The console someone at a spot is standing at, if any. */
export function consoleAt(x: number, y: number, reach = 1.4): (typeof CONSOLES)[number] | null {
  let best: (typeof CONSOLES)[number] | null = null;
  let bd = reach;
  for (const c of CONSOLES) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
