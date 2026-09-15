/** A point or direction in world axes: x, y on the ground, z up. (three.js renders x → X, z → Y, y → Z.) */
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
