import { defineAction, defineEntity, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';
import { MAX_PARTS } from './parts';
import { FUEL_SECONDS } from './physics';

/**
 * Everything in Peer Derby that goes over the network. Meters, world axes (x, y on the ground, z up).
 *
 * Each player is a `Builder` (an avatar who walks the garage and builds) and owns one `Racer`. Anyone can add
 * parts to anyone's racer: they send an `Edit` to its owner, the only peer that writes it. The race itself is
 * one migratable `Race`, whose owner runs the countdown and decides when it's over.
 */

export const Builder = defineEntity({
  name: 'builder',
  fields: {
    ...BODY_FIELDS,
    name: t.string(16),
    skin: t.uint(8),
    racer: t.ref(),
    seated: t.bool(), // in their racer: drawn sitting in it, not standing
  },
  priority: 3,
  snapDistance: 12,
});

export const enum RacerMode {
  /** In its bay, being built. */
  Parked = 0,
  /** On the start grid, waiting for the go. */
  Gridded = 1,
  Racing = 2,
  Finished = 3,
}

/** A racer: its design, where it is, and how its race is going. A rigid body, so its rotation is a quaternion. */
export const Racer = defineEntity({
  name: 'racer',
  fields: {
    x: t.fixed(0.01),
    y: t.fixed(0.01),
    z: t.fixed(0.01),
    qx: t.fixed(0.002),
    qy: t.fixed(0.002),
    qz: t.fixed(0.002),
    qw: t.fixed(0.002, 1),
    speed: t.fixed(0.1), // along its nose, m/s: wheels spin by it
    steer: t.fixed(0.05),
    boost: t.bool(),
    design: t.bytes(1 + MAX_PARTS * 4), // see parts.ts
    broken: t.bytes(MAX_PARTS / 8), // a bit per part torn off in this race
    bay: t.uint(8),
    color: t.uint(8),
    builder: t.ref(),
    mode: t.uint(8),
    ready: t.bool(),
    round: t.uint(16), // the race it's in (Race.round)
    finish: t.uint(32), // race time at the line, ms (0 = not yet)
    progress: t.fixed(0.5, 0, 'none'), // furthest along the track, m
    fuel: t.fixed(0.1, FUEL_SECONDS, 'none'),
  },
  interpolate: ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'speed', 'steer'],
  priority: 3,
  snapDistance: 10,
  maxExtrapolateMs: 200,
});

export const enum Phase {
  /** Building in the garage. Once anyone's ready, `timer` counts down to starting anyway. */
  Building = 0,
  /** Racers are on the grid; `timer` is the seconds to go. */
  Countdown = 1,
  /** `timer` is the most time left. */
  Racing = 2,
  /** Standings; `timer` until everyone goes back to the garage. */
  Results = 3,
}

export const Race = defineEntity({
  name: 'race',
  fields: {
    x: t.fixed(1),
    y: t.fixed(1),
    phase: t.uint(8),
    round: t.uint(16),
    timer: t.fixed(0.1, 0, 'none'),
  },
  migratable: true,
  priority: 3,
  interpolate: [],
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const enum EditOp {
  Add = 0,
  Remove = 1,
}

/**
 * Sent to a racer's owner. By cell, not by index, so edits from several builders at once don't trip over each
 * other: Add puts `kind` in cell (x, y, z) against the neighbour on its `dir` side; Remove takes out the cell.
 */
export const Edit = defineAction('edit', {
  racer: t.ref(),
  op: t.uint(8),
  x: t.int(),
  y: t.int(),
  z: t.int(),
  dir: t.uint(8),
  kind: t.uint(8),
});

/** Parts tore off a racer: everyone nearby throws their own copies, moving at about (vx, vy, vz). */
export const Shatter = defineAction('shatter', {
  racer: t.ref(),
  parts: t.bytes(MAX_PARTS),
  vx: t.fixed(0.1),
  vy: t.fixed(0.1),
  vz: t.fixed(0.1),
});

export const Feed = defineAction('feed', { text: t.string(80) });

export const ENTITIES = [Builder, Racer, Race];
export const ACTIONS = [Edit, Shatter, Feed];
