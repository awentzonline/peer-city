import type { BufferGeometry } from 'three';
import type { AnyAvatar } from './avatar';
import type { Side } from './intent';
import type { Vec3 } from './math';

/**
 * Hand-held tools: guns, axes, bows, seeds, food... anything an avatar picks up, carries, holds and uses. A
 * game lists its kinds of tool in a `Toolbox`, and each kind is a `Tool`, subclassed to give it behaviour
 * through the hooks below. A game usually has its own base tool class that says what picking one up and
 * dropping one does in its world (Peer City's leaves a pickup on the street).
 */

/** Replicated in place of a tool id when a hand is empty. */
export const NO_TOOL = 255;

export type HitResult = 'miss' | 'body' | 'head';

/** What a use felt like, for the device to reflect: recoil and haptics, and a hit marker. */
export interface UseEffect {
  /** Recoil strength: 0 for none, 1 = a pistol. */
  kick: number;
  hit?: HitResult;
}

export type Triple = readonly [number, number, number];

/** Where a tool's model comes from and how it's fitted. Give an `asset` or a `build`. */
export interface ToolModel {
  /** A model asset's name (see assets.ts). */
  asset?: string;
  /** Or build one in code: vertex-coloured geometry, drawn with the shared material. Called once. */
  build?: () => BufferGeometry;
  /** Radians (XYZ Euler) that turn the source model so its tip points down -Z with its top up +Y. */
  orient?: Triple;
  /** Length from back to tip in meters. The model is scaled evenly to fit. */
  length: number;
}

/**
 * How a tool sits in the hand. The grip, where a controller or the desktop view's hand holds it, is the
 * origin, in the hand's axes: +X right, +Y up and -Z where the hand points.
 */
export interface Grip {
  /** Where the tip (a muzzle, an axe head) is, in meters, before the angles below turn it. The model's front face is centred on it. */
  tip: Triple;
  /** Radians the tool is turned about the grip, relative to the hand: `yaw` + turns it left, then `pitch` + tips it up, then `roll` + turns it anticlockwise as seen from behind. */
  pitch?: number;
  yaw?: number;
  roll?: number;
}

/** A spot on a headset player's body for a tool, in torso space: +X right, +Y up, -Z forward, from the base of the neck. */
export interface StashSpot {
  at: Triple;
  /** Radians: `pitch` + tips the tool up (straight down is -π/2), then `roll` + turns it anticlockwise about the body's front-to-back axis as seen from behind. */
  pitch?: number;
  roll?: number;
}

export interface ToolOptions {
  name: string;
  model: ToolModel;
  grip: Grip;
  /** VR: where the first, second, ... of the kind go on your body when you get them. */
  stash?: readonly StashSpot[];
  /** Pickup glow colour. */
  color: number;
  /** Most of the kind an avatar can carry. Defaults to one for each hand. */
  max?: number;
  /** How many of the kind everyone always carries. Issued tools can't be lost and never run out. */
  issued?: number;
  /** Charges shared by all the tools of a kind: how many come with a pickup, the most you can carry, and what they're called ("ammo"). Omit for tools that never run out. */
  charges?: { pickup: number; max: number; unit?: string };
  /** Shortest time between uses, ms. */
  cooldownMs?: number;
  /** Keep using while the trigger is held, instead of once per pull. */
  automatic?: boolean;
  /** VR: show a laser from the tip while it's held. */
  laser?: boolean;
  /** Take it out on a crosshair when you get your first one. Default true; false for things you gather, like wood. */
  selectOnPickup?: boolean;
  /**
   * It can be put away in a pack instead of kept to hand: off the number keys on a crosshair, off the body
   * in VR (see Inventory). Default false, for tools that are always to hand.
   */
  stows?: boolean;
}

/** A tool in a hand, as its hooks see it. */
export interface ToolUse<A extends AnyAvatar = AnyAvatar> {
  readonly avatar: A;
  /** The tool in this hand, which is `this` inside its own hooks. Useful on the other hand (`avatar.hand(side)`). */
  readonly tool: Tool<A> | null;
  /** The tracked hand holding it, or null for the tool held in front of a crosshair view. */
  readonly side: Side | null;
  /** Where the tool acts from, and which way (a unit vector): a tracked hand's tip, or the eyes through the crosshair. */
  readonly origin: Vec3;
  readonly aim: Vec3;
  /** Where the tool's tip is seen, for effects such as tracers. The same as `origin` in a tracked hand. */
  readonly tip: Vec3;
  /** How fast `origin` moves relative to the avatar's feet, m/s: a tracked hand swinging the tool. About zero on a crosshair. */
  readonly velocity: Vec3;
  /** When the trigger went down (`avatar.now`), or null while it's up. Still set in `onRelease` and `onUnequip`. */
  readonly pressedAt: number | null;
  /** Use up charges. Running out takes every tool of the kind away, calling `onDrop` with 'spent'. */
  spend(n?: number): void;
  /** Tell the device what the use felt like. */
  effect(effect: UseEffect): void;
}

/** What picking up a tool got the avatar. */
export interface PickedUp {
  /** Whether there was room to keep the tool, not just its charges. */
  kept: boolean;
  /** How many of the kind the avatar now carries. */
  count: number;
  /** Charges taken. */
  charges: number;
}

/**
 * - dropped: it fell on the ground at (x, y), like the tool in hand when you die.
 * - lost: it's gone with the rest of your things, when you die or are arrested.
 * - spent: its charges ran out.
 */
export type DropReason = 'dropped' | 'lost' | 'spent';

export interface Drop {
  reason: DropReason;
  /** Charges that went with it. */
  charges: number;
  x: number;
  y: number;
}

/**
 * A kind of tool. There's one object per kind, shared by every avatar and hand holding one, so anything
 * that's per hand belongs on the hook's `ToolUse` (or in a WeakMap keyed by it), not on the tool.
 *
 * Hooks run in the avatar's rules, on the peer that owns the avatar, the same on every platform and
 * headless in tests. Override the ones you need. `A` is the game's avatar, which hooks can reach through
 * `ToolUse.avatar`.
 */
export class Tool<A extends AnyAvatar = AnyAvatar> {
  /** Replicated id: its place in the `Toolbox` it's in. */
  id = NO_TOOL;
  readonly name: string;
  readonly model: ToolModel;
  readonly grip: Required<Grip>;
  readonly stash: readonly StashSpot[];
  readonly color: number;
  readonly max: number;
  readonly issued: number;
  readonly charges: Readonly<{ pickup: number; max: number; unit: string }> | null;
  readonly cooldownMs: number;
  readonly automatic: boolean;
  readonly laser: boolean;
  readonly selectOnPickup: boolean;
  readonly stows: boolean;

  constructor(o: ToolOptions) {
    if (!o.model.asset === !o.model.build) throw new Error(`${o.name}: give its model an asset or a build, not both`);
    this.name = o.name;
    this.model = o.model;
    this.grip = { pitch: 0, yaw: 0, roll: 0, ...o.grip };
    this.stash = o.stash ?? [];
    this.color = o.color;
    this.issued = o.issued ?? 0;
    this.max = Math.max(o.max ?? 2, this.issued);
    this.charges = o.charges ? { unit: 'charges', ...o.charges } : null;
    this.cooldownMs = o.cooldownMs ?? 0;
    this.automatic = o.automatic ?? false;
    this.laser = o.laser ?? false;
    this.selectOnPickup = o.selectOnPickup ?? true;
    this.stows = o.stows ?? false;
  }

  /** Walked over a pickup of this kind that the avatar wanted. */
  onPickup(_avatar: A, _got: PickedUp): void {}

  /** The avatar no longer has the kind. */
  onDrop(_avatar: A, _drop: Drop): void {}

  /** It's now in a hand: grabbed from a holster, or selected on desktop. */
  onEquip(_hand: ToolUse<A>): void {}

  /** It's left the hand: stashed, switched away from, or gone from the inventory. */
  onUnequip(_hand: ToolUse<A>): void {}

  /** The trigger was pulled, or is still held on an `automatic` tool, and `cooldownMs` has passed. */
  onUse(_hand: ToolUse<A>): void {}

  /** The trigger was let go. */
  onRelease(_hand: ToolUse<A>): void {}

  /** Every frame it's in a hand, after any use. */
  onHold(_hand: ToolUse<A>, _dt: number): void {}
}

/** Every kind of tool in a game, in slot order. A tool's id is its place here, and is what goes over the network. */
export class Toolbox<T extends Tool<any> = Tool<any>> {
  readonly all: readonly T[];

  constructor(tools: T[]) {
    if (tools.length >= NO_TOOL) throw new Error(`at most ${NO_TOOL} kinds of tool`);
    tools.forEach((tool, i) => {
      if (tool.id !== NO_TOOL && tool.id !== i) throw new Error(`${tool.name} is already in another toolbox`);
      tool.id = i;
    });
    this.all = tools;
  }

  /** The tool with a replicated id, or null for an empty hand or an id this peer doesn't know. */
  get(id: number): T | null {
    return this.all[id] ?? null;
  }

  has(tool: Tool<any>): boolean {
    return this.all[tool.id] === tool;
  }
}
