import { defineAction, defineCommand, defineEntity, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';

/**
 * Everything in Peer Haunt that goes over the network. Meters, world axes (x, y on the ground, z up), on the grid of
 * the seeded manor every peer builds for itself (manor.ts), so only what changes is sent.
 *
 * Two roles share the world. **Survivors** are avatars searching the house for keys by flashlight. **The Haunt** looks
 * down on the house with its roof off and spends dread to summon monsters and set them on the survivors. It has no body:
 * a `Haunt` entity says where it's looking and pointing, which survivors glimpse as a presence. One migratable `Round`
 * runs the night: waiting at the gate, the hunt, and how it ended.
 */

export const enum SurvivorMode {
  Alive = 0,
  /** Down and crawling: bleeding out unless someone helps them up. */
  Downed = 1,
  Dead = 2,
  /** Out through the gate. */
  Escaped = 3,
}

export const Survivor = defineEntity({
  name: 'survivor',
  fields: {
    ...BODY_FIELDS,
    name: t.string(16),
    skin: t.uint(8),
    mode: t.enum<SurvivorMode>(),
    hp: t.uint(8, 3),
    /** The flashlight's on, shining along the right hand's aim. */
    light: t.bool(),
    /** 0..100. */
    battery: t.uint(8, 100),
    /** The key they're carrying, or 0. */
    key: t.ref(),
    /** Downed: how far someone's got helping them up, 0..1, and how long until they bleed out, s. */
    revive: t.fixed(0.05, 0, 'none'),
    bleed: t.uint(8),
    /** Which night they're playing (`Round.round`): a new one puts them back at the gate. */
    round: t.uint(16),
  },
  priority: 3,
  snapDistance: 12,
});

export const enum MonsterKind {
  Shade = 0,
  Crawler = 1,
  Brute = 2,
}

export const enum MonsterMode {
  /** Standing about, or wandering. */
  Idle = 0,
  /** Going where the Haunt sent it, and taking on anyone it meets. */
  Move = 1,
  /** After a survivor. */
  Hunt = 2,
  /** Dissolving. */
  Dead = 3,
}

export const Monster = defineEntity({
  name: 'monster',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    angle: t.angle(8),
    kind: t.enum<MonsterKind>(),
    mode: t.enum<MonsterMode>(),
    hp: t.uint(8, 30),
    /** Who it's after, and where it's going (in the schema so they survive a change of owner). */
    target: t.ref(),
    tx: t.fixed(0.25),
    ty: t.fixed(0.25),
    /** The Haunt that summoned it, whose orders it takes, or 0 for the house's own. */
    haunt: t.ref(),
    /** How brightly a flashlight's on it right now, 0..1: it smokes and shrinks from the light. */
    lit: t.fixed(0.1, 0, 'none'),
    /** Counts its attacks, so everyone sees each lunge. */
    strikes: t.uint(8),
    round: t.uint(16),
  },
  migratable: true,
  snapDistance: 10,
});

/** Someone playing the Haunt: where they're looking, and pointing (where survivors feel a presence). */
export const Haunt = defineEntity({
  name: 'haunt',
  fields: {
    x: t.fixed(0.25),
    y: t.fixed(0.25),
    name: t.string(16),
    platform: t.uint(8),
    /** Where it's pointing on the ground, while `present`. */
    px: t.fixed(0.05),
    py: t.fixed(0.05),
    present: t.bool(),
    dread: t.uint(8),
  },
  interpolate: ['px', 'py'],
});

/** A key to the gate: lying somewhere in the house, carried, or in the pedestal by the gate. */
export const Key = defineEntity({
  name: 'key',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    z: t.fixed(0.02),
    /** The survivor carrying it, whose peer owns it while they do. */
    holder: t.ref(),
    /** Which socket of the pedestal it's in, plus one, or 0. */
    socket: t.uint(8),
    round: t.uint(16),
  },
  migratable: true,
  interpolate: ['x', 'y', 'z'],
  snapDistance: 6,
});

export const enum Phase {
  /** Survivors gather in the yard; the hunt starts when the clock runs out. */
  Waiting = 0,
  Hunt = 1,
  /** How it ended is in `result`. */
  Over = 2,
}

export const enum Result {
  None = 0,
  /** At least one survivor got out. */
  Escaped = 1,
  /** Nobody did. */
  Claimed = 2,
}

export const Round = defineEntity({
  name: 'round',
  fields: {
    x: t.fixed(1),
    y: t.fixed(1),
    phase: t.enum<Phase>(),
    round: t.uint(16),
    timer: t.fixed(0.1, 0, 'none'),
    /** Keys in the pedestal, of `needed`. The gate's open once they're all in. */
    placed: t.uint(8),
    needed: t.uint(8, 3),
    result: t.enum<Result>(),
    escaped: t.uint(8),
    claimed: t.uint(8),
  },
  migratable: true,
  interpolate: [],
});

// ---------------------------------------------------------------------------
// Actions: commands, carried out by their target's owner, and events, shown by whoever's near
// ---------------------------------------------------------------------------

/** A monster struck a survivor. */
export const Hurt = defineCommand('hurt', {
  target: t.ref(),
  by: t.ref(),
  amount: t.uint(8),
  kx: t.fixed(0.05),
  ky: t.fixed(0.05),
});

/** A flashlight's on a monster: `amount` of its light this step, 0..1 per second of full beam. */
export const Burn = defineCommand('burn', { target: t.ref(), by: t.ref(), amount: t.fixed(0.01) });

export const enum OrderKind {
  /** Go there, taking on anyone met on the way. */
  Move = 0,
  /** Go after `victim`. */
  Attack = 1,
}

/** The Haunt sends one of its monsters somewhere, or after someone. */
export const Order = defineCommand('order', { target: t.ref(), kind: t.enum<OrderKind>(), x: t.fixed(0.25), y: t.fixed(0.25), victim: t.ref() });

/** A survivor is helping a downed one up: sent every moment they keep at it. */
export const Revive = defineCommand('revive', { target: t.ref(), by: t.ref() });

/** A survivor's flashlight caught the Haunt's presence, which it can't stand. */
export const Glare = defineCommand('glare', { target: t.ref(), by: t.ref() });

export const enum Sound {
  /** A monster lunges. */
  Strike = 0,
  /** A monster dissolves in the light. */
  Banish = 1,
  /** A monster comes through. */
  Summon = 2,
  /** The Haunt whispers somewhere in the house. */
  Whisper = 3,
  /** A key's picked up. */
  Pickup = 4,
  /** A key goes in the pedestal. */
  Socket = 5,
  /** A survivor goes down. */
  Scream = 6,
}

/** Something to hear, and see, at a point. Cosmetic, except a whisper, which unsettles survivors near it. */
export const Noise = defineAction('noise', { kind: t.enum<Sound>(), x: t.fixed(0.05), y: t.fixed(0.05), z: t.fixed(0.05), a: t.uint(8) });

export const Feed = defineAction('feed', { text: t.string(80) });

export const ENTITIES = [Survivor, Monster, Haunt, Key, Round];
export const ACTIONS = [Hurt, Burn, Order, Revive, Glare, Noise, Feed];
