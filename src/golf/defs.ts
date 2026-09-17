import { defineAction, defineCommand, defineEntity, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';
import { HOLES } from './course';

/**
 * Everything in Peer Golf that goes over the network. Meters, world axes (x, y on the ground, z up).
 *
 * Each player is a `Golfer` who owns one `Ball`. Everyone plays the same hole at once: one migratable `Match` says
 * which, and when it's over. A few migratable `Cart`s are shared by everyone: whoever's driving one owns it.
 * Clubbing someone, or running them over, sends a `Knock` to their owner, the only peer that writes them.
 */

export const Golfer = defineEntity({
  name: 'golfer',
  fields: {
    ...BODY_FIELDS,
    name: t.string(16),
    skin: t.uint(8),
    ball: t.ref(),
    /** The cart they're driving, or 0. */
    cart: t.ref(),
    /** Knocked flat: drawn lying down, can't do anything until they're up. */
    down: t.bool(),
    /** Standing over their ball to play it (a crosshair golfer): drawn in their stance. */
    address: t.bool(),
    /** 0..1: how far back the club is drawn, for the backswing others see. */
    charge: t.fixed(0.05, 0, 'none'),
    /** Which round their card is for, and their strokes on each hole of it (0 = not played). */
    round: t.uint(16),
    card: t.bytes(HOLES),
  },
  priority: 3,
  snapDistance: 12,
});

export const enum BallMode {
  /** Sitting still, ready to play. */
  Rest = 0,
  /** In flight or rolling. */
  Moving = 1,
  Holed = 2,
  /** Picked up: too many strokes, or the hole ended before it was holed. */
  Out = 3,
}

export const Ball = defineEntity({
  name: 'ball',
  fields: {
    x: t.fixed(0.005),
    y: t.fixed(0.005),
    z: t.fixed(0.005),
    golfer: t.ref(),
    hole: t.uint(8),
    round: t.uint(16),
    strokes: t.uint(8),
    mode: t.enum<BallMode>(),
    color: t.uint(8),
  },
  interpolate: ['x', 'y', 'z'],
  priority: 3,
  snapDistance: 30,
  maxExtrapolateMs: 120,
});

export const Cart = defineEntity({
  name: 'cart',
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
    driver: t.ref(),
    /** Which of the course's carts it is: there's only ever one of each. */
    slot: t.uint(8),
  },
  interpolate: ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'speed', 'steer'],
  migratable: true,
  priority: 2,
  snapDistance: 10,
  maxExtrapolateMs: 200,
});

export const enum Phase {
  /** Everyone's playing `hole`; `timer` is the most time left. */
  Playing = 0,
  /** The hole's scores; `timer` until the next. */
  HoleOver = 1,
  /** The round's scores; `timer` until a new round. */
  Results = 2,
}

export const Match = defineEntity({
  name: 'match',
  fields: {
    x: t.fixed(1),
    y: t.fixed(1),
    phase: t.enum<Phase>(),
    round: t.uint(16),
    hole: t.uint(8),
    timer: t.fixed(0.1, 0, 'none'),
    /** Whether anyone has holed out yet, which shortens the time left. */
    first: t.bool(),
  },
  migratable: true,
  priority: 3,
  interpolate: [],
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Carried out by the golfer's owner: they're knocked flat and back along (kx, ky) m/s, out of any cart. */
export const Knock = defineCommand('knock', {
  target: t.ref(),
  by: t.ref(),
  kx: t.fixed(0.05),
  ky: t.fixed(0.05),
  /** 0 a club, 1 a cart, 2 a ball. */
  cause: t.uint(8),
});

export const enum Whack {
  /** A club through the air. */
  Swish = 0,
  /** A club into someone. */
  Bonk = 1,
  /** Carts into something hard. */
  Crash = 2,
  /** A ball into water. */
  Splash = 3,
}

/** Something to see and hear, for whoever's near. */
export const Noise = defineAction('noise', {
  kind: t.enum<Whack>(),
  x: t.fixed(0.05),
  y: t.fixed(0.05),
  z: t.fixed(0.05),
  power: t.fixed(0.05),
});

export const Feed = defineAction('feed', { text: t.string(80) });

export const ENTITIES = [Golfer, Ball, Cart, Match];
export const ACTIONS = [Knock, Noise, Feed];
