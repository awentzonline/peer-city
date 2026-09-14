import { defineAction, defineEntity, t } from '@engine/index';

/**
 * Everything that goes over the network is declared here. Each field's type
 * decides its precision and byte cost; only fields that change are sent.
 */

export const Player = defineEntity({
  name: 'player',
  fields: {
    x: t.fixed(0.5),
    y: t.fixed(0.5),
    angle: t.angle(8),
    hp: t.uint(8, 100),
    skin: t.uint(8),
    name: t.string(16),
    car: t.ref(), // vehicle currently driven (0 = on foot)
    wanted: t.uint(8),
    cash: t.uint(32),
    kills: t.uint(16),
    moving: t.bool(),
  },
  priority: 3,
  snapDistance: 200,
});

export const enum CarMode {
  Parked = 0,
  Traffic = 1,
  Driven = 2,
  Abandoned = 3,
  Wrecked = 4,
  Chase = 5,
}

export const enum CarKind {
  Sedan = 0,
  Taxi = 1,
  Police = 2,
  Sport = 3,
  Van = 4,
}

export const Car = defineEntity({
  name: 'car',
  fields: {
    x: t.fixed(0.5),
    y: t.fixed(0.5),
    angle: t.angle(10),
    speed: t.fixed(1, 0, 'none'),
    kind: t.uint(8),
    color: t.uint(8),
    hp: t.uint(8, 100),
    driver: t.ref(),
    mode: t.uint(8),
    // Traffic AI state lives in the schema so it survives migration to another peer.
    dir: t.uint(8), // 0 E, 1 S, 2 W, 3 N
    ri: t.uint(8), // road index
    ni: t.uint(8), // next intersection index
    nd: t.uint(8, 255), // chosen exit direction at next intersection
    target: t.ref(), // police chase target
    siren: t.bool(),
  },
  migratable: true,
  priority: 2,
  cullDistance: 1700,
  snapDistance: 300,
});

export const enum PedMode {
  Walk = 0,
  Flee = 1,
  Dead = 2,
  Attack = 3, // police officer pursuing `target`
}

export const Ped = defineEntity({
  name: 'ped',
  fields: {
    x: t.fixed(0.5),
    y: t.fixed(0.5),
    angle: t.angle(8),
    skin: t.uint(8),
    hp: t.uint(8, 30),
    mode: t.uint(8),
    tx: t.uint(16), // target tile
    ty: t.uint(16),
    cop: t.bool(),
    target: t.ref(), // player an officer is after (in the schema so pursuit survives migration)
  },
  migratable: true,
  cullDistance: 1500,
});

export const enum PickupKind {
  Cash = 0,
  Health = 1,
}

export const Pickup = defineEntity({
  name: 'pickup',
  fields: { x: t.fixed(1), y: t.fixed(1), kind: t.uint(8), amount: t.uint(16) },
  migratable: true,
  cullDistance: 1800,
  interpolate: [],
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Cosmetic gunfire: tracer, sound, and panic for nearby pedestrians. */
export const Shot = defineAction('shot', {
  x: t.fixed(1),
  y: t.fixed(1),
  angle: t.angle(12),
  dist: t.uint(16),
  shooter: t.ref(),
});

export const enum DamageCause {
  Bullet = 0,
  Vehicle = 1,
  Explosion = 2,
  Fire = 3,
}

/** Sent to the owner of the victim, who applies it authoritatively. */
export const Damage = defineAction('damage', {
  target: t.ref(),
  amount: t.uint(8),
  attacker: t.ref(), // player entity id (0 = world/NPC)
  cause: t.uint(8),
  kx: t.fixed(1), // knockback impulse
  ky: t.fixed(1),
});

export const Explosion = defineAction('boom', { x: t.fixed(1), y: t.fixed(1) });
export const Horn = defineAction('horn', { car: t.ref() });
/** An officer finished cuffing `target`; sent to the suspect's owner, who checks the officer is really there. */
export const Busted = defineAction('busted', { target: t.ref(), cop: t.ref() });
export const Feed = defineAction('feed', { text: t.string(80) });
/** Victim tells the attacker's owner about a kill, so crimes and cash are credited. */
export const Kill = defineAction('kill', { attacker: t.ref(), victimKind: t.uint(8), x: t.fixed(1), y: t.fixed(1) });

export const ENTITIES = [Player, Car, Ped, Pickup];
export const ACTIONS = [Shot, Damage, Explosion, Horn, Busted, Feed, Kill];
