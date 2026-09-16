import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { Arrows } from './arrows';
import type { Animal, Campfire, Item, Plot, Stump, Survivor } from './defs';
import type { Settings } from '../crossplay/settings';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { Land } from './land';
import type { Sfx } from './sfx';

export { TAU, angleDiff, clamp, direction, headingToYaw, signedAngle, yawToHeading } from '../crossplay/math';
export type { Vec3 } from '../crossplay/math';

export type SurvivorEntity = NetEntity<StateOf<typeof Survivor>>;
export type AnimalEntity = NetEntity<StateOf<typeof Animal>>;
export type PlotEntity = NetEntity<StateOf<typeof Plot>>;
export type StumpEntity = NetEntity<StateOf<typeof Stump>>;
export type CampfireEntity = NetEntity<StateOf<typeof Campfire>>;
export type ItemEntity = NetEntity<StateOf<typeof Item>>;

/** Shared services for Peer Wilds' systems. No device in here (see crossplay/role.ts). */
export interface WildsContext {
  world: NetWorld;
  land: Land;
  sfx: Sfx;
  /** Announcements and status, shown by each platform its own way. */
  hud: Hud;
  /** The in-game settings menu's contents. Frontends read `open` to know the player is busy with it. */
  settings: Settings;
  fx: Effects;
  /** Arrows in flight. */
  arrows: Arrows;
  /** The local player's survivor. */
  me: SurvivorEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
  /** Wall-clock seconds of the current frame (see clock.ts), for replicated timestamps. */
  wall: number;
  /** Time of day, 0..1 from midnight. Normally the wall clock's, but `?hour=` can shift it on one peer. */
  day: number;
}
