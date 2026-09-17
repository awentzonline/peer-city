import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { Settings } from '../crossplay/settings';
import type { Castle, Paths } from './castle';
import type { Beacon, Blade, Captain, Guard, Round, Shinobi } from './defs';
import type { Effects } from './effects';
import type { Flights } from './flights';
import type { Hud } from './hud';
import type { Sfx } from './sfx';

export { TAU, angleDiff, clamp, direction } from '../crossplay/math';
export type { Vec3 } from '../crossplay/math';

export type ShinobiEntity = NetEntity<StateOf<typeof Shinobi>>;
export type GuardEntity = NetEntity<StateOf<typeof Guard>>;
export type CaptainEntity = NetEntity<StateOf<typeof Captain>>;
export type BladeEntity = NetEntity<StateOf<typeof Blade>>;
export type BeaconEntity = NetEntity<StateOf<typeof Beacon>>;
export type RoundEntity = NetEntity<StateOf<typeof Round>>;

/** Shared services for Peer Shinobi's systems. No device in here (see crossplay/role.ts). */
export interface ShinobiContext {
  world: NetWorld;
  castle: Castle;
  paths: Paths;
  sfx: Sfx;
  hud: Hud;
  settings: Settings;
  fx: Effects;
  flights: Flights;
  /** The local player's shinobi, if they're playing one. */
  me: ShinobiEntity | null;
  /** The local player's captain, if they're playing the Captain of the Watch. */
  captain: CaptainEntity | null;
  /** The night, if this peer knows of it yet. */
  round(): RoundEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}
