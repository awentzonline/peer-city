import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { Settings } from '../crossplay/settings';
import type { Course } from './course';
import type { Builder, Race, Racer } from './defs';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { Physics } from './physics';
import type { DesignShelf } from './shelf';
import type { Sfx } from './sfx';

export { TAU, angleDiff, clamp, direction, headingToYaw, signedAngle, yawToHeading } from '../crossplay/math';
export type { Vec3 } from '../crossplay/math';

export type BuilderEntity = NetEntity<StateOf<typeof Builder>>;
export type RacerEntity = NetEntity<StateOf<typeof Racer>>;
export type RaceEntity = NetEntity<StateOf<typeof Race>>;

/** Shared services for Peer Derby's systems. No device in here (see crossplay/role.ts). */
export interface DerbyContext {
  world: NetWorld;
  course: Course;
  physics: Physics;
  sfx: Sfx;
  hud: Hud;
  settings: Settings;
  /** This player's saved designs, kept between visits. */
  shelf: DesignShelf;
  fx: Effects;
  /** The local player's builder, and their racer. */
  me: BuilderEntity | null;
  racer: RacerEntity | null;
  /** The race, if this peer knows of it yet. */
  race(): RaceEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}
