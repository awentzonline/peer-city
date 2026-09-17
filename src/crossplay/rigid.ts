import RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import type { Vec3 } from './math';

/**
 * What a game with rigid bodies needs whatever its bodies are: Rapier (WASM) loaded, rotations as quaternions in
 * world axes (z up) and in the scene, sending a rotation so it interpolates, collision groups and fixed steps.
 *
 * The pattern both Peer Derby and Peer Golf use: every peer runs its own physics world over the same seeded
 * ground, and simulates only what it owns as dynamic bodies. Everyone else's bodies are kinematic stand-ins that
 * follow where their owners say they are, so bodies bump into each other plausibly without anyone being in charge
 * of the collision.
 */

export { RAPIER };

/** Load the WASM. Must finish before a Rapier world is made. */
export function initPhysics(): Promise<void> {
  return RAPIER.init();
}

export const GRAVITY = 9.81;

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface BodyPose {
  x: number;
  y: number;
  z: number;
  q: Quat;
}

/** A rotation as replicated: four fixed-point fields, which may drift off unit length. */
export interface QuatFields {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export function rotate(q: Quat, v: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  // v' = v + 2w(q × v) + 2q × (q × v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  out.x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

/** `v` turned by the inverse of `q`: a world vector in a body's own axes. */
export function unrotate(q: Quat, v: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v, out);
}

export function yawQuat(heading: number): Quat {
  return { x: 0, y: 0, z: Math.sin(heading / 2), w: Math.cos(heading / 2) };
}

const tmp: Vec3 = { x: 0, y: 0, z: 0 };

/** The heading a body's +X points, flattened onto the ground. */
export function headingOf(q: Quat): number {
  const f = rotate(q, { x: 1, y: 0, z: 0 }, tmp);
  return Math.atan2(f.y, f.x);
}

/** How upright a body is: 1 upright, 0 on its side, -1 upside down. */
export function uprightness(q: Quat): number {
  return rotate(q, { x: 0, y: 0, z: 1 }, tmp).z;
}

/** A rotation from its replicated fields, normalized. */
export function quatOf(s: QuatFields, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  const len = Math.hypot(s.qx, s.qy, s.qz, s.qw) || 1;
  out.x = s.qx / len;
  out.y = s.qy / len;
  out.z = s.qz / len;
  out.w = s.qw / len;
  return out;
}

/** Write a rotation into replicated fields, keeping its sign steady so interpolating between samples never goes the long way round. */
export function writeQuat(s: QuatFields, q: Quat): void {
  const flip = q.x * s.qx + q.y * s.qy + q.z * s.qz + q.w * s.qw < 0 ? -1 : 1;
  s.qx = q.x * flip;
  s.qy = q.y * flip;
  s.qz = q.z * flip;
  s.qw = q.w * flip;
}

/**
 * A world rotation in the scene. The scene's axes are world (x, z, y), which is a mirror, not a rotation, so a
 * world quaternion becomes (-x, -z, -y, w).
 */
export function sceneQuat(q: Quat, out: THREE.Quaternion): THREE.Quaternion {
  return out.set(-q.x, -q.z, -q.y, q.w);
}

/** Rapier collision groups: what a collider is (`member` bits) and what it collides with (`filter` bits). */
export function collisionGroups(member: number, filter: number): number {
  return (member << 16) | filter;
}

/** Runs a simulation in fixed steps from uneven frames. Long gaps (a background tab) are cut short rather than caught up. */
export class FixedStep {
  private left = 0;
  /** Seconds simulated. */
  time = 0;

  constructor(
    readonly step = 1 / 60,
    private readonly maxSteps = 8,
  ) {}

  run(dt: number, each: (step: number) => void): void {
    this.left = Math.min(this.left + dt, this.step * this.maxSteps);
    while (this.left >= this.step) {
      this.left -= this.step;
      each(this.step);
      this.time += this.step;
    }
  }
}
