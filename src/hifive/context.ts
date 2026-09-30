import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { Settings } from '../crossplay/settings';
import type { Buddy, Pal, Team } from './defs';
import type { Effects } from './effects';
import type { Grounds } from './field';
import type { Hud } from './hud';
import type { Pairs } from './moves';
import type { Sfx } from './sfx';

export { clamp, direction, type Vec3 } from '../crossplay/math';

export type PalEntity = NetEntity<StateOf<typeof Pal>>;
export type BuddyEntity = NetEntity<StateOf<typeof Buddy>>;
export type TeamEntity = NetEntity<StateOf<typeof Team>>;

/** Shared services for High Five with Friends' systems. No device in here (see crossplay/role.ts). */
export interface HiContext {
  world: NetWorld;
  grounds: Grounds;
  /** Every pair's combo, as far as this peer has heard. */
  pairs: Pairs;
  sfx: Sfx;
  hud: Hud;
  settings: Settings;
  fx: Effects;
  /** The local player's pal. */
  me: PalEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}
