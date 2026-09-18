import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { Settings } from '../crossplay/settings';
import type { FatChunk, Goblin, Lord, Loot, Sewer } from './defs';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { Plug } from './plug';
import type { Paths, SewerMap } from './sewer';
import type { Sfx } from './sfx';

export { TAU, angleDiff, clamp, direction } from '../crossplay/math';
export type { Vec3 } from '../crossplay/math';

export type LordEntity = NetEntity<StateOf<typeof Lord>>;
export type GoblinEntity = NetEntity<StateOf<typeof Goblin>>;
export type LootEntity = NetEntity<StateOf<typeof Loot>>;
export type ChunkEntity = NetEntity<StateOf<typeof FatChunk>>;
export type SewerEntity = NetEntity<StateOf<typeof Sewer>>;

/** Shared services for Sewer Lordz's systems. No device in here (see crossplay/role.ts). */
export interface SewerContext {
  world: NetWorld;
  map: SewerMap;
  paths: Paths;
  /** The fatberg, as this peer knows it. */
  plug: Plug;
  sfx: Sfx;
  hud: Hud;
  settings: Settings;
  fx: Effects;
  /** The local player's Lord. */
  me: LordEntity | null;
  /** The dive and the water, if this peer knows of them yet. */
  sewer(): SewerEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}

/** The sewage's surface right now: the dive's, or where it starts. */
export function waterLevel(ctx: SewerContext): number {
  return ctx.sewer()?.render.water ?? WATER_START;
}

/** Where the sewage stands at the start of a dive, m: over the channel floor, just under the walkways. */
export const WATER_START = 0.35;
