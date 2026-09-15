import type * as THREE from 'three';
import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { City } from './city';
import type { Car, Ped, Pickup, Player } from './defs';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { Sfx } from './sfx';

export { TAU, angleDiff, clamp, direction, headingToYaw, signedAngle, yawToHeading } from '../crossplay/math';
export type { Vec3 } from '../crossplay/math';

export type PlayerEntity = NetEntity<StateOf<typeof Player>>;
export type CarEntity = NetEntity<StateOf<typeof Car>>;
export type PedEntity = NetEntity<StateOf<typeof Ped>>;
export type PickupEntity = NetEntity<StateOf<typeof Pickup>>;

/**
 * Shared services every game system gets. There's no device in here: rules reach the player's platform
 * only through their role's frontend (see crossplay/role.ts).
 */
export interface GameContext {
  world: NetWorld;
  city: City;
  sfx: Sfx;
  /** Announcements and status. Each platform's HUD shows them its own way. */
  hud: Hud;
  fx: Effects;
  scene: THREE.Scene;
  /** The local player's avatar. */
  me: PlayerEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}
