import type { NetWorld } from '@engine/index';
import type { Settings } from '../crossplay/settings';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { Sfx } from './sfx';
import type { PainterEntity, WallSync } from './sync';
import type { Surface } from './wall';

export { clamp, direction, type Vec3 } from '../crossplay/math';
export type { PainterEntity } from './sync';

/** Shared services for Peer Walls' systems. No device in here (see crossplay/role.ts). */
export interface WallsContext {
  world: NetWorld;
  /** This peer's copy of the walls. */
  surfaces: readonly Surface[];
  sync: WallSync;
  sfx: Sfx;
  hud: Hud;
  settings: Settings;
  fx: Effects;
  /** The local player's painter. */
  me: PainterEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}
