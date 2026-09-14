import type Phaser from 'phaser';
import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { City } from './city';
import type { Car, Ped, Pickup, Player } from './defs';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { Sfx } from './sfx';

export type PlayerEntity = NetEntity<StateOf<typeof Player>>;
export type CarEntity = NetEntity<StateOf<typeof Car>>;
export type PedEntity = NetEntity<StateOf<typeof Ped>>;
export type PickupEntity = NetEntity<StateOf<typeof Pickup>>;

/** Shared services every game system gets. */
export interface GameContext {
  world: NetWorld;
  city: City;
  sfx: Sfx;
  hud: Hud;
  fx: Effects;
  scene: Phaser.Scene;
  /** The local player's avatar. */
  me: PlayerEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}

export const TAU = Math.PI * 2;

export function angleDiff(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
