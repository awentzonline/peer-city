import { defineAction, defineEntity, defineSingleton, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';
import type { Grade, Move } from './moves';

/**
 * Everything in High Five with Friends that goes over the network. Meters, world axes (x, y on the ground, z up).
 *
 * Pals are the players. Buddies are the team's NPCs (the coach, a big lineman and the mascot), run by whichever peer
 * owns each; a migratable `Team` makes sure there are always three of them. A five or a slap is decided by whoever
 * swung, and sent to everyone as a `Five` or `Slap` event: each peer adds the points to its own pal, and everyone
 * nearby sees and hears it.
 */

export const Pal = defineEntity({
  name: 'pal',
  fields: {
    ...BODY_FIELDS,
    name: t.string(16),
    skin: t.uint(8),
    score: t.uint(32),
    /** The longest combo they've kept going with anyone. */
    best: t.uint(8),
    /** The five they're holding out for someone to hit, and whether a one-handed one is in the left hand. */
    offer: t.enum<Move>(),
    offerLeft: t.bool(),
    /** The five they just pulled away: anyone who swings at it in the next moment is too slow. */
    yank: t.enum<Move>(),
    /** Bit 0 the right hand, bit 1 the left: a flat player's arm reaching out to where its hand is (headset hands always are). */
    reach: t.uint(8),
    /** Bit 0 the right hand, bit 1 the left: made into a fist. */
    fists: t.uint(8),
    /** Crouched: creeping up on someone makes no sound and gives no warning. */
    sneak: t.bool(),
    /** Winding up a slap on this one's backside, or 0. */
    windup: t.ref(),
    /** They'd rather not have their backside slapped, and don't slap anyone else's. */
    noSlaps: t.bool(),
  },
  priority: 3,
  snapDistance: 8,
});

export const enum BuddyMode {
  /** Strolling about the locker room or the field. */
  Wander = 0,
  /** Walking up to someone, to offer them a five or to take theirs. */
  Approach = 1,
  /** Holding out `offer` for `target` to hit. */
  Offer = 2,
  /** Swinging at `target`'s offer. */
  Swing = 3,
  /** The mascot, creeping round behind `target`. */
  Sneak = 4,
  /** The mascot, winding up a slap on `target`. */
  Slap = 5,
  /** Rubbing its backside, or celebrating: stands still for a moment. */
  React = 6,
}

/** Which buddy a `Buddy` is, by its `slot`. */
export const enum BuddyKind {
  Coach = 0,
  Lineman = 1,
  Mascot = 2,
}

export const Buddy = defineEntity({
  name: 'buddy',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    angle: t.angle(10),
    slot: t.enum<BuddyKind>(),
    mode: t.enum<BuddyMode>(),
    /** Who it's offering to, swinging at or creeping up on. In the schema so it survives a change of owner. */
    target: t.ref(),
    offer: t.enum<Move>(),
    /** Where it's wandering to. */
    tx: t.fixed(0.1, 0, 'none'),
    ty: t.fixed(0.1, 0, 'none'),
  },
  migratable: true,
  priority: 2,
  snapDistance: 8,
});

/** Keeps the team's buddies about: whoever runs it makes any that are missing. */
export const Team = defineSingleton({
  name: 'team',
  fields: {
    x: t.fixed(1),
    y: t.fixed(1),
  },
  interpolate: [],
});

/**
 * A five landed (or didn't), decided by `a`, who swung, at `b`. Everyone shows it; `a` and `b` each score it on their
 * own peer. `streak` is the pair's combo after it, and `points` what each of them gets for it (see `scoreFor`).
 */
export const Five = defineAction('five', {
  a: t.ref(),
  b: t.ref(),
  move: t.enum<Move>(),
  grade: t.enum<Grade>(),
  points: t.uint(16),
  streak: t.uint(8),
  /** Jumped into it. */
  air: t.bool(),
  x: t.fixed(0.01),
  y: t.fixed(0.01),
  z: t.fixed(0.01),
});

/** `a` slapped `b`'s backside, or `b` turned round in time and `denied` it. */
export const Slap = defineAction('slap', {
  a: t.ref(),
  b: t.ref(),
  denied: t.bool(),
  points: t.uint(16),
  x: t.fixed(0.01),
  y: t.fixed(0.01),
  z: t.fixed(0.01),
});

export const ENTITIES = [Pal, Buddy, Team];
export const ACTIONS = [Five, Slap];
