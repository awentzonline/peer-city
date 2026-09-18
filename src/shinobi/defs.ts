import { defineAction, defineCommand, defineEntity, defineSingleton, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';

/**
 * Everything in Peer Shinobi that goes over the network. Meters, world axes (x, y on the ground, z up), over the seeded
 * castle every peer builds for itself (castle.ts), so only what changes is sent.
 *
 * Two roles share the world. **Shinobi** are avatars who climb the walls and roofs of a castle at night to kill its lord,
 * and get out again. **The Captain of the Watch** looks down on a map of the castle, but only knows what the guards
 * see and hear, and sends them where they're needed. Guards (and the lord) are migratable NPCs. One migratable `Round`
 * runs the night.
 */

export const enum ShinobiMode {
  Alive = 0,
  /** Down, bleeding, unless another shinobi helps them up. */
  Downed = 1,
  /** Taken: out of the night. */
  Dead = 2,
  /** Over the wall and away once the lord's dead. */
  Escaped = 3,
}

export const Shinobi = defineEntity({
  name: 'shinobi',
  fields: {
    ...BODY_FIELDS,
    name: t.string(16),
    skin: t.uint(8),
    mode: t.enum<ShinobiMode>(),
    hp: t.uint(8, 3),
    /** How easily seen they are right now, 0..1: the light they're in, how they move, crouching, in a bush. */
    exposure: t.fixed(0.05, 0.3, 'none'),
    /** Clinging to a wall or roof edge. */
    climbing: t.bool(),
    revive: t.fixed(0.05, 0, 'none'),
    bleed: t.uint(8),
    round: t.uint(16),
    /** Guards taken down tonight, for the scores. */
    kills: t.uint(8),
  },
  priority: 3,
  snapDistance: 12,
});

export const enum GuardKind {
  /** An ashigaru with a spear and a paper lantern, walking a patrol or standing a post. */
  Spear = 0,
  /** Up on a watchtower with a bow. */
  Archer = 1,
  /** The lord's own bodyguard. */
  Samurai = 2,
  /** The lord himself. */
  Lord = 3,
}

export const enum GuardMode {
  /** Walking a patrol route. */
  Patrol = 0,
  /** Standing watch in one place. */
  Post = 1,
  /** Going to look at something seen or heard. */
  Investigate = 2,
  /** Sent by the captain to sweep an area. */
  Search = 3,
  /** After a shinobi they've seen. */
  Chase = 4,
  /** Keeping by the lord, or (the lord) strolling between his stations. */
  Escort = 5,
  Dead = 6,
}

export const enum Alert {
  Calm = 0,
  /** Something's not right: `?`. */
  Suspicious = 1,
  /** Intruder!: `!`. */
  Alarmed = 2,
}

export const Guard = defineEntity({
  name: 'guard',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    z: t.fixed(0.05),
    angle: t.angle(8),
    /** How far its head's turned from where it's facing, looking round. */
    look: t.angle(6),
    kind: t.enum<GuardKind>(),
    mode: t.enum<GuardMode>(),
    alert: t.enum<Alert>(),
    /** How sure it is something's there, 0..1, for the `?` over its head. */
    sus: t.fixed(0.05, 0, 'none'),
    hp: t.uint(8, 2),
    /** Who it's after, and where it's going (in the schema so they survive a change of owner). */
    target: t.ref(),
    tx: t.fixed(0.25),
    ty: t.fixed(0.25),
    /** Its patrol route, post or perch, by index into the castle's lists. */
    home: t.uint(8),
    /** The waypoint of its route it's making for, or the lord's station. */
    wp: t.uint(8),
    /** Seconds left of whatever it's been told to do (a search, an alarm). */
    left: t.fixed(0.5, 0, 'none'),
    lantern: t.bool(),
    /** Counts up every few seconds while it lives: the captain notices when one stops. */
    checkin: t.uint(8),
    /** Counts its attacks, so everyone sees each thrust or shot. */
    strikes: t.uint(8),
    round: t.uint(16),
  },
  migratable: true,
  snapDistance: 10,
});

/** Someone playing the Captain of the Watch: where they're looking and pointing on the map. Nobody in the castle sees it. */
export const Captain = defineEntity({
  name: 'captain',
  fields: {
    x: t.fixed(0.25),
    y: t.fixed(0.25),
    name: t.string(16),
    platform: t.uint(8),
    px: t.fixed(0.1),
    py: t.fixed(0.1),
    pointing: t.bool(),
  },
  interpolate: ['px', 'py'],
});

export const enum Weapon {
  Tanto = 0,
  Kunai = 1,
  Shuriken = 2,
  Arrow = 3,
}

/** A kunai or shuriken lying where it fell, or stuck where it hit, for any shinobi to pick up. */
export const Blade = defineEntity({
  name: 'blade',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    z: t.fixed(0.02),
    kind: t.enum<Weapon>(),
    /** Which way it points where it stuck. */
    yaw: t.angle(6),
    pitch: t.angle(6),
    round: t.uint(16),
  },
  migratable: true,
  interpolate: [],
});

/** Braziers the captain has had lit somewhere, burning down. */
export const Beacon = defineEntity({
  name: 'beacon',
  fields: {
    x: t.fixed(0.1),
    y: t.fixed(0.1),
    /** Seconds left. */
    left: t.fixed(1, 0, 'none'),
    round: t.uint(16),
  },
  migratable: true,
  interpolate: [],
});

export const enum Phase {
  /** Shinobi gather in the forest; the night begins when the clock runs out. */
  Waiting = 0,
  /** The lord lives. */
  Night = 1,
  /** The lord's dead: get out over the wall. */
  Escape = 2,
  /** How it ended is in `result`. */
  Over = 3,
}

export const enum Result {
  None = 0,
  /** The lord's dead and at least one shinobi got away. */
  Assassinated = 1,
  /** The lord's dead, but none of them got out. */
  Avenged = 2,
  /** The lord saw the dawn. */
  Defended = 3,
}

export const Round = defineSingleton({
  name: 'round',
  fields: {
    x: t.fixed(1),
    y: t.fixed(1),
    phase: t.enum<Phase>(),
    round: t.uint(16),
    timer: t.fixed(0.1, 0, 'none'),
    result: t.enum<Result>(),
    /** The lord, while the night's on. */
    lord: t.ref(),
    escaped: t.uint(8),
    taken: t.uint(8),
    /** Seconds the alarm bell has left to ring. */
    alarm: t.fixed(0.5, 0, 'none'),
  },
  migratable: true,
  interpolate: [],
});

// ---------------------------------------------------------------------------
// Actions: commands, carried out by their target's owner, and events, seen by whoever's near
// ---------------------------------------------------------------------------

/**
 * A shinobi struck or hit a guard. `x`, `y` is where it came from, so a guard that lives turns to look, and a blow from
 * behind on a guard that isn't alarmed is lethal.
 */
export const Strike = defineCommand('strike', { target: t.ref(), by: t.ref(), weapon: t.enum<Weapon>(), amount: t.uint(8), x: t.fixed(0.1), y: t.fixed(0.1) });

/** A shinobi's blow or throw took down a guard (or the lord): their peer counts it. */
export const Tally = defineCommand('tally', { target: t.ref(), kind: t.enum<GuardKind>() });

/** A guard hit a shinobi. */
export const Wound = defineCommand('wound', { target: t.ref(), by: t.ref(), amount: t.uint(8), kx: t.fixed(0.05), ky: t.fixed(0.05) });

export const enum OrderKind {
  /** Go and sweep round a spot for a while. */
  Search = 0,
  /** Stand watch at a spot. */
  Post = 1,
  /** Go back to what it was doing: its route, post or the lord. */
  Return = 2,
  /** The lord: go to a station. */
  Station = 3,
}

/** The captain sends a guard somewhere. */
export const Order = defineCommand('order', { target: t.ref(), kind: t.enum<OrderKind>(), x: t.fixed(0.25), y: t.fixed(0.25) });

/** A shinobi is helping a downed one up: sent every moment they keep at it. */
export const Revive = defineCommand('revive', { target: t.ref(), by: t.ref() });

/** A kunai, shuriken or arrow thrown or loosed: everyone near flies their own copy to see it. */
export const Throw = defineAction('throw', {
  kind: t.enum<Weapon>(),
  by: t.ref(),
  x: t.fixed(0.02),
  y: t.fixed(0.02),
  z: t.fixed(0.02),
  vx: t.fixed(0.05),
  vy: t.fixed(0.05),
  vz: t.fixed(0.05),
});

export const enum Sound {
  /** Running footsteps. */
  Steps = 0,
  /** A hard landing from a height. */
  Land = 1,
  /** Steel on stone or wood: a thrown blade that missed. */
  Clatter = 2,
  /** A body hitting the ground. */
  Fall = 3,
  /** A guard shouts: intruder! */
  Shout = 4,
  /** A guard's blow or shot. */
  Attack = 5,
  /** A blade finding flesh. */
  Stab = 6,
  /** The alarm bell. */
  Bell = 7,
  /** A shinobi goes down. */
  Cry = 8,
  /** A blade picked up. */
  Pickup = 9,
  /** The lord is dead. */
  Gong = 10,
  /** Braziers flare up. */
  Kindle = 11,
}

/**
 * Something to hear at a point, which guards within earshot come to look at (the captain hears of it through them).
 * `a` is the entity's kind or a small count, per sound.
 */
export const Noise = defineAction('noise', { kind: t.enum<Sound>(), x: t.fixed(0.05), y: t.fixed(0.05), z: t.fixed(0.05), a: t.uint(8) });

export const enum ReportKind {
  /** A guard found one of theirs dead. */
  Body = 0,
  /** A guard sighted an intruder and raised the alarm. */
  Intruder = 1,
}

/** What a guard tells the captain: found a body, spotted an intruder. */
export const Report = defineAction('report', { kind: t.enum<ReportKind>(), guard: t.ref(), about: t.ref(), x: t.fixed(0.1), y: t.fixed(0.1) });

export const Feed = defineAction('feed', { text: t.string(80) });

export const ENTITIES = [Shinobi, Guard, Captain, Blade, Beacon, Round];
export const ACTIONS = [Strike, Tally, Wound, Order, Revive, Throw, Noise, Report, Feed];
