import * as THREE from 'three';
import { merge, paint } from '../crossplay/models';
import { Tool, Toolbox, type ToolOptions, type ToolUse } from '../crossplay/tool';
import { Weapon } from './defs';
import type { ShinobiRole } from './shinobi';

export type Use = ToolUse<ShinobiRole>;

/** How far a tanto reaches from the eyes on a crosshair, m. */
export const STAB_REACH = 1.9;

/** How a thrown weapon flies. */
export interface Flight {
  /** m/s thrown from a crosshair, and the most a tracked hand can put into it. */
  speed: number;
  maxSpeed: number;
  /** m/s², down. */
  gravity: number;
  /** Damage, of a guard's 2 (a samurai's 4). */
  damage: number;
}

export const FLIGHTS: Record<Weapon.Kunai | Weapon.Shuriken | Weapon.Arrow, Flight> = {
  [Weapon.Kunai]: { speed: 24, maxSpeed: 30, gravity: 9.8, damage: 2 },
  [Weapon.Shuriken]: { speed: 30, maxSpeed: 36, gravity: 5, damage: 1 },
  [Weapon.Arrow]: { speed: 34, maxSpeed: 34, gravity: 6, damage: 1 },
};

/** A shinobi's weapon: which one it is on the wire. */
export class NinjaTool extends Tool<ShinobiRole> {
  constructor(
    options: ToolOptions,
    readonly weapon: Weapon,
  ) {
    super(options);
  }
}

/**
 * The tanto: a short blade for close work. Everyone has one. On a crosshair it strikes what's in front of you; in a
 * tracked hand you swing it through them. From behind, or on a guard that isn't alarmed, it kills outright and quietly.
 */
export class Tanto extends NinjaTool {
  constructor() {
    super(
      {
        name: 'Tanto',
        model: { build: tantoGeometry, length: 0.36 },
        grip: { tip: [0, 0, -0.3] },
        // on the left hip, point down, to draw across the body
        stash: [{ at: [-0.18, -0.52, -0.08], pitch: -Math.PI / 2 - 0.3, roll: 0.25 }],
        color: 0xd8dde8,
        issued: 1,
        cooldownMs: 450,
      },
      Weapon.Tanto,
    );
  }

  override onUse(use: Use): void {
    if (use.side === null) use.avatar.stab(use);
  }

  override onHold(use: Use): void {
    if (use.side !== null) use.avatar.slash(use);
  }
}

/**
 * A kunai or a shuriken. On a crosshair, the trigger throws one straight away. In a tracked hand, hold the trigger (a
 * pinch on the blade) and let go of it mid-swing: it flies the way your hand was going, as fast as it was.
 */
export class Thrown extends NinjaTool {
  constructor(
    options: ToolOptions,
    weapon: Weapon.Kunai | Weapon.Shuriken,
    readonly flight: Flight,
  ) {
    super(options, weapon);
  }

  override onUse(use: Use): void {
    if (use.side === null) use.avatar.hurl(use, this);
  }

  override onHold(use: Use): void {
    if (use.side !== null && use.pressedAt !== null) use.avatar.windUp(use);
  }

  override onRelease(use: Use): void {
    if (use.side !== null) use.avatar.letFly(use, this);
  }
}

export const TANTO = new Tanto();

export const KUNAI = new Thrown(
  {
    name: 'Kunai',
    model: { build: kunaiGeometry, length: 0.26 },
    grip: { tip: [0, 0, -0.17] },
    stash: [{ at: [0.17, -0.22, -0.17], pitch: -Math.PI / 2 }],
    color: 0x9aa3b5,
    max: 1,
    charges: { pickup: 1, max: 5, unit: 'kunai' },
    cooldownMs: 350,
    selectOnPickup: false,
  },
  Weapon.Kunai,
  FLIGHTS[Weapon.Kunai],
);

export const SHURIKEN = new Thrown(
  {
    name: 'Shuriken',
    model: { build: shurikenGeometry, length: 0.13 },
    grip: { tip: [0, 0, -0.06], pitch: 0 },
    // flat on the chest, on the left
    stash: [{ at: [-0.16, -0.2, -0.17], pitch: 0, roll: Math.PI / 2 }],
    color: 0xc0c8d8,
    max: 1,
    charges: { pickup: 1, max: 12, unit: 'shuriken' },
    cooldownMs: 220,
    selectOnPickup: false,
  },
  Weapon.Shuriken,
  FLIGHTS[Weapon.Shuriken],
);

export const TOOLS = new Toolbox<NinjaTool>([TANTO, KUNAI, SHURIKEN]);

/** What each shinobi starts a night with. */
export const LOADOUT = { kunai: 3, shuriken: 8 };

/** The tool for a thrown weapon, or null for one that isn't a shinobi's. */
export function thrownTool(weapon: Weapon): Thrown | null {
  return weapon === Weapon.Kunai ? KUNAI : weapon === Weapon.Shuriken ? SHURIKEN : null;
}

// ---------------------------------------------------------------------------
// Models: pointing down -Z, top up +Y, grip at the origin
// ---------------------------------------------------------------------------

const STEEL = 0xc9ced8;
const DARK_STEEL = 0x5a6070;
const WRAP = 0x1d1a22;

export function tantoGeometry(): THREE.BufferGeometry {
  return merge([
    // the handle, wrapped, with a small guard
    paint(new THREE.BoxGeometry(0.03, 0.032, 0.11).translate(0, 0, 0.02), WRAP),
    paint(new THREE.BoxGeometry(0.05, 0.012, 0.045).translate(0, 0, -0.04), 0x8a7440),
    // the blade, a little curved up at the point
    paint(new THREE.BoxGeometry(0.008, 0.028, 0.2).translate(0, 0.002, -0.14), STEEL),
    paint(new THREE.BoxGeometry(0.007, 0.018, 0.05).rotateX(0.25).translate(0, 0.006, -0.26), STEEL),
  ]);
}

export function kunaiGeometry(): THREE.BufferGeometry {
  const leaf = new THREE.ConeGeometry(0.022, 0.13, 4).rotateX(-Math.PI / 2).scale(1, 0.35, 1).translate(0, 0, -0.1);
  return merge([
    paint(new THREE.TorusGeometry(0.018, 0.005, 5, 10).translate(0, 0, 0.085), DARK_STEEL),
    paint(new THREE.BoxGeometry(0.014, 0.014, 0.08).translate(0, 0, 0.03), WRAP),
    paint(new THREE.ConeGeometry(0.022, 0.03, 4).rotateX(Math.PI / 2).scale(1, 0.35, 1).translate(0, 0, -0.025), DARK_STEEL),
    paint(leaf, DARK_STEEL),
  ]);
}

export function shurikenGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [paint(new THREE.CylinderGeometry(0.018, 0.018, 0.006, 10).rotateX(Math.PI / 2), 0x3a3f4a)];
  for (let k = 0; k < 4; k++) {
    const point = new THREE.ConeGeometry(0.02, 0.06, 3).rotateZ(-Math.PI / 2).scale(1, 1, 0.15).translate(0.045, 0, 0);
    parts.push(paint(point.rotateZ((k * Math.PI) / 2), STEEL));
  }
  // flat in the plane of the hand, facing up: lie it along -Z
  return merge(parts).rotateX(-Math.PI / 2);
}

export function arrowGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.006, 0.006, 0.8, 5).rotateX(Math.PI / 2), 0x6a5236),
    paint(new THREE.ConeGeometry(0.014, 0.05, 5).rotateX(-Math.PI / 2).translate(0, 0, -0.42), DARK_STEEL),
    paint(new THREE.BoxGeometry(0.002, 0.03, 0.1).translate(0, 0, 0.36), 0xe8e2d4),
    paint(new THREE.BoxGeometry(0.03, 0.002, 0.1).translate(0, 0, 0.36), 0xe8e2d4),
  ]);
}
