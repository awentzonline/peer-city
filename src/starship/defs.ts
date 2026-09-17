import { defineAction, defineCommand, defineEntity, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';

/**
 * Everything in Peer Starship that goes over the network. Two kinds of place share one world, each in its own units:
 *
 * - **Space**, the sector the ship flies through: `u`, about a hundred meters each, x and y on the plane of the sector.
 *   The ship, raiders and torpedoes live here.
 * - **Decks**, measured in meters: the inside of the ship, and the away sites on the planets' surfaces (deck.ts), laid out
 *   side by side. Crew avatars, faults, sentinels and relics live here.
 *
 * Three roles. **Officers** run a bridge station (helm, tactical, science, engineering) from a phone or a screen. The
 * **viewer** is the viewscreen: a big screen everyone on the bridge looks at. **Crew** walk the decks as avatars on
 * desktop, in VR or on a phone: they fight fires, fix what's broken, load torpedoes, and beam down on away missions.
 */

export const enum Station {
  Helm = 0,
  Tactical = 1,
  Science = 2,
  Engineering = 3,
  /** The viewscreen. */
  Viewer = 4,
  None = 5,
}

export const STATIONS = [Station.Helm, Station.Tactical, Station.Science, Station.Engineering] as const;

export const enum ShipSystem {
  Engines = 0,
  Weapons = 1,
  Shields = 2,
  Sensors = 3,
}

export const SYSTEMS = [ShipSystem.Engines, ShipSystem.Weapons, ShipSystem.Shields, ShipSystem.Sensors] as const;

export const enum Phase {
  /** Docked at the starbase before a voyage: the crew find their stations. */
  Briefing = 0,
  Underway = 1,
  /** How it ended is in `result`. */
  Over = 2,
}

export const enum Result {
  None = 0,
  /** Every relic brought home. */
  Victory = 1,
  /** The ship was destroyed. */
  Lost = 2,
}

export const enum Warp {
  Idle = 0,
  /** Spinning up the drive: it jumps when `warpT` reaches 1. */
  Charging = 1,
  /** Streaking to the waypoint. */
  Warping = 2,
}

/** What the transporter's busy with. */
export const enum Beam {
  Idle = 0,
  /** Everyone on the pad, down to the planet the ship's orbiting. */
  Down = 1,
  /** Everyone on that planet's surface, back up to the pad. */
  Up = 2,
  /** The relic on its own, through the surface's interference: slow. */
  Relic = 3,
}

/** What's on the viewscreen. */
export const enum Screen {
  Forward = 0,
  Aft = 1,
  /** From above and behind the ship. */
  Tactical = 2,
  /** Tactical's target, from the ship. */
  Target = 3,
  /** Over the shoulder of the away team. */
  Away = 4,
}

export const SCREENS = [Screen.Forward, Screen.Aft, Screen.Tactical, Screen.Target, Screen.Away] as const;

/**
 * The ship, and the voyage it's on: one migratable entity for everyone, simulated by whoever owns it. Stations never
 * write it: they send `Console` commands, and its owner carries them out.
 */
export const Ship = defineEntity({
  name: 'ship',
  fields: {
    x: t.fixed(0.05),
    y: t.fixed(0.05),
    heading: t.angle(12),
    speed: t.fixed(0.1),
    // helm
    /** -0.25..1 of full impulse. */
    throttle: t.fixed(0.05, 0, 'none'),
    /** Where helm has asked the ship to point. */
    course: t.angle(10),
    /** Steering itself toward the waypoint. */
    autopilot: t.bool(),
    wx: t.fixed(1, 0, 'none'),
    wy: t.fixed(1, 0, 'none'),
    waypoint: t.bool(),
    warp: t.enum<Warp>(),
    warpT: t.fixed(0.02, 0, 'none'),
    /** Planet index + 1 it's orbiting, or 0. */
    orbit: t.uint(8),
    docked: t.bool(),
    // tactical
    hull: t.fixed(0.5, 100, 'none'),
    shields: t.fixed(0.5, 0, 'none'),
    shieldsUp: t.bool(),
    phaser: t.fixed(0.02, 1, 'none'),
    /** Loaded torpedo tubes, as bits. */
    tubes: t.uint(8, 3),
    torps: t.uint(8, 8),
    /** The autoloader's progress on the next tube, 0..1. */
    loadT: t.fixed(0.02, 0, 'none'),
    target: t.ref(),
    // science
    scanning: t.ref(),
    /** Planet index + 1 being scanned (planets aren't entities), or 0. */
    scanPlanet: t.uint(8),
    scanT: t.fixed(0.02, 0, 'none'),
    /** Planets scanned, as bits. */
    surveyed: t.uint(16),
    beam: t.enum<Beam>(),
    beamT: t.fixed(0.02, 0, 'none'),
    screen: t.enum<Screen>(),
    // engineering: power in pips (0..4) and health (0..1) per system
    pEng: t.uint(8, 2),
    pWep: t.uint(8, 2),
    pShd: t.uint(8, 2),
    pSen: t.uint(8, 2),
    hEng: t.fixed(0.01, 1, 'none'),
    hWep: t.fixed(0.01, 1, 'none'),
    hShd: t.fixed(0.01, 1, 'none'),
    hSen: t.fixed(0.01, 1, 'none'),
    /** The damage control team's system, or 255 while it's idle. */
    team: t.uint(8, 255),
    // the voyage
    phase: t.enum<Phase>(),
    result: t.enum<Result>(),
    voyage: t.uint(16, 1),
    /** Seconds: of briefing left, underway so far, or before the next voyage. */
    timer: t.fixed(0.1, 0, 'none'),
    nextWave: t.fixed(0.5, 0, 'none'),
    waves: t.uint(8),
    /** Relics brought aboard, by planet, as bits. */
    relics: t.uint(16),
    /** Red alert: raiders about. */
    alert: t.bool(),
    /** Counts the ship's shots and hits, so everyone sees each one. */
    hits: t.uint(8),
  },
  position: ['x', 'y'],
  migratable: true,
  priority: 4,
  snapDistance: 400,
  interpolate: ['x', 'y', 'heading', 'speed'],
});

/** Someone at a station, or watching the viewscreen: shown on the stations' tabs and the viewer's crew list. */
export const Officer = defineEntity({
  name: 'officer',
  fields: {
    x: t.fixed(1),
    y: t.fixed(1),
    name: t.string(16),
    station: t.enum<Station>(Station.None),
    platform: t.uint(8),
  },
  interpolate: [],
});

export const enum RaiderKind {
  /** Quick, fragile, a disruptor. */
  Fighter = 0,
  /** Slow and tough, a disruptor and torpedoes. */
  Cruiser = 1,
}

export const Raider = defineEntity({
  name: 'raider',
  fields: {
    x: t.fixed(0.05),
    y: t.fixed(0.05),
    heading: t.angle(10),
    speed: t.fixed(0.1),
    kind: t.enum<RaiderKind>(),
    hp: t.fixed(0.5, 60, 'none'),
    shields: t.fixed(0.5, 30, 'none'),
    /** Science has scanned it: its shield harmonics are known, and it takes more damage. */
    scanned: t.bool(),
    /** Which way it's circling. */
    side: t.bool(),
    cooldown: t.fixed(0.1, 0, 'none'),
    torpT: t.fixed(0.1, 0, 'none'),
    voyage: t.uint(16),
  },
  migratable: true,
  snapDistance: 400,
  interpolate: ['x', 'y', 'heading'],
});

export const enum CrewMode {
  Up = 0,
  /** Incapacitated: carried off to the ship's sickbay shortly. */
  Down = 1,
}

export const enum Carry {
  Nothing = 0,
  Torpedo = 1,
  Relic = 2,
}

/** A crew member: an avatar on the decks or down on a planet. */
export const Crew = defineEntity({
  name: 'crew',
  fields: {
    ...BODY_FIELDS,
    name: t.string(16),
    skin: t.uint(8),
    mode: t.enum<CrewMode>(),
    hp: t.fixed(1, 100, 'none'),
    carry: t.enum<Carry>(),
    /** At a bridge console (station + 1), or 0. */
    seat: t.uint(8),
    /** Counts transports, so everyone sees the shimmer. */
    beams: t.uint(8),
    /** Spraying the extinguisher, for everyone to see. */
    spray: t.bool(),
    voyage: t.uint(16),
  },
  priority: 3,
  snapDistance: 20,
});

export const enum FaultKind {
  /** Sparking conduits: the spanner fixes them. */
  Sparks = 0,
  /** A fire: the extinguisher puts it out. It keeps doing damage while it burns. */
  Fire = 1,
}

/** Something broken on a deck, in the room of the system it's hurting. */
export const Fault = defineEntity({
  name: 'fault',
  fields: {
    x: t.fixed(0.05),
    y: t.fixed(0.05),
    z: t.fixed(0.05),
    system: t.enum<ShipSystem>(),
    kind: t.enum<FaultKind>(),
    /** How much is left to mend, 1..0. */
    left: t.fixed(0.02, 1, 'none'),
    voyage: t.uint(16),
  },
  migratable: true,
  interpolate: [],
});

/** A drone guarding an away site. */
export const Sentinel = defineEntity({
  name: 'sentinel',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    z: t.fixed(0.05),
    heading: t.angle(8),
    hp: t.uint(8, 4),
    /** The site it guards, 1.. */
    site: t.uint(8),
    target: t.ref(),
    tx: t.fixed(0.25),
    ty: t.fixed(0.25),
    cooldown: t.fixed(0.1, 0, 'none'),
    shots: t.uint(8),
    voyage: t.uint(16),
  },
  migratable: true,
  snapDistance: 10,
});

/** The relic on a planet's surface, on its plinth or in someone's arms. */
export const Relic = defineEntity({
  name: 'relic',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    z: t.fixed(0.02),
    site: t.uint(8),
    carrier: t.ref(),
    voyage: t.uint(16),
  },
  migratable: true,
  snapDistance: 10,
});

// ---------------------------------------------------------------------------
// Commands, carried out by their target's owner
// ---------------------------------------------------------------------------

export const enum Act {
  // helm
  Throttle = 0,
  Course = 1,
  Waypoint = 2,
  Autopilot = 3,
  Warp = 4,
  Orbit = 5,
  Dock = 6,
  AllStop = 7,
  // tactical
  Target = 10,
  Phasers = 11,
  Torpedo = 12,
  Shields = 13,
  // science
  Scan = 20,
  ScanPlanet = 21,
  BeamDown = 22,
  BeamUp = 23,
  BeamRelic = 24,
  BeamAbort = 25,
  OnScreen = 26,
  // engineering
  Power = 30,
  DamageControl = 31,
  // from crew on the decks
  TakeTorpedo = 40,
  LoadTube = 41,
}

/** A station's order to the ship. `a` and `b` are numbers, `ref` an entity, each as the act needs. */
export const Console = defineCommand('console', { target: t.ref(), act: t.uint(8), a: t.fixed(0.001), b: t.fixed(0.25), ref: t.ref() });

/** Hurt something: the ship or a raider (in u), a crew member or sentinel (on a deck). (x, y) is where it came from. */
export const Damage = defineCommand('damage', { target: t.ref(), amount: t.fixed(0.1), x: t.fixed(0.1), y: t.fixed(0.1) });

/** Science's scan finished on a raider. */
export const Scanned = defineCommand('scanned', { target: t.ref() });

/** A crew member mends a fault, a bit at a time. */
export const Mend = defineCommand('mend', { target: t.ref(), amount: t.fixed(0.005) });

/** A fault was mended: its system gets better. */
export const Repaired = defineCommand('repaired', { target: t.ref(), system: t.enum<ShipSystem>() });

/** Beam a crew member to (x, y) on the decks, or (sent to a relic) beam the relic aboard. */
export const Transport = defineCommand('transport', { target: t.ref(), x: t.fixed(0.02), y: t.fixed(0.02) });

/** A crew member picks up a relic, or sets it down (`by` 0). */
export const Grab = defineCommand('grab', { target: t.ref(), by: t.ref() });

/** A relic came aboard: which planet's. */
export const Recovered = defineCommand('recovered', { target: t.ref(), planet: t.uint(8) });

// ---------------------------------------------------------------------------
// Events, for everyone to see and hear
// ---------------------------------------------------------------------------

export const enum Shot {
  /** The ship's phasers. */
  Phaser = 0,
  /** A raider's disruptor. */
  Disruptor = 1,
  /** A crew member's hand phaser, on a deck. */
  HandPhaser = 2,
  /** A sentinel's bolt, on a deck. */
  Bolt = 3,
}

/** A beam weapon fired from one point to another: in space (u) for the ship and raiders, on a deck (m) otherwise. */
export const Beam3 = defineAction('beam', { kind: t.enum<Shot>(), x: t.fixed(0.05), y: t.fixed(0.05), z: t.fixed(0.05), tx: t.fixed(0.05), ty: t.fixed(0.05), tz: t.fixed(0.05), hit: t.bool() });

/** A torpedo launched, by the ship (`hostile` false) or a raider: whoever's near flies a copy to see it. The sender decides hits. */
export const Launch = defineAction('launch', { x: t.fixed(0.1), y: t.fixed(0.1), heading: t.angle(10), target: t.ref(), hostile: t.bool() });

/** Something blew up in space. `size` 0 a torpedo, 1 a fighter, 2 a cruiser, 3 the ship. */
export const Boom = defineAction('boom', { x: t.fixed(0.5), y: t.fixed(0.5), size: t.uint(8) });

/** The ship was hit: the decks shake, the lights flicker. `shielded` if the shields took it all. */
export const Jolt = defineAction('jolt', { amount: t.fixed(0.5), shielded: t.bool(), x: t.fixed(0.5), y: t.fixed(0.5) });

export const enum Sound {
  Warp = 0,
  Dock = 1,
  Beam = 2,
  Load = 3,
  Relic = 4,
  Repair = 5,
  Fire = 6,
  Undock = 7,
  Scan = 8,
  /** A sentinel shot down. */
  Wreck = 9,
}

/** Something to hear: on the decks at (x, y, z) in meters, or ship-wide with `ship`. */
export const Noise = defineAction('noise', { kind: t.enum<Sound>(), x: t.fixed(0.05), y: t.fixed(0.05), z: t.fixed(0.05), ship: t.bool() });

export const Feed = defineAction('feed', { text: t.string(96) });

export const ENTITIES = [Ship, Officer, Raider, Crew, Fault, Sentinel, Relic];
export const ACTIONS = [Console, Damage, Scanned, Mend, Repaired, Transport, Grab, Recovered, Beam3, Launch, Boom, Jolt, Noise, Feed];
