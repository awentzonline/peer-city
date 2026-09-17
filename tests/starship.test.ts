import { describe, expect, it } from 'vitest';
import type { NetWorld } from '../src/engine/net/world';
import { Platform } from '../src/crossplay/platform';
import { NO_PRESENTER, registerActions } from '../src/starship/actions';
import type { CrewEntity, FaultEntity, RaiderEntity, RelicEntity, SentinelEntity, ShipEntity, StarshipContext } from '../src/starship/context';
import { CrewRole, SEAT_BACK, type CrewBody } from '../src/starship/crew';
import { CELL, CONSOLES, Deck, MACHINES, PAD, RACK, SPAWN, TUBES, Tile } from '../src/starship/deck';
import { ACTIONS, Act, Beam, Carry, CrewMode, ENTITIES, Fault, FaultKind, Phase, Raider, RaiderKind, Relic, Result, Screen, Sentinel, ShipSystem, Station, STATIONS, SYSTEMS } from '../src/starship/defs';
import { DESK, LEAVE_BOX, SCOPE_BOX, deskLayout, stationControls, within, type Key, type Slider } from '../src/starship/consoleVr';
import { Torpedoes } from '../src/starship/flights';
import { stepRules } from '../src/starship/frame';
import { act, idleCrewIntent, idleOfficerIntent, stillCrew, type CrewIntent, type OfficerIntent } from '../src/starship/intent';
import { EXTINGUISHER, PHASER, SPANNER } from '../src/starship/kit';
import { OfficerRole } from '../src/starship/officer';
import { BRIEFING_SECONDS, MAX_IMPULSE, OVER_SECONDS, POWER_POOL, ShipKeeper, efficiency, health, pips, transporterBlocked } from '../src/starship/ship';
import { engineeringScope, helmScope, scienceScope, scopeFor, tacticalScope } from '../src/starship/scopes';
import { RELIC_COUNT, Sector, allRelics } from '../src/starship/sector';
import { Sim } from './harness';

const sector = new Sector(4077);
const deck = new Deck(4077);
const stub = () => new Proxy({}, { get: () => () => {} });

class TestCrewBody implements CrewBody {
  platform = Platform.Desktop;
  hurts = 0;
  downs = 0;
  beams: boolean[] = [];
  fixes: FaultKind[] = [];
  seats: (Station | null)[] = [];
  moved(): void {}
  placed(): void {}
  hurt(): void {
    this.hurts++;
  }
  used(): void {}
  died(): void {}
  downed(): void {
    this.downs++;
  }
  revived(): void {}
  beamed(aboard: boolean): void {
    this.beams.push(aboard);
  }
  seated(station: Station | null): void {
    this.seats.push(station);
  }
  fixed(kind: FaultKind): void {
    this.fixes.push(kind);
  }
  carrying(): void {}
  restarted(): void {}
}

interface Peer {
  ctx: StarshipContext;
  world: NetWorld;
  keeper: ShipKeeper;
  torpedoes: Torpedoes;
  officer?: OfficerRole;
  intent?: OfficerIntent;
  crew?: CrewRole;
  body?: TestCrewBody;
  cintent?: CrewIntent;
}

function peer(net: Sim, id: string, role: 'officer' | 'crew' | 'none'): Peer {
  const world = net.add(id, { worldId: 'starship-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 65536, cellSize: 65536, interestRadius: 20000, spatialCellSize: 24 });
  let keeper!: ShipKeeper;
  const ctx = {
    world,
    sector,
    deck,
    sfx: stub() as never,
    hud: stub() as never,
    settings: { open: false } as never,
    fx: { torpedo() {}, torpedoGone() {} },
    torpedoes: null as never,
    ship: () => keeper.ship,
    me: null,
    officer: null,
    playerName: id,
    now: net.now,
  } as StarshipContext;
  const torpedoes = (ctx.torpedoes = new Torpedoes(ctx));
  keeper = new ShipKeeper(ctx, torpedoes);
  const p: Peer = { ctx, world, keeper, torpedoes };
  if (role === 'officer') {
    p.officer = new OfficerRole(ctx);
    p.intent = idleOfficerIntent(Station.Helm);
    p.officer.spawn(Station.Helm);
  } else if (role === 'crew') {
    p.crew = new CrewRole(ctx);
    p.body = new TestCrewBody();
    p.crew.attach(p.body);
    p.cintent = idleCrewIntent();
    p.crew.spawn();
  }
  registerActions(ctx, keeper, torpedoes, p.crew ?? null, NO_PRESENTER);
  return p;
}

function frame(p: Peer, now: number, dt: number): void {
  p.ctx.now = now;
  if (p.officer) {
    p.officer.update(dt, p.intent!);
    p.intent!.acts.length = 0;
  }
  if (p.crew) {
    p.crew.update(dt, p.cintent!);
    const { strafe, forward, trigger } = p.cintent!;
    stillCrew(p.cintent!);
    // held controls stay held; presses last a frame
    Object.assign(p.cintent!, { strafe, forward, trigger });
  }
  stepRules(p.ctx, p.keeper, p.torpedoes, dt, now);
}

function run(net: Sim, peers: Peer[], ms: number, each?: (now: number) => void): void {
  net.run(
    ms,
    (now) => {
      each?.(now);
      for (const p of peers) frame(p, now, 1 / 60);
    },
    1000 / 60,
  );
}

function shipOf(p: Peer): ShipEntity {
  return p.keeper.ship!;
}

/** The peer that runs the ship (and, with one cell, every migratable thing). */
function owner(peers: Peer[]): Peer {
  return peers.find((p) => p.keeper.ship?.mine)!;
}

/** Give an order from the officer's station, and let it arrive. */
function orderFrom(net: Sim, peers: Peer[], officer: Peer, a: ReturnType<typeof act>, ms = 200): void {
  officer.intent!.acts.push(a);
  run(net, peers, ms);
}

/** Two peers, the ship known to both, settled on its owner (tests write its state there), and underway. */
function underway(): { net: Sim; o: Peer; c: Peer; peers: Peer[] } {
  const net = new Sim();
  const o = peer(net, 'a', 'officer');
  const c = peer(net, 'b', 'crew');
  const peers = [o, c];
  run(net, peers, 7000);
  orderFrom(net, peers, o, act(Act.Dock));
  expect(shipOf(o).render.phase).toBe(Phase.Underway);
  return { net, o, c, peers };
}

/** Walk the floor from a point: every cell reachable. */
function reachable(d: Deck, x: number, y: number): Uint8Array {
  const seen = new Uint8Array(d.cols * d.rows);
  const stack = [Math.floor(y / CELL) * d.cols + Math.floor(x / CELL)];
  seen[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const cx = i % d.cols;
    const cy = (i - cx) / d.cols;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= d.cols || ny >= d.rows) continue;
      const j = ny * d.cols + nx;
      if (seen[j] || d.tiles[j] !== Tile.Floor) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}

const at = (d: Deck, seen: Uint8Array, x: number, y: number) => seen[Math.floor(y / CELL) * d.cols + Math.floor(x / CELL)] === 1;

describe('The sector and the decks', () => {
  it('are the same for the same seed, with three relic worlds a voyage', () => {
    expect(new Sector(4077).planets).toEqual(sector.planets);
    expect(new Deck(4077).tiles).toEqual(deck.tiles);
    for (const v of [1, 2, 3]) {
      const relics = sector.relicPlanets(v);
      expect(new Set(relics).size).toBe(RELIC_COUNT);
    }
    for (const p of sector.planets) expect(Math.hypot(p.x - sector.starbase.x, p.y - sector.starbase.y)).toBeGreaterThan(2000);
  });

  it('let crew walk from the bridge to every console, the pad, the rack, the tubes and every fault spot, and on each site from the arrival to the plinth', () => {
    const seen = reachable(deck, SPAWN.x, SPAWN.y);
    for (const c of CONSOLES) expect(at(deck, seen, c.x - Math.cos(c.heading) * SEAT_BACK, c.y - Math.sin(c.heading) * SEAT_BACK), `console ${c.station}`).toBe(true);
    expect(at(deck, seen, PAD.x, PAD.y)).toBe(true);
    expect(at(deck, seen, RACK.x, RACK.y + 1.1)).toBe(true);
    for (const t of TUBES) expect(at(deck, seen, t.x - 0.5, t.y)).toBe(true);
    for (const sys of SYSTEMS) {
      for (const s of deck.faultSpots[sys]) expect(at(deck, seen, s.x, s.y), `fault spot ${sys} ${s.x},${s.y}`).toBe(true);
      expect(deck.tile(MACHINES[sys].x, MACHINES[sys].y)).toBe(Tile.Object);
    }
    for (const site of deck.sites) {
      const s = reachable(deck, site.arrive.x, site.arrive.y);
      expect(at(deck, s, site.plinth.x, site.plinth.y + 1.5)).toBe(true);
      // and nowhere on a site reaches the ship
      expect(at(deck, s, SPAWN.x, SPAWN.y)).toBe(false);
    }
  });
});

describe('Flying the ship', () => {
  it('waits docked until helm casts off, then flies where the throttle and course say', () => {
    const net = new Sim();
    const o = peer(net, 'a', 'officer');
    const peers = [o];
    run(net, peers, 4500);
    const ship = shipOf(o);
    expect(ship.render.phase).toBe(Phase.Briefing);
    expect(ship.render.docked).toBe(true);
    expect(ship.render.timer).toBeLessThan(BRIEFING_SECONDS);
    // the throttle does nothing while docked
    orderFrom(net, peers, o, act(Act.Throttle, 1));
    expect(ship.render.throttle).toBe(0);
    orderFrom(net, peers, o, act(Act.Dock));
    expect(ship.render.phase).toBe(Phase.Underway);
    expect(ship.render.docked).toBe(false);
    // relics and their guards are down on the relic worlds
    expect(o.world.all(Relic).size).toBe(RELIC_COUNT);
    expect(o.world.all(Sentinel).size).toBeGreaterThanOrEqual(RELIC_COUNT * 2);

    const x0 = ship.render.x;
    orderFrom(net, peers, o, act(Act.Throttle, 1));
    orderFrom(net, peers, o, act(Act.Course, Math.PI / 2));
    run(net, peers, 6000);
    expect(ship.render.speed).toBeGreaterThan(MAX_IMPULSE * 0.9);
    expect(ship.render.heading).toBeCloseTo(Math.PI / 2, 1);
    expect(ship.render.y).toBeGreaterThan(sector.dock.y + 300);
    expect(Math.abs(ship.render.x - x0)).toBeLessThan(400);

    // more power to the engines flies faster, but only from the pool
    orderFrom(net, peers, o, act(Act.Power, ShipSystem.Engines, 4));
    expect(pips(ship.render, ShipSystem.Engines)).toBe(2);
    orderFrom(net, peers, o, act(Act.Power, ShipSystem.Sensors, 0));
    orderFrom(net, peers, o, act(Act.Power, ShipSystem.Engines, 4));
    expect(pips(ship.render, ShipSystem.Engines)).toBe(4);
    orderFrom(net, peers, o, act(Act.Power, ShipSystem.Weapons, 4));
    expect(pips(ship.render, ShipSystem.Weapons)).toBe(POWER_POOL - 4 - 2 - 0);
    run(net, peers, 3000);
    expect(ship.render.speed).toBeGreaterThan(MAX_IMPULSE * 1.3);
  });

  it('warps to the waypoint once the drive has charged, and takes up orbit near a planet', () => {
    const { net, o, peers } = underway();
    const ship = shipOf(o);
    const planet = sector.planets[0];
    const a = Math.atan2(sector.dock.y - planet.y, sector.dock.x - planet.x);
    orderFrom(net, peers, o, act(Act.Waypoint, planet.x + Math.cos(a) * (planet.radius + 400), planet.y + Math.sin(a) * (planet.radius + 400)));
    orderFrom(net, peers, o, act(Act.Warp));
    expect(ship.render.warp).toBeGreaterThan(0);
    run(net, peers, 12000);
    expect(ship.render.warp).toBe(0);
    const near = sector.nearestPlanet(ship.render.x, ship.render.y);
    expect(near.planet.index).toBe(0);
    expect(near.surface).toBeLessThan(700);
    orderFrom(net, peers, o, act(Act.Orbit));
    expect(ship.render.orbit).toBe(1);
    run(net, peers, 5000);
    const d = Math.hypot(ship.render.x - planet.x, ship.render.y - planet.y);
    expect(Math.abs(d - planet.orbit)).toBeLessThan(60);
    // any helm order takes it out of orbit again
    orderFrom(net, peers, o, act(Act.Throttle, 0.5));
    expect(ship.render.orbit).toBe(0);
  });
});

/** Put the ship in orbit of a relic world, shields down. */
function orbitRelicWorld(net: Sim, peers: Peer[], o: Peer): number {
  const planet = sector.relicPlanets(shipOf(o).render.voyage)[0];
  const p = sector.planets[planet];
  const s = shipOf(owner(peers)).state;
  s.x = p.x + p.orbit;
  s.y = p.y;
  s.speed = 0;
  run(net, peers, 300);
  orderFrom(net, peers, o, act(Act.Orbit));
  expect(shipOf(o).render.orbit).toBe(planet + 1);
  return planet;
}

function placeCrew(p: Peer, x: number, y: number, heading = 0): void {
  const s = p.ctx.me!.state;
  s.x = x;
  s.y = y;
  p.crew!.heading = heading;
  p.crew!.pitch = 0;
}

describe('Away missions', () => {
  it('beam crew on the pad down to the planet only with the shields down, and back up with the relic', () => {
    const { net, o, c, peers } = underway();
    const planet = orbitRelicWorld(net, peers, o);
    const ship = shipOf(o);
    const me = c.ctx.me!;
    placeCrew(c, PAD.x, PAD.y);
    run(net, peers, 300);

    // shields up: no transport
    orderFrom(net, peers, o, act(Act.Shields, 1), 1500);
    expect(transporterBlocked(ship.render)).toBe('Shields are up');
    orderFrom(net, peers, o, act(Act.BeamDown));
    expect(ship.render.beam).toBe(Beam.Idle);
    orderFrom(net, peers, o, act(Act.Shields, 0), 3500);
    expect(transporterBlocked(ship.render)).toBe('');

    orderFrom(net, peers, o, act(Act.BeamDown));
    expect(ship.render.beam).toBe(Beam.Down);
    run(net, peers, 3500);
    expect(deck.onShip(me.state.x)).toBe(false);
    expect(deck.siteAt(me.state.x)).toBe(planet);
    expect(c.body!.beams).toEqual([false]);

    // walk up to the relic and take it
    const site = deck.sites[planet];
    const relic = [...c.world.all(Relic)].find((r) => r.render.site === planet + 1) as RelicEntity;
    // keep the drones out of it
    for (const e of [...owner(peers).world.owned(Sentinel)]) owner(peers).world.despawn(e);
    placeCrew(c, site.plinth.x, site.plinth.y - 1.2, Math.PI / 2);
    run(net, peers, 300);
    expect(c.crew!.nearby?.kind).toBe('relic');
    c.cintent!.use = true;
    run(net, peers, 600);
    expect(relic.render.carrier).toBe(me.id);
    expect(me.state.carry).toBe(Carry.Relic);

    orderFrom(net, peers, o, act(Act.BeamUp));
    expect(ship.render.beam).toBe(Beam.Up);
    run(net, peers, 4000);
    expect(deck.onShip(me.state.x)).toBe(true);
    expect(Math.hypot(me.state.x - PAD.x, me.state.y - PAD.y)).toBeLessThan(PAD.radius);
    expect(me.state.carry).toBe(Carry.Nothing);
    expect(ship.render.relics).toBe(1 << planet);
    expect(relic.alive).toBe(false);
  });

  it('can beam a relic up on its own, slowly, through the interference', () => {
    const { net, o, peers } = underway();
    const planet = orbitRelicWorld(net, peers, o);
    const ship = shipOf(o);
    orderFrom(net, peers, o, act(Act.BeamRelic));
    expect(ship.render.beam).toBe(Beam.Relic);
    run(net, peers, 10000);
    expect(ship.render.relics).toBe(0);
    run(net, peers, 17000);
    expect(ship.render.relics).toBe(1 << planet);
  });

  it('lets the away team shoot down the drones guarding a relic, which shoot back', () => {
    const { net, o, c, peers } = underway();
    const planet = orbitRelicWorld(net, peers, o);
    const site = deck.sites[planet];
    const run0 = owner(peers);
    const drones = () => ([...run0.world.all(Sentinel)] as SentinelEntity[]).filter((e) => e.render.site === planet + 1);
    // one drone, hovering in the open in front of the crew member
    for (const d of drones().slice(1)) run0.world.despawn(d);
    const drone = drones()[0];
    placeCrew(c, site.arrive.x, site.arrive.y, Math.PI / 2);
    const at = deck.clearNear(site.arrive.x, site.arrive.y + 8);
    Object.assign(drone.state, { x: at.x, y: at.y, tx: at.x, ty: at.y, cooldown: 0 });
    run(net, peers, 1500);
    expect(drone.render.target).toBe(c.ctx.me!.id);
    expect(drone.render.shots).toBeGreaterThan(0);
    const me = c.ctx.me!.state;
    c.crew!.heading = Math.atan2(drone.y - me.y, drone.x - me.x);
    c.crew!.pitch = Math.atan2(drone.render.z - 1.65, Math.hypot(drone.x - me.x, drone.y - me.y));
    c.cintent!.selectTool = PHASER;
    for (let i = 0; i < 12 && drone.alive; i++) {
      c.crew!.heading = Math.atan2(drone.y - me.y, drone.x - me.x);
      c.crew!.pitch = Math.atan2(drone.render.z - 1.65, Math.hypot(drone.x - me.x, drone.y - me.y));
      c.cintent!.trigger = true;
      run(net, peers, 100);
      c.cintent!.trigger = false;
      run(net, peers, 300);
    }
    expect(drone.alive).toBe(false);
  });

  it("puts a crew member who's shot down back in sickbay a few seconds later", () => {
    const { net, o, c, peers } = underway();
    const planet = orbitRelicWorld(net, peers, o);
    const site = deck.sites[planet];
    placeCrew(c, site.arrive.x, site.arrive.y);
    run(net, peers, 300);
    c.crew!.wound(150);
    expect(c.ctx.me!.state.mode).toBe(CrewMode.Down);
    expect(c.body!.downs).toBe(1);
    run(net, peers, 8000);
    expect(c.ctx.me!.state.mode).toBe(CrewMode.Up);
    expect(deck.onShip(c.ctx.me!.state.x)).toBe(true);
  });
});

describe('Fighting', () => {
  it("hurts a targeted raider with the phasers, more once science has scanned it, and the raider's hits break the ship's systems", () => {
    const { net, o, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    // get clear of the starbase's guns
    Object.assign(ship.state, { x: 2000, y: 2000, heading: 0, course: 0, speed: 0 });
    run(net, peers, 300);
    const r = run0.world.spawn(Raider, { x: 2500, y: 2000, heading: Math.PI, kind: RaiderKind.Fighter, hp: 60, shields: 30, voyage: ship.state.voyage, cooldown: 99 }) as RaiderEntity;
    run(net, peers, 300);
    orderFrom(net, peers, o, act(Act.Target, 0, 0, r.id));
    expect(ship.render.target).toBe(r.id);
    const before = r.state.hp + r.state.shields;
    orderFrom(net, peers, o, act(Act.Phasers));
    const plain = before - (r.state.hp + r.state.shields);
    expect(plain).toBeGreaterThan(15);
    expect(ship.render.phaser).toBeLessThan(0.2);

    orderFrom(net, peers, o, act(Act.Scan, 0, 0, r.id));
    run(net, peers, 4500);
    expect(r.state.scanned).toBe(true);
    Object.assign(r.state, { x: 2500, y: 2000, speed: 0 });
    run(net, peers, 200);
    const mid = r.state.hp + r.state.shields;
    orderFrom(net, peers, o, act(Act.Phasers));
    expect(mid - (r.state.hp + r.state.shields)).toBeGreaterThan(plain * 1.3);

    // the raider shoots back at a ship with no shields
    r.state.cooldown = 0;
    r.state.heading = Math.PI;
    Object.assign(r.state, { x: 2400, y: 2000 });
    const hull = ship.state.hull;
    for (let i = 0; i < 12; i++) {
      r.state.cooldown = 0;
      Object.assign(r.state, { x: 2400, y: 2000, heading: Math.PI, hp: 60 });
      run(net, peers, 200);
    }
    expect(ship.state.hull).toBeLessThan(hull);
  });

  it('fires torpedoes from loaded tubes, which home on the target', () => {
    const { net, o, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    Object.assign(ship.state, { x: 2000, y: 2000, heading: 0, course: 0, speed: 0 });
    run(net, peers, 300);
    const r = run0.world.spawn(Raider, { x: 2700, y: 2150, heading: 0, speed: 0, kind: RaiderKind.Cruiser, hp: 170, shields: 90, voyage: ship.state.voyage, cooldown: 99, torpT: 99 }) as RaiderEntity;
    run(net, peers, 300);
    orderFrom(net, peers, o, act(Act.Target, 0, 0, r.id));
    expect(ship.render.tubes).toBe(3);
    orderFrom(net, peers, o, act(Act.Torpedo), 150);
    expect(ship.state.tubes).toBe(2);
    run(net, peers, 3000);
    expect(r.state.hp + r.state.shields).toBeLessThan(170 + 90 - 40);
  });

  it("lets crew fix a sparking conduit with the spanner and put out a fire with the extinguisher, giving the system back its health", () => {
    const { net, o, c, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    const spot = deck.faultSpots[ShipSystem.Shields][0];
    ship.state.hShd = 0.6;
    run0.world.spawn(Fault, { x: spot.x, y: spot.y, z: 1, system: ShipSystem.Shields, kind: FaultKind.Sparks, left: 1, voyage: ship.state.voyage });
    run(net, peers, 400);
    expect(efficiency(ship.render, ShipSystem.Shields)).toBeLessThan(1);
    placeCrew(c, spot.x + 1, spot.y, Math.PI);
    c.crew!.pitch = -0.3;
    c.cintent!.selectTool = SPANNER;
    c.cintent!.trigger = true;
    run(net, peers, 5000);
    c.cintent!.trigger = false;
    expect(c.body!.fixes).toContain(FaultKind.Sparks);
    expect(run0.world.all(Fault).size).toBe(0);
    expect(health(ship.state, ShipSystem.Shields)).toBeCloseTo(0.8, 1);

    // a fire, low down: the spanner does nothing, the extinguisher puts it out
    run0.world.spawn(Fault, { x: spot.x, y: spot.y, z: 0, system: ShipSystem.Shields, kind: FaultKind.Fire, left: 1, voyage: ship.state.voyage });
    run(net, peers, 300);
    placeCrew(c, spot.x + 2, spot.y, Math.PI);
    c.crew!.pitch = -0.4;
    c.cintent!.trigger = true;
    run(net, peers, 1500);
    expect(run0.world.all(Fault).size).toBe(1);
    c.cintent!.selectTool = EXTINGUISHER;
    run(net, peers, 5000);
    c.cintent!.trigger = false;
    expect(c.body!.fixes).toContain(FaultKind.Fire);
    expect(run0.world.all(Fault).size).toBe(0);

    // and the damage control team gets there on its own, slowly
    run0.world.spawn(Fault, { x: spot.x, y: spot.y, z: 1, system: ShipSystem.Sensors, kind: FaultKind.Sparks, left: 1, voyage: ship.state.voyage });
    run(net, peers, 300);
    orderFrom(net, peers, o, act(Act.DamageControl, ShipSystem.Sensors));
    run(net, peers, 16000);
    expect(run0.world.all(Fault).size).toBe(0);
    expect(PHASER.issued).toBe(1);
  });

  it('lets crew carry torpedoes from the rack to an empty tube', () => {
    const { net, o, c, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    ship.state.tubes = 2;
    ship.state.torps = 5;
    ship.state.loadT = 0;
    orderFrom(net, peers, o, act(Act.Power, ShipSystem.Weapons, 0));
    const me = c.ctx.me!;
    placeCrew(c, RACK.x, RACK.y + 1.1, -Math.PI / 2);
    run(net, peers, 300);
    expect(c.crew!.nearby?.kind).toBe('rack');
    c.cintent!.use = true;
    run(net, peers, 400);
    expect(me.state.carry).toBe(Carry.Torpedo);
    expect(ship.state.torps).toBe(4);
    placeCrew(c, TUBES[0].x - 0.8, TUBES[0].y, 0);
    run(net, peers, 300);
    expect(c.crew!.nearby).toEqual({ kind: 'tube', index: 0, loaded: false });
    c.cintent!.use = true;
    run(net, peers, 400);
    expect(me.state.carry).toBe(Carry.Nothing);
    expect(ship.state.tubes).toBe(3);
  });

  it('lets crew sit at a console and give its orders', () => {
    const { net, o, c, peers } = underway();
    const helm = CONSOLES[Station.Helm];
    placeCrew(c, helm.x - 0.9, helm.y, 0);
    run(net, peers, 300);
    expect(c.crew!.nearby?.kind).toBe('console');
    c.cintent!.sit = true;
    run(net, peers, 200);
    expect(c.crew!.seat).toBe(Station.Helm);
    c.cintent!.acts.push(act(Act.OnScreen, Screen.Aft));
    run(net, peers, 300);
    expect(shipOf(o).render.screen).toBe(Screen.Aft);
    c.cintent!.sit = true;
    run(net, peers, 200);
    expect(c.crew!.seat).toBe(null);
    expect(c.body!.seats).toEqual([Station.Helm, null]);
  });
});

describe('A voyage', () => {
  it('is won by docking with every relic aboard, and a new one begins', () => {
    const { net, o, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    const voyage = ship.state.voyage;
    ship.state.relics = allRelics(sector, voyage);
    Object.assign(ship.state, { x: sector.starbase.x - 400, y: sector.starbase.y, speed: 0 });
    run(net, peers, 300);
    orderFrom(net, peers, o, act(Act.Dock));
    expect(ship.render.phase).toBe(Phase.Over);
    expect(ship.render.result).toBe(Result.Victory);
    run(net, peers, (OVER_SECONDS + 1) * 1000);
    expect(ship.render.phase).toBe(Phase.Briefing);
    expect(ship.render.voyage).toBe(voyage + 1);
    expect(ship.render.relics).toBe(0);
    expect(run0.world.all(Relic).size).toBe(0);
  });

  it('is lost with the hull, and the crew start the next one on the bridge', () => {
    const { net, c, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    Object.assign(ship.state, { x: 2000, y: 2000 });
    placeCrew(c, PAD.x, PAD.y);
    run(net, peers, 300);
    ship.state.hull = 5;
    run0.keeper.damage(ship, 50, 2100, 2000);
    expect(ship.state.phase).toBe(Phase.Over);
    expect(ship.state.result).toBe(Result.Lost);
    run(net, peers, (OVER_SECONDS + 1) * 1000);
    expect(ship.render.phase).toBe(Phase.Briefing);
    const me = c.ctx.me as CrewEntity;
    expect(Math.hypot(me.state.x - SPAWN.x, me.state.y - SPAWN.y)).toBeLessThan(2);
    expect([...run0.world.all(Fault)] as FaultEntity[]).toHaveLength(0);
  });
});

describe('A console in a headset', () => {
  /** A canvas that swallows everything drawn on it: the scopes work out where things are as they draw. */
  const paper = () => stub() as unknown as CanvasRenderingContext2D;
  const keyed = (rows: ReturnType<typeof stationControls>['rows'], label: string): Key => {
    const cell = rows.flat().find((c) => c.kind === 'key' && c.label().startsWith(label));
    expect(cell, `no key labelled ${label}`).toBeTruthy();
    return cell as Key;
  };

  it("lays every station's keys out on the desk, clear of each other and of the key that leaves it", () => {
    const { net, o, peers } = underway();
    run(net, peers, 200);
    for (const station of STATIONS) {
      const boxes = deskLayout(stationControls(o.ctx, station, scopeFor(o.ctx, station)));
      expect(boxes.length).toBeGreaterThan(2);
      for (const { box } of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(8);
        expect(box.x + box.w).toBeLessThanOrEqual(DESK.w - 8);
        expect(box.y).toBeGreaterThan(LEAVE_BOX.y + LEAVE_BOX.h);
        expect(box.y + box.h).toBeLessThanOrEqual(DESK.h - 30);
        expect(box.w).toBeGreaterThan(20);
        expect(box.h).toBeGreaterThan(20);
      }
      // nothing overlaps, so a fingertip means one key
      for (const a of boxes)
        for (const b of boxes) {
          if (a === b) continue;
          const over = a.box.x < b.box.x + b.box.w && b.box.x < a.box.x + a.box.w && a.box.y < b.box.y + b.box.h && b.box.y < a.box.y + a.box.h;
          expect(over, `${(a.cell as Key).label?.() ?? 'slider'} overlaps ${(b.cell as Key).label?.() ?? 'slider'}`).toBe(false);
        }
      // and every key's middle finds itself again
      for (const { box, cell } of boxes) expect(boxes.find((b) => within(b.box, { x: box.x + box.w / 2, y: box.y + box.h / 2 }))!.cell).toBe(cell);
    }
  });

  it("targets the raider a fingertip lands on in tactical's radar, and nothing in empty space", () => {
    const { net, o, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    Object.assign(ship.state, { x: 2000, y: 2000, heading: 0, course: 0, speed: 0 });
    run(net, peers, 300);
    const r = run0.world.spawn(Raider, { x: 2400, y: 2000, heading: Math.PI, kind: RaiderKind.Fighter, hp: 60, shields: 30, voyage: ship.state.voyage, cooldown: 99 }) as RaiderEntity;
    run(net, peers, 300);
    const scope = tacticalScope(o.ctx);
    const { w, h } = SCOPE_BOX;
    scope.draw(paper(), w, h);
    // the radar is heading up, so a raider dead ahead is straight above the ship in the middle
    const scale = (Math.min(w, h) / 2 - 10) / 1600;
    const hit = scope.tap(w / 2, h / 2 - 400 * scale);
    expect(hit).toEqual(act(Act.Target, 0, 0, r.id));
    // the far corner of the radar is thousands of units from it, well past the reach of a fingertip
    expect(scope.tap(10, h - 20)).toBe(null);
  });

  it("sets the waypoint where a fingertip lands on helm's map", () => {
    const { net, o, peers } = underway();
    const ship = shipOf(owner(peers));
    Object.assign(ship.state, { x: 2000, y: 2000, throttle: 0, speed: 0 });
    run(net, peers, 300);
    const scope = helmScope(o.ctx, { course: () => null });
    const { w, h } = SCOPE_BOX;
    scope.draw(paper(), w, h);
    const span = 3200;
    const here = o.ctx.ship()!.render;
    const order = scope.tap(w / 2 + Math.min(w, h) * 0.25, h / 2)!;
    expect(order.act).toBe(Act.Waypoint);
    expect(order.a).toBeCloseTo(here.x + span * 0.25, 0);
    expect(order.b).toBeCloseTo(here.y, 0);
  });

  it("sends the damage control team to whichever room a fingertip lands on in engineering's deck plan", () => {
    const { net, o, peers } = underway();
    run(net, peers, 200);
    const scope = engineeringScope(o.ctx);
    const { w, h } = SCOPE_BOX;
    scope.draw(paper(), w, h);
    const found = new Set<number>();
    for (let x = 0; x < w; x += 3)
      for (let y = 0; y < h; y += 3) {
        const order = scope.tap(x, y);
        if (order) {
          expect(order.act).toBe(Act.DamageControl);
          found.add(order.a);
        }
      }
    for (const sys of SYSTEMS) expect(found.has(sys), `${sys} unreachable`).toBe(true);
    expect(scope.tap(0, 0)).toBe(null);
  });

  it("runs helm's throttle from full astern to full ahead, holding what it was let go at", () => {
    const { net, o, peers } = underway();
    run(net, peers, 200);
    const rows = stationControls(o.ctx, Station.Helm, helmScope(o.ctx, { course: () => null })).rows;
    const throttle = rows.flat().find((c) => c.kind === 'slider') as Slider;
    expect(throttle.set(0)).toEqual(act(Act.Throttle, -0.25));
    expect(throttle.set(1)).toEqual(act(Act.Throttle, 1));
    expect(throttle.set(0.2)!.a).toBe(0);
    expect(throttle.set(0.8)!.a).toBeCloseTo(0.75, 2);
    expect(throttle.at()).toBeCloseTo(0.8, 2);
    expect(throttle.release()).toEqual(act(Act.Throttle, 0.75));
    expect(throttle.release()).toBe(null);
  });

  it('steers while port or starboard is held, and gives the map the course it is turning to', () => {
    const { net, o, peers } = underway();
    const ship = shipOf(owner(peers));
    Object.assign(ship.state, { x: 2000, y: 2000, heading: 0, course: 0 });
    run(net, peers, 300);
    const steer = { course: null as number | null };
    const scope = helmScope(o.ctx, { course: () => steer.course });
    const port = keyed(stationControls(o.ctx, Station.Helm, scope, steer).rows, '◀ PORT');
    let last: ReturnType<typeof act> | null = null;
    for (let i = 0; i < 12; i++) last = (port.press(1 / 60) as ReturnType<typeof act> | null) ?? last;
    expect(steer.course).toBeLessThan(0);
    expect(last!.act).toBe(Act.Course);
    expect(last!.a).toBeCloseTo(steer.course!, 3);
    const held = steer.course!;
    expect(port.release!()).toEqual(act(Act.Course, held));
    expect(steer.course).toBe(null);
  });

  it("greys tactical's keys out when there's nothing to shoot at, and lights them at a target", () => {
    const { net, o, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    Object.assign(ship.state, { x: 2000, y: 2000, heading: 0, course: 0, speed: 0, phaser: 1, tubes: 0 });
    run(net, peers, 300);
    const rows = stationControls(o.ctx, Station.Tactical, tacticalScope(o.ctx)).rows;
    const phasers = rows.flat().find((c) => c.kind === 'key' && c.color === '#ff9a4a') as Key;
    expect(phasers.off!()).toBe(true);
    expect(phasers.label()).toBe('NO TARGET');
    const r = run0.world.spawn(Raider, { x: 2300, y: 2000, heading: Math.PI, kind: RaiderKind.Fighter, hp: 60, shields: 30, voyage: ship.state.voyage, cooldown: 99 }) as RaiderEntity;
    run(net, peers, 300);
    const next = keyed(rows, 'NEXT TARGET');
    orderFrom(net, peers, o, next.press(1 / 60) as ReturnType<typeof act>);
    expect(ship.render.target).toBe(r.id);
    run(net, peers, 300);
    expect(phasers.off!()).toBe(false);
    expect(phasers.label()).toContain('PHASERS');
    expect(keyed(rows, 'FIRE TORPEDO').off!()).toBe(true);
  });

  it("spends engineering's power pips, and greys out what the pool can't afford", () => {
    const { net, o, peers } = underway();
    const run0 = owner(peers);
    const ship = shipOf(run0);
    run(net, peers, 200);
    const rows = stationControls(o.ctx, Station.Engineering, engineeringScope(o.ctx)).rows;
    const row = rows[SYSTEMS.indexOf(ShipSystem.Shields)];
    const pip = (n: number) => row.find((c) => c.kind === 'key' && c.label() === String(n)) as Key;
    // every system starts with a share of the pool, so free a pip before asking for one
    Object.assign(ship.state, { pWep: 0 });
    run(net, peers, 300);
    const want = pips(ship.render, ShipSystem.Shields) + 1;
    orderFrom(net, peers, o, pip(want).press(1 / 60) as ReturnType<typeof act>);
    expect(pips(shipOf(o).render, ShipSystem.Shields)).toBe(want);
    // with the whole pool in one system, the keys past what's spare go dead
    Object.assign(ship.state, { pEng: 0, pWep: 0, pSen: 0, pShd: POWER_POOL });
    run(net, peers, 300);
    expect((row.find((c) => c.kind === 'key' && c.label() === 'TEAM') as Key).on!()).toBe(shipOf(o).render.team === ShipSystem.Shields);
    const engines = rows[SYSTEMS.indexOf(ShipSystem.Engines)];
    expect((engines.find((c) => c.kind === 'key' && c.label() === '1') as Key).off!()).toBe(true);
  });

  it("keeps science's transporter keys dead until the ship is in orbit with its shields down", () => {
    const { net, o, peers } = underway();
    const ship = shipOf(owner(peers));
    run(net, peers, 200);
    const rows = stationControls(o.ctx, Station.Science, scienceScope(o.ctx)).rows;
    expect(transporterBlocked(ship.render)).not.toBe('');
    for (const label of ['BEAM DOWN', 'BEAM UP', 'BEAM RELIC']) expect(keyed(rows, label).off!(), label).toBe(true);
    expect(keyed(rows, 'ABORT').off!()).toBe(true);
  });

  it('gives its orders to the ship, the same as a phone would', () => {
    const net = new Sim();
    const o = peer(net, 'a', 'officer');
    const peers = [o];
    run(net, peers, 7000);
    const ship = shipOf(owner(peers));
    expect(ship.render.phase).toBe(Phase.Briefing);
    const rows = stationControls(o.ctx, Station.Helm, helmScope(o.ctx, { course: () => null })).rows;
    const cast = keyed(rows, 'CAST OFF');
    expect(cast.on!()).toBe(true);
    orderFrom(net, peers, o, cast.press(1 / 60) as ReturnType<typeof act>);
    expect(shipOf(o).render.phase).toBe(Phase.Underway);
  });
});
