import { defineAction, defineCommand, defineEntity, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';

/**
 * Everything in Peer Wilds that goes over the network. Like Peer City the world is simulated on the ground
 * plane (`x`, `y` meters, headings face (cos a, sin a)), but the ground has height: every peer works it out
 * from the seeded land, so only positions on the ground replicate.
 *
 * Times that matter for longer than a moment (when a crop was sown, when a fire burns out) are wall-clock
 * seconds (see clock.ts), which every peer agrees on without a server and which survive changing owners.
 */

export const Survivor = defineEntity({
  name: 'survivor',
  fields: {
    ...BODY_FIELDS, // position, head, hands, and the tools in them (by id in TOOLS, see kit.ts)
    hp: t.uint(8, 100),
    food: t.uint(8, 100), // 100 is full, 0 is starving
    skin: t.uint(8),
    name: t.string(16),
    draw: t.fixed(0.02), // how far a bow is drawn, 0..1, so others see the string pulled
  },
  priority: 3,
  snapDistance: 20,
});

export const enum AnimalKind {
  Deer = 0,
  Rabbit = 1,
  Wolf = 2,
}

export const enum AnimalMode {
  Graze = 0,
  Flee = 1,
  Hunt = 2,
  Dead = 3,
}

export const Animal = defineEntity({
  name: 'animal',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    angle: t.angle(8),
    kind: t.uint(8),
    hp: t.uint(8, 60),
    mode: t.uint(8),
    target: t.ref(), // who it's running from or hunting (in the schema so it survives migration)
    tx: t.fixed(0.5), // where it's wandering to
    ty: t.fixed(0.5),
    meat: t.uint(8), // portions still on a carcass
  },
  migratable: true,
  cullDistance: 150,
  snapDistance: 15,
});

export const enum Crop {
  None = 0, // tilled soil
  Carrot = 1,
}

/** A tilled plot of soil, perhaps with a crop in it. Growth is worked out from `planted` on every peer, so nothing ticks. */
export const Plot = defineEntity({
  name: 'plot',
  fields: { x: t.fixed(0.05), y: t.fixed(0.05), crop: t.uint(8), planted: t.uint(32) },
  migratable: true,
  interpolate: [],
});

/** A felled tree (`tree` is its index in the land's obstacles). The tree grows back when the stump goes. */
export const Stump = defineEntity({
  name: 'stump',
  fields: { x: t.fixed(0.05), y: t.fixed(0.05), tree: t.uint(32), felled: t.uint(32) },
  migratable: true,
  interpolate: [],
});

export const Campfire = defineEntity({
  name: 'campfire',
  fields: { x: t.fixed(0.05), y: t.fixed(0.05), until: t.uint(32) }, // wall-clock second it burns out
  migratable: true,
  interpolate: [],
});

/** Something lying on the ground to pick up: `amount` charges of a tool, by id in TOOLS. */
export const Item = defineEntity({
  name: 'item',
  fields: { x: t.fixed(0.05), y: t.fixed(0.05), tool: t.uint(8), amount: t.uint(16) },
  migratable: true,
  cullDistance: 160,
  interpolate: [],
});

// ---------------------------------------------------------------------------
// Actions: commands, carried out by their target's owner, and events, shown by whoever's near
// ---------------------------------------------------------------------------

/** An arrow leaves a bow. Everyone nearby flies it for show; only the shooter's peer decides what it hits. */
export const Loose = defineAction('loose', {
  x: t.fixed(0.02),
  y: t.fixed(0.02),
  z: t.fixed(0.02),
  vx: t.fixed(0.05),
  vy: t.fixed(0.05),
  vz: t.fixed(0.05),
  shooter: t.ref(),
});

/** The victim's owner applies it. */
export const Damage = defineCommand('damage', {
  target: t.ref(),
  amount: t.uint(8),
  attacker: t.ref(), // survivor or animal (0 = the world: hunger, cold)
  kx: t.fixed(0.05), // knockback, m/s
  ky: t.fixed(0.05),
});

/** A victim's owner tells the attacker's owner they brought down an animal. */
export const Hunted = defineCommand('hunted', { attacker: t.ref(), kind: t.uint(8) }, { target: 'attacker' });

/** Carve a portion of meat off a carcass, which drops beside it. */
export const Butcher = defineCommand('butcher', { animal: t.ref() }, { target: 'animal' });

/** Keep a fire burning `seconds` longer. */
export const Fuel = defineCommand('fuel', { fire: t.ref(), seconds: t.uint(16) }, { target: 'fire' });

/** An axe bit into something: chips fly and it thunks. Cosmetic. */
export const Chop = defineAction('chop', { x: t.fixed(0.05), y: t.fixed(0.05), z: t.fixed(0.05), wood: t.bool() });

export const Feed = defineAction('feed', { text: t.string(80) });

export const ENTITIES = [Survivor, Animal, Plot, Stump, Campfire, Item];
export const ACTIONS = [Loose, Damage, Hunted, Butcher, Fuel, Chop, Feed];
