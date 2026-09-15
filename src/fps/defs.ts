import { defineAction, defineEntity, t } from '@engine/index';

/**
 * Everything that goes over the network. The world is simulated on the ground
 * plane: `x`/`y` are meters on the ground and `z` is height. (three.js renders
 * x → X, z → Y, y → Z.) Headings face (cos a, sin a).
 */

export const Player = defineEntity({
  name: 'player',
  fields: {
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    z: t.fixed(0.02), // feet above the ground (jumping)
    yaw: t.angle(10), // where the head faces
    pitch: t.angle(10),
    head: t.fixed(0.02, 1.65), // head height above the feet (VR players crouch for real)
    hx: t.fixed(0.02), // gun hand relative to the feet, world axes
    hy: t.fixed(0.02),
    hz: t.fixed(0.02, 1.35),
    aimYaw: t.angle(10), // where the gun points
    aimPitch: t.angle(10),
    hp: t.uint(8, 100),
    skin: t.uint(8),
    name: t.string(16),
    car: t.ref(), // vehicle currently driven (0 = on foot)
    wanted: t.uint(8),
    cash: t.uint(32),
    kills: t.uint(16),
    vr: t.bool(),
    weapon: t.uint(8), // gun in hand (see arsenal.ts)
  },
  priority: 3,
  snapDistance: 20,
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
    x: t.fixed(0.02),
    y: t.fixed(0.02),
    angle: t.angle(12),
    speed: t.fixed(0.05, 0, 'none'),
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
  cullDistance: 210,
  snapDistance: 25,
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
    x: t.fixed(0.02),
    y: t.fixed(0.02),
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
  cullDistance: 190,
  snapDistance: 15,
});

export const enum PickupKind {
  Cash = 0,
  Health = 1,
  Weapon = 2, // `weapon`, with `amount` rounds
}

export const Pickup = defineEntity({
  name: 'pickup',
  fields: { x: t.fixed(0.05), y: t.fixed(0.05), kind: t.uint(8), amount: t.uint(16), weapon: t.uint(8) },
  migratable: true,
  cullDistance: 210,
  interpolate: [],
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const enum Impact {
  None = 0,
  Flesh = 1,
  Metal = 2,
  Wall = 3,
}

/** Cosmetic gunfire: tracer, sound, impact and panic for nearby pedestrians. */
export const Shot = defineAction('shot', {
  x: t.fixed(0.02),
  y: t.fixed(0.02),
  z: t.fixed(0.02),
  yaw: t.angle(14),
  pitch: t.angle(14),
  dist: t.fixed(0.05),
  impact: t.uint(8),
  shooter: t.ref(),
  weapon: t.uint(8),
  quiet: t.bool(), // extra shotgun pellets: tracer only
});

export const enum DamageCause {
  Bullet = 0,
  Vehicle = 1,
  Explosion = 2,
}

/** Sent to the owner of the victim, who applies it authoritatively. */
export const Damage = defineAction('damage', {
  target: t.ref(),
  amount: t.uint(8),
  attacker: t.ref(), // player entity id (0 = world/NPC)
  cause: t.uint(8),
  kx: t.fixed(0.05), // knockback impulse, m/s
  ky: t.fixed(0.05),
  head: t.bool(),
});

export const Explosion = defineAction('boom', { x: t.fixed(0.05), y: t.fixed(0.05) });
export const Horn = defineAction('horn', { car: t.ref() });
/** An officer finished cuffing `target`; sent to the suspect's owner, who checks the officer is really there. */
export const Busted = defineAction('busted', { target: t.ref(), cop: t.ref() });
export const Feed = defineAction('feed', { text: t.string(80) });
/** Victim tells the attacker's owner about a kill, so crimes and cash are credited. */
export const Kill = defineAction('kill', { attacker: t.ref(), victimKind: t.uint(8), x: t.fixed(0.05), y: t.fixed(0.05) });

export const ENTITIES = [Player, Car, Ped, Pickup];
export const ACTIONS = [Shot, Damage, Explosion, Horn, Busted, Feed, Kill];
