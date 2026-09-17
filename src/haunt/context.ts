import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { Settings } from '../crossplay/settings';
import type { Haunt, Key, Monster, Round, Survivor } from './defs';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { Manor, Paths } from './manor';
import type { Sfx } from './sfx';

export { TAU, angleDiff, clamp, direction } from '../crossplay/math';
export type { Vec3 } from '../crossplay/math';

export type SurvivorEntity = NetEntity<StateOf<typeof Survivor>>;
export type MonsterEntity = NetEntity<StateOf<typeof Monster>>;
export type HauntEntity = NetEntity<StateOf<typeof Haunt>>;
export type KeyEntity = NetEntity<StateOf<typeof Key>>;
export type RoundEntity = NetEntity<StateOf<typeof Round>>;

/** Shared services for Peer Haunt's systems. No device in here (see crossplay/role.ts). */
export interface HauntContext {
  world: NetWorld;
  manor: Manor;
  paths: Paths;
  sfx: Sfx;
  hud: Hud;
  settings: Settings;
  fx: Effects;
  /** The local player's survivor, if they're playing one. */
  me: SurvivorEntity | null;
  /** The local player's haunt, if they're playing the Haunt. */
  haunt: HauntEntity | null;
  /** The night, if this peer knows of it yet. */
  round(): RoundEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}
