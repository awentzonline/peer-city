import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { Settings } from '../crossplay/settings';
import type { Course } from './course';
import type { Ball, Cart, Golfer, Match } from './defs';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { CartWorld } from './carts';
import type { Sfx } from './sfx';

export { TAU, angleDiff, clamp, direction } from '../crossplay/math';
export type { Vec3 } from '../crossplay/math';

export type GolferEntity = NetEntity<StateOf<typeof Golfer>>;
export type BallEntity = NetEntity<StateOf<typeof Ball>>;
export type CartEntity = NetEntity<StateOf<typeof Cart>>;
export type MatchEntity = NetEntity<StateOf<typeof Match>>;

/** Shared services for Peer Golf's systems. No device in here (see crossplay/role.ts). */
export interface GolfContext {
  world: NetWorld;
  course: Course;
  carts: CartWorld;
  sfx: Sfx;
  hud: Hud;
  settings: Settings;
  fx: Effects;
  /** The local player's golfer, and their ball. */
  me: GolferEntity | null;
  ball: BallEntity | null;
  /** The match, if this peer knows of it yet. */
  match(): MatchEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}
