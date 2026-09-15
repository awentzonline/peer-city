import type * as THREE from 'three';
import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { City } from './city';
import type { Car, Ped, Pickup, Player } from './defs';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { Rig } from './rig';
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
  scene: THREE.Scene;
  /** Camera, headset and controllers. */
  rig: Rig;
  /** The local player's avatar. */
  me: PlayerEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}

/** A point or direction in world axes: x, y on the ground, z up. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
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

/** three.js yaw (rotation.y of something looking down -Z) for a ground heading, and back. */
export function headingToYaw(heading: number): number {
  return -heading - Math.PI / 2;
}

export function yawToHeading(yaw: number): number {
  return -yaw - Math.PI / 2;
}

/** Replicated angles arrive in [0, 2π); pitch wants [-π, π). */
export function signedAngle(a: number): number {
  return a >= Math.PI ? a - TAU : a;
}

/** Unit direction for a heading and pitch. */
export function direction(heading: number, pitch: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const c = Math.cos(pitch);
  out.x = Math.cos(heading) * c;
  out.y = Math.sin(heading) * c;
  out.z = Math.sin(pitch);
  return out;
}
