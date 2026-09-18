import { defineAction, defineCommand, defineEntity, defineSingleton, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';

/**
 * Everything in Sewer Lordz that goes over the network. Meters, world axes (x, y on the ground, z up), on the grid of
 * the seeded sewer every peer builds for itself (sewer.ts), so only what changes is sent.
 *
 * Lordz are avatars wading through the sewage for loot. Goblins are NPCs, run by whichever peer owns each. Loot lies
 * buried in the silt, stuck in the fatberg or in the vault behind it, and is carried in a sack back to the ladder. The
 * fatberg itself is a handful of voxel chunks (fatberg.ts), and one migratable `Sewer` runs the dive and the water.
 */

export const enum LordMode {
  Active = 0,
  /** Down in the muck: bleeding out unless someone hauls them up. */
  Downed = 1,
  /** Bled out or drowned. Watches the others until the dive's over. */
  Dead = 2,
  /** Climbed back up the ladder. */
  Surfaced = 3,
}

export const Lord = defineEntity({
  name: 'lord',
  fields: {
    ...BODY_FIELDS,
    name: t.string(16),
    skin: t.uint(8),
    mode: t.enum<LordMode>(),
    hp: t.uint(8, 5),
    /** Air left, 0..1: runs out with your head under. */
    air: t.fixed(0.05, 1, 'none'),
    /** Items in the sack on your back, and what they're worth. */
    sack: t.uint(8),
    /** The goblin in a hand, or 0. */
    holding: t.ref(),
    /** Pressure in the hose, 0..100. */
    charge: t.uint(8),
    /** The hose is spraying, from the hand that holds it. */
    spraying: t.bool(),
    /** Counts punches thrown, so everyone sees each swing. */
    punches: t.uint(8),
    /** Downed: how far someone's got hauling them up, 0..1, and how long until they bleed out, s. */
    revive: t.fixed(0.05, 0, 'none'),
    bleed: t.uint(8),
    /** Which dive they're on (`Sewer.dive`): a new one puts them back at the ladder. */
    dive: t.uint(16),
  },
  priority: 3,
  snapDistance: 12,
});

export const enum GoblinMode {
  Wander = 0,
  /** After someone. */
  Chase = 1,
  /** Running for a drain, loot or not. */
  Flee = 2,
  /** In someone's hand: its owner is the holder's peer. */
  Held = 3,
  /** Knocked silly for a moment. */
  Stagger = 4,
  /** Splattered: gone as soon as everyone's seen it. */
  Dead = 5,
  /** Down a drain and away. */
  Gone = 6,
}

export const Goblin = defineEntity({
  name: 'goblin',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    /** Above the ground: only when lifted by a hand. */
    z: t.fixed(0.02),
    angle: t.angle(8),
    mode: t.enum<GoblinMode>(),
    hp: t.uint(8, 2),
    /** Who it's after, where it's going, and who's holding it (in the schema so they survive a change of owner). */
    target: t.ref(),
    tx: t.fixed(0.25),
    ty: t.fixed(0.25),
    heldBy: t.ref(),
    /** Loot it's run off with, or 0. */
    carrying: t.ref(),
    /** Counts its scratches, so everyone sees each lunge. */
    strikes: t.uint(8),
    look: t.uint(8),
    dive: t.uint(16),
  },
  migratable: true,
  interpolate: ['x', 'y', 'z', 'angle'],
  snapDistance: 8,
});

export const enum LootKind {
  Coins = 0,
  Ring = 1,
  Watch = 2,
  Teeth = 3,
  Gem = 4,
  Crown = 5,
  Toilet = 6,
}

export const enum LootWhere {
  /** In the silt at the bottom: find it with the detector and dig. */
  Buried = 0,
  /** Lying loose on the bottom, or on a walkway where you can see it. */
  Lying = 1,
  /** Stuck inside the fatberg until the fat round it's blasted away. */
  Stuck = 2,
  /** In a Lord's sack, or a goblin's arms (`carrier`). Its owner is the carrier's peer. */
  Carried = 3,
}

export const Loot = defineEntity({
  name: 'loot',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    z: t.fixed(0.02),
    kind: t.enum<LootKind>(),
    where: t.enum<LootWhere>(),
    carrier: t.ref(),
    dive: t.uint(16),
  },
  migratable: true,
  interpolate: ['x', 'y', 'z'],
  snapDistance: 6,
});

/** One 8³ block of the fatberg's voxels, two bits of density each (see fatberg.ts). */
export const FatChunk = defineEntity({
  name: 'fatchunk',
  fields: {
    x: t.fixed(0.5),
    y: t.fixed(0.5),
    /** Which chunk of the fatberg's grid. */
    ci: t.uint(8),
    cells: t.bytes(128),
    dive: t.uint(16),
  },
  migratable: true,
  interpolate: [],
});

export const enum Phase {
  /** Lordz gather at the foot of the ladder; the dive starts when the clock runs out. */
  Gather = 0,
  Dive = 1,
  /** How it ended is in `result`. */
  Over = 2,
}

export const enum Result {
  None = 0,
  /** Someone made it back up the ladder with the haul. */
  Rich = 1,
  /** Nobody did: the sewer keeps it all. */
  Lost = 2,
}

/** How many relief valves there are. The sewer's `v0`.. fields say how far open each is. */
export const VALVES = 4;

export const Sewer = defineSingleton({
  name: 'sewer',
  fields: {
    x: t.fixed(1),
    y: t.fixed(1),
    phase: t.enum<Phase>(),
    dive: t.uint(16),
    timer: t.fixed(0.1, 0, 'none'),
    /** The sewage's surface height, m. */
    water: t.fixed(0.01, 0.55, 'none'),
    /** A surge is coming down the pipes: the water's rising fast. */
    surge: t.bool(),
    /** How far open each relief valve is, 0..1. They creep shut on their own. */
    v0: t.fixed(0.01, 0, 'none'),
    v1: t.fixed(0.01, 0, 'none'),
    v2: t.fixed(0.01, 0, 'none'),
    v3: t.fixed(0.01, 0, 'none'),
    /** There's a way through the fatberg. */
    breached: t.bool(),
    /** Loot banked at the ladder this dive, and what it's worth. */
    banked: t.uint(8),
    worth: t.uint(16),
    result: t.enum<Result>(),
    surfaced: t.uint(8),
    lost: t.uint(8),
  },
  migratable: true,
  interpolate: [],
});

export type ValveField = 'v0' | 'v1' | 'v2' | 'v3';
export const VALVE_FIELDS: readonly ValveField[] = ['v0', 'v1', 'v2', 'v3'];

// ---------------------------------------------------------------------------
// Actions: commands, carried out by their target's owner, and events, shown by whoever's near
// ---------------------------------------------------------------------------

/** A goblin scratched a Lord. */
export const Hurt = defineCommand('hurt', { target: t.ref(), by: t.ref(), amount: t.uint(8), kx: t.fixed(0.05), ky: t.fixed(0.05) });

/** A fist (or a jet of water) hit a goblin, this hard (1 is a solid punch), along (dx, dy, dz). */
export const Punch = defineCommand('punch', { target: t.ref(), by: t.ref(), force: t.fixed(0.01), dx: t.fixed(0.01), dy: t.fixed(0.01), dz: t.fixed(0.01) });

/** A goblin grabbed something out of a Lord's sack: to the loot's owner, who hands it over if it's still there. */
export const Snatch = defineCommand('snatch', { target: t.ref(), by: t.ref() });

/** A Lord is hauling a downed one up: sent every moment they keep at it. */
export const Revive = defineCommand('revive', { target: t.ref(), by: t.ref() });

/** A hand on a relief valve: open it by `amount`. */
export const TurnValve = defineCommand('turnvalve', { target: t.ref(), valve: t.uint(8), amount: t.fixed(0.001) });

/** A jet of water hit voxel (u, v, w) of the fatberg: to that chunk's owner, which blasts fat away round it. */
export const Spray = defineCommand('spray', { target: t.ref(), u: t.uint(8), v: t.uint(8), w: t.uint(8), power: t.fixed(0.01) });

/** Loot reached the ladder: to the sewer's owner, which counts it. */
export const Bank = defineCommand('bank', { target: t.ref(), by: t.ref(), kind: t.enum<LootKind>() });

export const enum SplatKind {
  /** Punched clean off its feet: a ragdoll. */
  Fling = 0,
  /** Burst into gunk and pieces. */
  Gib = 1,
  /** Torn in half: two ragdolls and a lot of gunk. */
  Tear = 2,
}

/** A goblin met its end. Everyone near shows it: ragdolls and gunk are local (ragdoll.ts). */
export const Splat = defineAction('splat', {
  goblin: t.ref(),
  kind: t.enum<SplatKind>(),
  x: t.fixed(0.02),
  y: t.fixed(0.02),
  z: t.fixed(0.02),
  angle: t.angle(8),
  /** Which way, and how hard, m/s. */
  vx: t.fixed(0.05),
  vy: t.fixed(0.05),
  vz: t.fixed(0.05),
});

/** Fat broke off the fatberg: these voxels (packed u, v, w bytes) came away, and fall as lumps. Cosmetic. */
export const Crumble = defineAction('crumble', { ci: t.uint(8), voxels: t.bytes(240) });

export const enum Sound {
  /** A goblin lunges. */
  Scratch = 0,
  /** A goblin grabs loot out of a sack. */
  Snatch = 1,
  /** Loot's dug up. */
  Dig = 2,
  /** Loot's banked. */
  Bank = 3,
  /** A Lord goes down. */
  Down = 4,
  /** A punch lands without killing. */
  Thump = 5,
  /** A goblin's grabbed. */
  Grab = 6,
  /** A goblin gets down a drain. */
  Escape = 7,
  /** The fatberg gives way. */
  Breach = 8,
  /** Water starts pouring through an opened valve. */
  Gush = 9,
}

/** Something to hear, and see, at a point. */
export const Noise = defineAction('noise', { kind: t.enum<Sound>(), x: t.fixed(0.05), y: t.fixed(0.05), z: t.fixed(0.05), a: t.uint(8) });

export const Feed = defineAction('feed', { text: t.string(80) });

export const ENTITIES = [Lord, Goblin, Loot, FatChunk, Sewer];
export const ACTIONS = [Hurt, Punch, Snatch, Revive, TurnValve, Spray, Bank, Splat, Crumble, Noise, Feed];
